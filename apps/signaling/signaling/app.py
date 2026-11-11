"""
HTTP API for pairing the game with a phone and passing their WebRTC signalling.

The game and the phone page reach it through the Vite server's `/signal` proxy, so it
shares their origin and HTTPS certificate. Each side joins a room, long-polls
`GET /signal/poll` for its messages and posts its own with `POST /signal/send`. Once the
data channel is up nothing else goes through here.
"""

import asyncio
import contextlib
from collections.abc import AsyncIterator, Callable

from fastapi import FastAPI, HTTPException, Query, Response

from .network import lan_addresses
from .protocol import (
    HostJoinRequest,
    HostJoinResponse,
    LeaveRequest,
    PadJoinRequest,
    PadJoinResponse,
    PollResponse,
    SendRequest,
    is_room_code,
)
from .store import MemoryRoomStore, RoomStore

# Long enough to keep requests rare, short enough for proxies not to give up on them.
POLL_TIMEOUT_S = 20.0
SWEEP_INTERVAL_S = 2.0


def create_app(
    store: RoomStore | None = None,
    poll_timeout: float = POLL_TIMEOUT_S,
    addresses: Callable[[], list[str]] = lan_addresses,
) -> FastAPI:
    rooms = store or MemoryRoomStore()

    @contextlib.asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        async def sweep_forever() -> None:
            while True:
                await asyncio.sleep(SWEEP_INTERVAL_S)
                await rooms.sweep()

        sweeper = asyncio.create_task(sweep_forever())
        try:
            yield
        finally:
            sweeper.cancel()

    app = FastAPI(title="Drivee signalling", lifespan=lifespan)
    app.state.rooms = rooms

    @app.post("/signal/host")
    async def join_host(body: HostJoinRequest) -> HostJoinResponse:
        joined = await rooms.join_host(body.room)
        return HostJoinResponse(code=joined.code, peer=joined.peer, lanAddresses=addresses())

    @app.post("/signal/pad")
    async def join_pad(body: PadJoinRequest) -> PadJoinResponse:
        code = body.room.upper()
        if not is_room_code(code):
            raise HTTPException(422, "bad room code")
        return PadJoinResponse(peer=await rooms.join_pad(code))

    @app.get("/signal/poll")
    async def poll(peer: str = Query(max_length=64)) -> PollResponse:
        messages = await rooms.receive(peer, poll_timeout)
        if messages is None:
            # Unknown or expired (or the server restarted): the client joins again.
            raise HTTPException(404, "unknown peer")
        return PollResponse(messages=messages)

    @app.post("/signal/send", status_code=204)
    async def send(body: SendRequest) -> Response:
        if not await rooms.forward(body.peer, body.message.model_dump(mode="json", exclude_unset=True)):
            raise HTTPException(404, "unknown peer")
        return Response(status_code=204)

    @app.post("/signal/leave", status_code=204)
    async def leave(body: LeaveRequest) -> Response:
        await rooms.leave(body.peer)
        return Response(status_code=204)

    return app


app = create_app()
