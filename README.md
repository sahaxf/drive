# Drivee

Browser racing game on the Nürburgring Nordschleife, steered by tilting an Android phone.
TypeScript + Three.js + Rapier. Full spec: [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).

## Run

```sh
npm install
npm run dev        # http://localhost:5173
npm test           # unit + headless physics tests
npm run typecheck
npm run build
```

## Controls (keyboard)

| Key | Action |
|---|---|
| W / ↑ | Throttle |
| S / ↓ | Brake (hold at a standstill to reverse) |
| A D / ← → | Steer |
| Space | Handbrake |
| C | Camera (chase / hood) |
| R | Reset car upright |
| T / B | Toggle traction control / ABS |
| P / Esc | Pause (then G shadows, V engine sound, Q menu) |

A standard gamepad also works (RT/LT pedals, left stick steers, A handbrake).

## Layout

```
apps/game/          the game (Vite app)
  src/core/         fixed-timestep loop
  src/vehicle/      raycast vehicle, tyre model, drivetrain
  src/physics/      Rapier world setup
  src/input/        keyboard, gamepad, merged InputSystem
  src/render/       renderer, sky, car and ground visuals
  src/camera/       chase and hood cameras
  src/track/        track generation from track.json (no rendering): spline, road,
                    terrain, far landscape, forest placement, physics colliders
  src/render/track/ track visuals: road furniture, terrain, mountains, forest
packages/shared/    types shared with controller/server: InputState, car.json + track.json schemas
public/cars/        car packages (car.json + model)
public/tracks/      track packages (track.json)
```

Cars and tracks are data: tune `public/cars/<id>/car.json` or `public/tracks/<id>/track.json` and reload.
The whole world (road, kerbs, barriers, terrain, forest, mountains) is generated from the
track's centreline control points and a few seeds.
