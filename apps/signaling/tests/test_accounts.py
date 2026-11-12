from fastapi.testclient import TestClient

from signaling.app import create_app
from signaling.users import MAX_LAPS_PER_TRACK, UserStore


def client() -> TestClient:
    return TestClient(create_app(poll_timeout=0.05, addresses=lambda: []))


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_sign_up_log_in_and_out() -> None:
    with client() as c:
        created = c.post("/api/users", json={"username": "Racer", "password": "hunter22"})
        assert created.status_code == 201
        body = created.json()
        assert body["user"]["username"] == "Racer"
        assert body["user"]["laps"] == {} and body["user"]["best"] == {}
        assert c.get("/api/me", headers=auth(body["token"])).json()["username"] == "Racer"

        # Names are case-insensitive: no second "racer".
        assert c.post("/api/users", json={"username": "racer", "password": "whatever1"}).status_code == 409

        assert c.post("/api/login", json={"username": "racer", "password": "wrong-one"}).status_code == 401
        assert c.post("/api/login", json={"username": "nobody", "password": "hunter22"}).status_code == 401
        login = c.post("/api/login", json={"username": "racer", "password": "hunter22"})
        assert login.status_code == 200
        token = login.json()["token"]
        assert token != body["token"]

        assert c.post("/api/logout", headers=auth(token)).status_code == 204
        assert c.get("/api/me", headers=auth(token)).status_code == 401
        # The other session is still good.
        assert c.get("/api/me", headers=auth(body["token"])).status_code == 200


def test_rejects_bad_sign_ups_and_missing_tokens() -> None:
    with client() as c:
        for username, password in (("ab", "hunter22"), ("has space", "hunter22"), ("fine", "short")):
            assert c.post("/api/users", json={"username": username, "password": password}).status_code == 422
        assert c.get("/api/me").status_code == 401
        assert c.get("/api/me", headers=auth("made-up")).status_code == 401
        assert c.post("/api/me/laps", json={"track": "spa-replica", "car": "formula", "time": 90}).status_code == 401


def test_records_laps_and_personal_bests() -> None:
    with client() as c:
        token = c.post("/api/users", json={"username": "speedy", "password": "hunter22"}).json()["token"]

        def lap(time: float, track: str = "spa-replica") -> dict:
            response = c.post("/api/me/laps", headers=auth(token), json={"track": track, "car": "strada-gt", "time": time})
            assert response.status_code == 201
            return response.json()

        assert lap(95.5)["best"] is True
        assert lap(97.25)["best"] is False
        result = lap(93.0)
        assert result["best"] is True
        assert [l["time"] for l in result["user"]["laps"]["spa-replica"]] == [95.5, 97.25, 93.0]
        assert result["user"]["best"]["spa-replica"]["time"] == 93.0

        lap(400, track="nordschleife")
        me = c.get("/api/me", headers=auth(token)).json()
        assert {t: b["time"] for t, b in me["best"].items()} == {"spa-replica": 93.0, "nordschleife": 400}

        for bad in ({"track": "spa-replica", "car": "strada-gt", "time": 0}, {"track": "../x", "car": "strada-gt", "time": 90}):
            assert c.post("/api/me/laps", headers=auth(token), json=bad).status_code == 422


def test_keeps_recent_laps_but_never_loses_the_best() -> None:
    users = UserStore()
    user, _ = users.create("racer", "hunter22")
    users.record_lap(user, "t", "c", 50.0)
    for i in range(MAX_LAPS_PER_TRACK + 5):
        users.record_lap(user, "t", "c", 60.0 + i)
    assert len(user.laps["t"]) == MAX_LAPS_PER_TRACK
    assert 50.0 not in [lap.time for lap in user.laps["t"]]
    assert user.best["t"].time == 50.0
