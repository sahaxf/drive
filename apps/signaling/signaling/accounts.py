"""
HTTP API for player accounts and lap times, under `/api` (proxied by Vite like `/signal`).

Wire format shared with the browser side (packages/shared/src/account.ts); keep the two
in sync.
"""

import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Response
from pydantic import BaseModel, Field

from .users import LapRecord, User, UsernameTaken, UserStore

API_PATH = "/api"

Username = Annotated[str, Field(min_length=3, max_length=20, pattern=r"^[A-Za-z0-9_-]+$")]
Password = Annotated[str, Field(min_length=6, max_length=128)]
ItemId = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[a-z0-9-]+$")]


class Credentials(BaseModel):
    username: Username
    password: Password


class LoginRequest(BaseModel):
    # Not validated against the sign-up rules: a wrong name is just a failed login.
    username: str = Field(max_length=64)
    password: str = Field(max_length=128)


class Lap(BaseModel):
    time: float
    car: str
    at: float


class UserView(BaseModel):
    username: str
    createdAt: float
    # Track id -> recent laps, oldest first.
    laps: dict[str, list[Lap]]
    # Track id -> best lap on that track.
    best: dict[str, Lap]


class SessionResponse(BaseModel):
    token: str
    user: UserView


class LapRequest(BaseModel):
    track: ItemId
    car: ItemId
    # Seconds; anything outside this range isn't a lap of a real track.
    time: float = Field(gt=1, lt=3600)


class LapResponse(BaseModel):
    lap: Lap
    best: bool
    user: UserView


def _lap(lap: LapRecord) -> Lap:
    return Lap(time=lap.time, car=lap.car, at=lap.at)


def user_view(user: User) -> UserView:
    return UserView(
        username=user.username,
        createdAt=user.created_at,
        laps={track: [_lap(lap) for lap in laps] for track, laps in user.laps.items()},
        best={track: _lap(lap) for track, lap in user.best.items()},
    )


def create_router(users: UserStore) -> APIRouter:
    router = APIRouter(prefix=API_PATH)

    def bearer_token(authorization: str = Header(default="")) -> str:
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() != "bearer" or not token:
            raise HTTPException(401, "not logged in")
        return token

    def current_user(token: str = Depends(bearer_token)) -> User:
        user = users.by_token(token)
        if user is None:
            raise HTTPException(401, "not logged in")
        return user

    @router.post("/users", status_code=201)
    async def sign_up(body: Credentials) -> SessionResponse:
        try:
            # scrypt is deliberately slow: keep it off the event loop serving the long-polls.
            user, token = await asyncio.to_thread(users.create, body.username, body.password)
        except UsernameTaken:
            raise HTTPException(409, "that username is taken") from None
        return SessionResponse(token=token, user=user_view(user))

    @router.post("/login")
    async def log_in(body: LoginRequest) -> SessionResponse:
        result = await asyncio.to_thread(users.login, body.username, body.password)
        if result is None:
            raise HTTPException(401, "wrong username or password")
        user, token = result
        return SessionResponse(token=token, user=user_view(user))

    @router.post("/logout", status_code=204)
    async def log_out(token: str = Depends(bearer_token)) -> Response:
        users.logout(token)
        return Response(status_code=204)

    @router.get("/me")
    async def me(user: User = Depends(current_user)) -> UserView:
        return user_view(user)

    @router.post("/me/laps", status_code=201)
    async def record_lap(body: LapRequest, user: User = Depends(current_user)) -> LapResponse:
        lap, best = users.record_lap(user, body.track, body.car, body.time)
        return LapResponse(lap=_lap(lap), best=best, user=user_view(user))

    return router
