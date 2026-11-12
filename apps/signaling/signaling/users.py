"""
Player accounts and their lap times, kept in dictionaries in this process.

Everything is lost when the server restarts; the pages then send the player back to the
login screen. Passwords are stored as salted scrypt hashes, never as given. A login hands
out a random session token, which the pages send as `Authorization: Bearer <token>`.
"""

import hashlib
import hmac
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass, field

# Laps kept per track for each player; the oldest go first. The best lap is kept apart.
MAX_LAPS_PER_TRACK = 50

_SCRYPT = {"n": 2**14, "r": 8, "p": 1, "dklen": 32}


class UsernameTaken(Exception):
    pass


@dataclass
class LapRecord:
    time: float
    car: str
    at: float


@dataclass
class User:
    username: str
    salt: bytes
    password_hash: bytes
    created_at: float
    # Track id -> recent laps, oldest first.
    laps: dict[str, list[LapRecord]] = field(default_factory=dict)
    # Track id -> best lap ever, which outlives the recent list.
    best: dict[str, LapRecord] = field(default_factory=dict)


def _hash(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(password.encode(), salt=salt, **_SCRYPT)


class UserStore:
    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self._clock = clock
        # Keyed by the lower-cased username, so "Akash" and "akash" are one account.
        self.users: dict[str, User] = {}
        # Session token -> key into `users`.
        self.sessions: dict[str, str] = {}

    def create(self, username: str, password: str) -> tuple[User, str]:
        key = username.lower()
        if key in self.users:
            raise UsernameTaken(username)
        salt = secrets.token_bytes(16)
        user = User(username, salt, _hash(password, salt), self._clock())
        self.users[key] = user
        return user, self._new_session(key)

    def login(self, username: str, password: str) -> tuple[User, str] | None:
        key = username.lower()
        user = self.users.get(key)
        if user is None:
            # Spend the same time as a real check, so timing doesn't reveal which names exist.
            _hash(password, b"\0" * 16)
            return None
        if not hmac.compare_digest(_hash(password, user.salt), user.password_hash):
            return None
        return user, self._new_session(key)

    def logout(self, token: str) -> None:
        self.sessions.pop(token, None)

    def by_token(self, token: str) -> User | None:
        key = self.sessions.get(token)
        return self.users.get(key) if key is not None else None

    def record_lap(self, user: User, track: str, car: str, seconds: float) -> tuple[LapRecord, bool]:
        """Add a lap; True when it's the player's best on that track."""
        lap = LapRecord(seconds, car, self._clock())
        laps = user.laps.setdefault(track, [])
        laps.append(lap)
        del laps[:-MAX_LAPS_PER_TRACK]
        best = user.best.get(track)
        is_best = best is None or seconds < best.time
        if is_best:
            user.best[track] = lap
        return lap, is_best

    def _new_session(self, key: str) -> str:
        token = secrets.token_urlsafe(32)
        self.sessions[token] = key
        return token
