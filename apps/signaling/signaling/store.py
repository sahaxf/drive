"""
Rooms, peers and their message queues.

Each game (host) owns a room with a short code; one phone (pad) at a time can join it.
Every peer gets a secret id when it joins and long-polls for messages addressed to it:
notices from the server and WebRTC signalling from the other side of its room.

`RoomStore` is the interface the HTTP layer uses. `MemoryRoomStore` keeps everything in
dictionaries in this process; a Redis-backed store can replace it (queues as lists with
BLPOP, peer liveness as key TTLs) without touching the endpoints.
"""

import asyncio
import secrets
import time
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass, field

from .protocol import ROOM_ALPHABET, ROOM_CODE_LENGTH, Role, is_room_code

# A peer that hasn't polled for this long (tab closed without saying so, phone asleep) is dropped.
PEER_TTL_S = 10.0
# Messages kept for a peer that isn't collecting them; older ones are dropped first.
MAX_QUEUE = 256


@dataclass(frozen=True)
class HostJoin:
    code: str
    peer: str


class RoomStore(ABC):
    @abstractmethod
    async def join_host(self, wanted: str) -> HostJoin:
        """Open a room for a game, reusing `wanted` when it is free or only has a phone waiting."""

    @abstractmethod
    async def join_pad(self, code: str) -> str:
        """Put a phone in a room (creating it if the game isn't there yet). Returns its peer id."""

    @abstractmethod
    async def forward(self, peer: str, message: dict) -> bool:
        """Queue a message for the other side of `peer`'s room. False if `peer` is unknown."""

    @abstractmethod
    async def receive(self, peer: str, timeout: float) -> list[dict] | None:
        """Wait up to `timeout` s for messages to `peer`. None if `peer` is unknown."""

    @abstractmethod
    async def leave(self, peer: str) -> None:
        """Drop a peer now (its page is going away)."""

    @abstractmethod
    async def sweep(self) -> None:
        """Drop peers that stopped polling."""


@dataclass
class _Peer:
    id: str
    role: Role
    # None once detached from its room (replaced by a newer phone): it may still collect
    # the "replaced" notice, then it's gone.
    room: str | None
    last_seen: float
    queue: list[dict] = field(default_factory=list)
    wakeup: asyncio.Event = field(default_factory=asyncio.Event)
    polling: int = 0


@dataclass
class _Room:
    code: str
    host: str | None = None
    pad: str | None = None


class MemoryRoomStore(RoomStore):
    def __init__(self, clock: Callable[[], float] = time.monotonic, peer_ttl: float = PEER_TTL_S) -> None:
        self._clock = clock
        self._peer_ttl = peer_ttl
        self._rooms: dict[str, _Room] = {}
        self._peers: dict[str, _Peer] = {}

    @property
    def room_count(self) -> int:
        return len(self._rooms)

    async def join_host(self, wanted: str) -> HostJoin:
        code = wanted.upper()
        room = self._rooms.get(code) if is_room_code(code) else None
        # A second game tab gets its own room instead of stealing a live one.
        if room is not None and room.host is not None:
            room = None
        if room is None:
            code = code if is_room_code(code) and code not in self._rooms else self._fresh_code()
            room = _Room(code)
            self._rooms[code] = room
        peer = self._new_peer("host", room.code)
        room.host = peer.id
        if room.pad is not None:
            self._push(peer.id, {"t": "peer", "connected": True})
            self._push(room.pad, {"t": "peer", "connected": True})
        return HostJoin(room.code, peer.id)

    async def join_pad(self, code: str) -> str:
        room = self._rooms.get(code)
        if room is None:
            # The phone may arrive before its game (e.g. the game tab is reloading): it waits.
            room = _Room(code)
            self._rooms[code] = room
        if room.pad is not None:
            old = room.pad
            self._push(old, {"t": "replaced"})
            self._detach(old)
        peer = self._new_peer("pad", code)
        room.pad = peer.id
        self._push(peer.id, {"t": "peer", "connected": room.host is not None})
        if room.host is not None:
            self._push(room.host, {"t": "peer", "connected": True})
        return peer.id

    async def forward(self, peer: str, message: dict) -> bool:
        p = self._peers.get(peer)
        if p is None:
            return False
        p.last_seen = self._clock()
        room = self._rooms.get(p.room) if p.room else None
        if room is not None:
            other = room.pad if p.role == "host" else room.host
            if other is not None:
                self._push(other, message)
        return True

    async def receive(self, peer: str, timeout: float) -> list[dict] | None:
        p = self._peers.get(peer)
        if p is None:
            return None
        p.last_seen = self._clock()
        if not p.queue:
            p.polling += 1
            try:
                await asyncio.wait_for(p.wakeup.wait(), timeout)
            except TimeoutError:
                pass
            finally:
                p.polling -= 1
                p.last_seen = self._clock()
        messages, p.queue = p.queue, []
        p.wakeup.clear()
        if p.id not in self._peers and not messages:
            return None
        if p.room is None and p.id in self._peers and messages:
            # A replaced phone has now been told; it has no further use for its id.
            del self._peers[p.id]
        return messages

    async def leave(self, peer: str) -> None:
        self._remove(peer)

    async def sweep(self) -> None:
        now = self._clock()
        stale = [p.id for p in self._peers.values() if p.polling == 0 and now - p.last_seen > self._peer_ttl]
        for peer in stale:
            self._remove(peer)

    def _new_peer(self, role: Role, code: str) -> _Peer:
        peer = _Peer(id=secrets.token_urlsafe(18), role=role, room=code, last_seen=self._clock())
        self._peers[peer.id] = peer
        return peer

    def _push(self, peer: str, message: dict) -> None:
        p = self._peers.get(peer)
        if p is None:
            return
        if len(p.queue) >= MAX_QUEUE:
            del p.queue[0]
        p.queue.append(message)
        p.wakeup.set()

    def _detach(self, peer: str) -> None:
        """Take a peer out of its room, telling the other side it went away."""
        p = self._peers.get(peer)
        if p is None or p.room is None:
            return
        room = self._rooms.get(p.room)
        p.room = None
        if room is None:
            return
        if room.host == peer:
            room.host = None
            if room.pad is not None:
                self._push(room.pad, {"t": "peer", "connected": False})
        elif room.pad == peer:
            room.pad = None
            if room.host is not None:
                self._push(room.host, {"t": "peer", "connected": False})
        if room.host is None and room.pad is None:
            del self._rooms[room.code]

    def _remove(self, peer: str) -> None:
        self._detach(peer)
        p = self._peers.pop(peer, None)
        if p is not None:
            # End a poll that's still waiting, so it doesn't hold the request open.
            p.wakeup.set()

    def _fresh_code(self) -> str:
        while True:
            code = "".join(secrets.choice(ROOM_ALPHABET) for _ in range(ROOM_CODE_LENGTH))
            if code not in self._rooms:
                return code
