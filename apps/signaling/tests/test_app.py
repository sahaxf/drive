from fastapi.testclient import TestClient

from signaling.app import create_app
from signaling.network import score_address


def client() -> TestClient:
    return TestClient(create_app(poll_timeout=0.05, addresses=lambda: ["192.168.1.5"]))


def test_pairs_and_passes_signalling_over_http() -> None:
    with client() as c:
        host = c.post("/signal/host", json={}).json()
        assert host["lanAddresses"] == ["192.168.1.5"]
        assert len(host["code"]) == 4

        pad = c.post("/signal/pad", json={"room": host["code"].lower()}).json()
        assert c.get("/signal/poll", params={"peer": pad["peer"]}).json() == {
            "messages": [{"t": "peer", "connected": True}]
        }
        assert c.get("/signal/poll", params={"peer": host["peer"]}).json()["messages"] == [
            {"t": "peer", "connected": True}
        ]

        candidate = {"candidate": "candidate:1 1 udp 1 192.168.1.9 5000 typ host", "sdpMid": "0", "sdpMLineIndex": 0}
        for message in ({"t": "rtc-offer", "sdp": "v=0"}, {"t": "rtc-ice", "candidate": candidate}):
            assert c.post("/signal/send", json={"peer": pad["peer"], "message": message}).status_code == 204
        assert c.get("/signal/poll", params={"peer": host["peer"]}).json()["messages"] == [
            {"t": "rtc-offer", "sdp": "v=0"},
            {"t": "rtc-ice", "candidate": candidate},
        ]

        # Nothing came for the phone: the poll times out empty.
        assert c.get("/signal/poll", params={"peer": pad["peer"]}).json() == {"messages": []}


def test_only_webrtc_signalling_is_accepted() -> None:
    with client() as c:
        host = c.post("/signal/host", json={}).json()
        for message in ({"t": "ping", "id": 1}, {"t": "buzz", "pattern": [30]}, {"t": "rtc-offer"}):
            assert c.post("/signal/send", json={"peer": host["peer"], "message": message}).status_code == 422


def test_unknown_peers_and_bad_rooms_are_refused() -> None:
    with client() as c:
        assert c.get("/signal/poll", params={"peer": "nobody"}).status_code == 404
        assert (
            c.post("/signal/send", json={"peer": "nobody", "message": {"t": "rtc-offer", "sdp": "x"}}).status_code
            == 404
        )
        assert c.post("/signal/pad", json={"room": "NOPE0"}).status_code == 422


def test_leave_tells_the_other_side() -> None:
    with client() as c:
        host = c.post("/signal/host", json={}).json()
        pad = c.post("/signal/pad", json={"room": host["code"]}).json()
        c.get("/signal/poll", params={"peer": pad["peer"]})
        assert c.post("/signal/leave", json={"peer": host["peer"]}).status_code == 204
        assert c.get("/signal/poll", params={"peer": pad["peer"]}).json()["messages"] == [
            {"t": "peer", "connected": False}
        ]
        assert c.get("/signal/poll", params={"peer": host["peer"]}).status_code == 404


def test_real_adapters_rank_above_virtual_ones() -> None:
    assert score_address("Wi-Fi", "192.168.1.5") > score_address("vEthernet (WSL)", "172.20.0.1")
    assert score_address("Ethernet", "10.0.0.4") > score_address("Wi-Fi", "169.254.3.3")
