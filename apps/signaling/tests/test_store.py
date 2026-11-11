import asyncio

from signaling.store import MemoryRoomStore


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


async def drain(store: MemoryRoomStore, peer: str) -> list[dict] | None:
    return await store.receive(peer, 0)


async def test_pairs_a_phone_with_the_game_and_forwards_signalling() -> None:
    store = MemoryRoomStore()
    host = await store.join_host("")
    assert len(host.code) == 4
    pad = await store.join_pad(host.code)
    assert await drain(store, pad) == [{"t": "peer", "connected": True}]
    assert await drain(store, host.peer) == [{"t": "peer", "connected": True}]

    offer = {"t": "rtc-offer", "sdp": "v=0"}
    assert await store.forward(pad, offer)
    assert await drain(store, host.peer) == [offer]
    answer = {"t": "rtc-answer", "sdp": "v=0"}
    assert await store.forward(host.peer, answer)
    assert await drain(store, pad) == [answer]


async def test_a_waiting_poll_wakes_up_when_a_message_arrives() -> None:
    store = MemoryRoomStore()
    host = await store.join_host("")
    pad = await store.join_pad(host.code)
    await drain(store, host.peer)
    waiting = asyncio.create_task(store.receive(host.peer, 5))
    await asyncio.sleep(0)
    await store.forward(pad, {"t": "rtc-offer", "sdp": "x"})
    assert await asyncio.wait_for(waiting, 1) == [{"t": "rtc-offer", "sdp": "x"}]


async def test_a_phone_waits_for_a_reloading_game_which_gets_its_code_back() -> None:
    store = MemoryRoomStore()
    pad = await store.join_pad("K7QX")
    assert await drain(store, pad) == [{"t": "peer", "connected": False}]
    host = await store.join_host("k7qx")
    assert host.code == "K7QX"
    assert await drain(store, pad) == [{"t": "peer", "connected": True}]

    await store.leave(host.peer)
    assert await drain(store, pad) == [{"t": "peer", "connected": False}]
    assert await drain(store, host.peer) is None
    again = await store.join_host("K7QX")
    assert again.code == "K7QX"


async def test_a_second_game_gets_its_own_room() -> None:
    store = MemoryRoomStore()
    first = await store.join_host("")
    second = await store.join_host(first.code)
    assert second.code != first.code


async def test_a_newer_phone_takes_over_and_the_old_one_is_told_once() -> None:
    store = MemoryRoomStore()
    host = await store.join_host("")
    old = await store.join_pad(host.code)
    await drain(store, old)
    new = await store.join_pad(host.code)
    assert await drain(store, old) == [{"t": "replaced"}]
    # Told: its id is gone, and it must not come back by rejoining on its own.
    assert await drain(store, old) is None
    assert await drain(store, new) == [{"t": "peer", "connected": True}]

    await store.forward(new, {"t": "rtc-offer", "sdp": "x"})
    assert (await drain(store, host.peer))[-1] == {"t": "rtc-offer", "sdp": "x"}


async def test_peers_that_stop_polling_are_dropped_and_empty_rooms_cleaned_up() -> None:
    clock = Clock()
    store = MemoryRoomStore(clock=clock, peer_ttl=10)
    host = await store.join_host("")
    pad = await store.join_pad(host.code)
    await drain(store, host.peer)
    clock.now = 5
    await drain(store, pad)

    clock.now = 12
    await store.sweep()
    assert await drain(store, host.peer) is None
    assert await drain(store, pad) == [{"t": "peer", "connected": False}]

    clock.now = 30
    await store.sweep()
    assert store.room_count == 0


async def test_a_peer_in_a_long_poll_is_never_swept() -> None:
    clock = Clock()
    store = MemoryRoomStore(clock=clock, peer_ttl=10)
    host = await store.join_host("")
    waiting = asyncio.create_task(store.receive(host.peer, 5))
    await asyncio.sleep(0)
    clock.now = 60
    await store.sweep()
    assert store.room_count == 1
    waiting.cancel()


async def test_unknown_peers_are_refused() -> None:
    store = MemoryRoomStore()
    assert await store.forward("nobody", {"t": "rtc-offer", "sdp": "x"}) is False
    assert await store.receive("nobody", 0) is None
