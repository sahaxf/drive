# Car Mechanics

How the car drives: the physics model, the assists, the input pipeline (keyboard, gamepad, phone) and every tuning value. Keep this file in step with the code. When you change a value, update its table row and add a line to the [tuning log](#10-tuning-log).

- **Car data:** [`public/cars/strada-gt/car.json`](../public/cars/strada-gt/car.json), validated by [`packages/shared/src/car-schema.ts`](../packages/shared/src/car-schema.ts).
- **Physics code:** [`apps/game/src/vehicle/`](../apps/game/src/vehicle/): `Vehicle.ts` (chassis, suspension, steering, assists, aero), `tyre.ts` (tyre forces), `drivetrain.ts` (engine, clutch, gearbox).
- **Phone steering:** [`packages/shared/src/controller.ts`](../packages/shared/src/controller.ts) and [`apps/game/src/controller/`](../apps/game/src/controller/).

**Units:** metres, kilograms, seconds, newtons, radians. Fields ending in `Deg` are degrees.
**Car-local axes:** +Y up, +Z forward, +X left.
**Input convention:** `steer` −1 = full left, +1 = full right; `throttle` and `brake` 0..1.

---

## 1. Overview: one physics step

The simulation runs at a fixed **120 Hz** (`PHYSICS_DT = 1/120`, `physics/PhysicsWorld.ts`). Rendering interpolates between the last two steps. A frame longer than 0.25 s is clamped (`GameLoop.maxFrameDt`), so a stall never fast-forwards the physics.

`Vehicle.step(input, dt)` runs, in order:

1. **Read pose:** position, rotation, up/forward vectors, centre of mass.
2. **Suspension rays:** one ray per wheel down from its mount, then spring + damper load, then anti-roll bars.
3. **Suspension forces:** each wheel's load pushes the body along the contact normal.
4. **Drivetrain:** pedals → engine rpm, gear, torque at the driven wheels (`drivetrain.ts`).
5. **Steering:** driver steer → wheel angle (speed-sensitive), plus countersteer if the stability assist is on.
6. **Tyres:** per wheel, slip → lateral and longitudinal force (`tyre.ts`), within the friction circle.
7. **Aero:** drag and downforce at the centre of mass.
8. **Flush impulses:** every force above is queued and applied together at the end. Rapier changes velocity immediately on each impulse, so applying them one by one would let later wheels see velocities already altered by earlier ones.
9. **Yaw damping:** the second half of the stability assist, applied as a torque impulse.
10. **Telemetry:** speed, rpm, gear, wheelspin and lock-up for the HUD and haptics.

---

## 2. Chassis

One Rapier rigid body with a box collider. Mass and inertia are set explicitly, not taken from the collider (collider density is 0).

| Field | Value | Effect |
|---|---|---|
| `chassis.mass` | 1350 kg | Everything scales with it: load, inertia, acceleration. |
| `chassis.halfExtents` | [0.92, 0.32, 2.2] | Collision box. Also sets the inertia. |
| `chassis.centerOfMass` | [0, −0.12, −0.1] | Lower = less roll. Further back (−z) = more rear traction, more oversteer. Moving it forward to +0.05 was tried and reverted: it hurt traction (see the log). |
| `chassis.inertiaScale` | [1, 1, 1] | Multiplies box inertia (x pitch, y yaw, z roll). Higher yaw scale = lazier rotation. |

- Inertia is `m/3 × (a² + b²)` per axis from the half-extents, times `inertiaScale`. Yaw inertia is about 2560 kg·m².
- Fixed damping: linear 0.01, angular 0.05. CCD is on. The body never sleeps. Collider friction is 0.3 and restitution 0.1; these only apply when the body itself hits something (barriers).

---

## 3. Suspension

A raycast suspension: each wheel casts a ray from its mount along −up, `restLength + wheelRadius` long.

```
compression = restLength − (hitDistance − wheelRadius)
load = stiffness × compression + damping × compressionVelocity    (clamped ≥ 0)
damping = bumpDamping when compressing, reboundDamping when extending
bump stop: compression beyond restLength adds 6 × stiffness × overshoot
anti-roll: transfer = antiRoll × (compressionLeft − compressionRight), moved from one side to the other
```

| Field | Front | Rear | Effect |
|---|---|---|---|
| `restLength` | 0.3 | 0.3 | Travel. The ride sits about 0.16–0.22 m compressed at rest. |
| `stiffness` (N/m) | 38000 | 36000 | Ride height and pitch/roll stiffness. |
| `bumpDamping` | 3200 | 3000 | Resistance to compressing. |
| `reboundDamping` | 4200 | 4000 | Resistance to extending. Higher = less bounce after bumps. |
| `antiRoll` (N/m) | 14000 | 9000 | Stiffer front than rear = more understeer, more stability. |

Wheel geometry (`wheels.*`):

| Field | Value | Effect |
|---|---|---|
| `radius` / `width` | 0.34 / 0.26 | Rolling radius. Width is visual only. |
| `inertia` | 1.2 kg·m² | How fast wheelspin builds. |
| `frontAxleZ` / `rearAxleZ` | 1.35 / −1.25 | Wheelbase 2.6 m. Also the weight split. |
| `trackFront` / `trackRear` | 1.6 / 1.62 | Wider = less load transfer. |
| `mountY` | 0 | Suspension top mount height. |
| `rollInfluence` | 0.75 | Tyre forces act this fraction of the way down to the contact patch; the rest is at centre-of-mass height. Lower = less body roll and fewer rollovers. |

Ray hits also report which collider is under the wheel, and that sets the **surface grip** multiplier (`SURFACE_GRIP` in `track/generateTrack.ts`):

| Surface | Grip multiplier |
|---|---|
| asphalt | 1.0 |
| kerb | 0.95 (also triggers kerb haptics) |
| verge | 0.65 |
| terrain | 0.55 |

---

## 4. Tyres (`tyre.ts`)

A force-based model per wheel, with no integrated wheel-spin ODE. At 120 Hz that ODE is stiff and blows up at low speed.

**Peak force**

```
loadFactor = clamp(1 − loadSensitivity × (load / nominalLoad − 1), 0.6, 1.3)
maxForce   = grip × loadFactor × surfaceGrip × load
nominalLoad = mass × g / 4
```

**Lateral force:** a Pacejka "magic formula" curve on the slip angle.

```
slipAngle = atan(vLat / max(|vLong|, 1.5))          // the 1.5 m/s floor stops huge angles at a standstill
Fy = −sin(C × atan(B·α − E·(B·α − atan(B·α)))) × maxForce
```

With B = 10, C = 1.9, E = 0.97 the curve peaks at roughly 10° slip and falls off only gently after that, so slides stay controllable.

**Longitudinal force:** comes straight from drive torque and brake torque.

- Drive force = wheel torque × axle share / radius. Brake force = brake torque / radius. Rolling resistance = `rollingResistance × load`.
- If drive + brake fits inside `maxForce`: the tyre delivers it, and lateral force is capped by the **friction circle**, `√(maxForce² − Fx²)`. Accelerating or braking hard costs cornering grip.
- Over the limit, braking with ABS on: Fx = 0.95 × maxForce, and some steering remains.
- Over the limit, braking without ABS, or with the handbrake on the rears: the wheel **locks**. Force = `slidingGrip × maxForce`, opposing the contact-patch velocity.
- Over the limit, accelerating: **wheelspin**. 92% of the sliding force goes forward and little is left for cornering. The excess spins the wheel up.
- Every force is capped at what would stop that wheel's share of the mass in one step. This prevents jitter at low speed.

| Field | Front | Rear | Effect |
|---|---|---|---|
| `grip` | **1.7** | **1.78** | Peak friction coefficient. Sets cornering, braking and traction limits. Arcade level; road cars are about 1.0–1.2. Rear higher than front keeps the car stable. |
| `lateralB` / `lateralC` / `lateralE` | 10 / 1.9 / 0.97 | same | Shape of the lateral curve: stiffness, peak shape, fall-off. |
| `loadSensitivity` | 0.08 | 0.08 | Grip per newton drops as load rises, so weight transfer matters. |
| `slidingGrip` | 0.8 | 0.8 | Grip of a locked or spinning tyre relative to peak. |
| `rollingResistance` | 0.012 | 0.012 | Coast-down drag. |

---

## 5. Steering

**Speed-sensitive lock** (`Vehicle.steerAngle`)

```
t = min(speed / highSpeed, 1)
lock = 1 + (minLockFactor − 1) × t
wheelAngle = −steer × lock × maxAngleDeg
```

Lock shrinks linearly from full at a standstill to `minLockFactor` at `highSpeed`.

| Field | Value | Effect |
|---|---|---|
| `maxAngleDeg` | 32° | Full lock at parking speed (hairpins). |
| `highSpeed` | 45 m/s (162 km/h) | Speed where lock reaches its minimum. |
| `minLockFactor` | **0.3** | Lock left at high speed (9.6°). Too low and the tyres can't reach their limit at speed ("won't turn"). Too high and it's twitchy. |

There is no steering-rack rate limit in the car. The keyboard ramps its own input (section 8). The phone sends filtered tilt.

---

## 6. Assists

All three are toggled from `car.json` `assists.*`, and at runtime through `vehicle.tractionControl`, `vehicle.abs` and `vehicle.stability`. TC and ABS have keys (T, B); stability doesn't yet.

### 6.1 Traction control (TC), on by default (`tyre.ts`)
Drive force is limited to the grip left after cornering, `√(maxForce² − Fy²)`, but never below 25% of `maxForce`, so the car can still pull away. Drive trimmed by TC never spins the wheel.

### 6.2 ABS, on by default (`tyre.ts`)
Instead of locking, the braking force is held at 95% of peak, so some lateral grip remains and you can steer while braking. The handbrake bypasses ABS.

### 6.3 Stability assist (ESC-like), on by default (`Vehicle.ts`)
Added because the car without it held a slide indefinitely: both axles saturated, almost no restoring yaw. It has two parts:

1. **Countersteer.** Front wheel angle += `sideslip × COUNTERSTEER_GAIN`, where sideslip = atan(lateral velocity / forward speed). In a slide this points the wheels where the car is going; with the steering centred, it lets the rear tyres pull the car straight.
2. **Yaw damping.** The yaw rate the driver asked for comes from a bicycle model: `forwardSpeed × tan(driverAngle) / wheelbase`, capped at the grip limit `grip × aeroGain × g / speed`, where `aeroGain = 1 + downforce / weight`. Yaw beyond that target plus a tolerance is removed with a torque impulse, as real ESC does by braking individual wheels. It is off while the handbrake is held, so handbrake turns still work.

Both parts switch off below `STABILITY_MIN_SPEED`.

| Constant (in `Vehicle.ts`) | Value | Effect |
|---|---|---|
| `STABILITY_MIN_SPEED` | 4 m/s | Below this the assist does nothing. |
| `COUNTERSTEER_GAIN` | 0.8 | Share of sideslip added as countersteer. Higher = recovers sooner but feels more "on rails". |
| `YAW_TOLERANCE` | 0.05 rad/s (~3°/s) | Excess yaw left alone, so normal driving isn't touched. |
| `YAW_DAMPING` | 6 /s | How fast excess yaw is removed. |
| `MAX_YAW_CORRECTION` | 3 rad/s² | Cap on the corrective yaw acceleration. |

Headless measurements show the assist helps cornering at every speed, rather than costing steering.

---

## 7. Engine, gearbox, drivetrain (`drivetrain.ts`)

- **Engine:** torque comes from linear interpolation of `torqueCurve` (rpm → N·m) × delivered throttle.
  - **Throttle response:** delivered throttle follows the pedal at up to `1 / throttleResponse` per second going up, and twice that coming off. Torque builds over about a quarter of a second instead of arriving in full on the first frame. This also smooths the keyboard's on/off throttle.
  - The **rev limiter** cuts torque at `redlineRpm` and restores it 250 rpm below.
  - With the throttle closed above idle, **engine braking** = `engineBraking × rpm/redline`.
- **Clutch / launch:** engine rpm = max(wheel rpm, `idle + delivered throttle × (launchRpm − idle)`), so the engine revs to `launchRpm` while the clutch slips at low speed.
- **Automatic gearbox:**
  - Upshifts above `upshiftAt × redline`.
  - Downshifts below `downshiftAt × redline`, but only if the lower gear won't immediately want to shift back up.
  - No torque reaches the wheels during `shiftTime` (downshifts take 60% of it).
- **Reverse:** holding the brake below 0.6 m/s for 0.35 s selects reverse. Holding the throttle selects first again. In reverse the pedals swap roles (brake drives).
- **Wheel torque** = engine torque × gear ratio × final drive × `efficiency`, split equally between the driven wheels. AWD splits by `frontTorqueSplit`.
- **Wheel speed** is clamped to the redline speed of the current gear.
- **Sound** (`audio/EngineSound.ts`): synthesized with Web Audio, no samples.
  - Pitch is the exhaust pulse rate, `rpm / 60 × cylinders / 2` (6 cylinders: 45 Hz at idle, 390 Hz at redline). A tone at half that rate modulates it, which gives the burble.
  - Load (delivered throttle, 0 during a shift) makes the note louder, more distorted and brighter, and adds intake noise. Lifting off leaves a quieter, duller overrun note.
  - At the limiter the note stutters about 16 times a second.
  - Toggle with V on the pause screen (saved). It fades out while paused.

| Field | Value |
|---|---|
| `engine.idleRpm` / `redlineRpm` / `launchRpm` | 900 / 7800 / 3200 |
| `engine.cylinders` | 6 (engine note only, default 6) |
| `engine.torqueCurve` | 153 @0 · 180 @1000 · 248 @2500 · 292 @4000 · **306 @5500** · 284 @6800 · 243 @7800 · 202 @8500 (N·m), about 200 kW peak |
| `engine.engineBraking` | 70 N·m at redline |
| `engine.throttleResponse` | 0.25 s (closed to full) |
| `gearbox.ratios` | 2.6, 1.85, 1.42, 1.15, 0.99, 0.88 (6 speed) |
| `gearbox.reverse` / `finalDrive` / `efficiency` | 3.0 / 3.9 / 0.88 |
| `gearbox.shiftTime` / `upshiftAt` / `downshiftAt` | 0.18 s / 0.93 / 0.5 |
| `drivetrain.layout` | RWD |
| `brakes.maxTorque` / `frontBias` / `handbrakeTorque` | 9000 N·m total / 0.64 / 3000 N·m (rear only) |

---

## 8. Aero (`Vehicle.applyAero`)

```
drag      = ½ ρ dragArea |v| × v          (opposes velocity; ρ = 1.225)
downforce = ½ ρ downforceArea × forwardSpeed²   (along −up, at the centre of mass)
```

| Field | Value | Effect |
|---|---|---|
| `aero.dragArea` | 0.72 m² | Sets top speed (~230 km/h). A real sports car is about 0.65–0.7. |
| `aero.downforceArea` | **3** | Grip that grows with speed: ≈ +3.2 kN (24% of weight) at 150 km/h, +5.7 kN (43%) at 200 km/h. Arcade level. Downforce costs no drag in this model; if you raise it, consider raising `dragArea` slightly too. |

---

### 8.1 Car visuals (`render/car/`)

The car is drawn in code, not loaded from a model: an original premium coupe, sized from this file so it always matches the physics.

- **Body and cabin** are *lofts* (`loft.ts`): keyframe cross-sections along the car (width, bottom, top, how boxy, how far the sides lean in), interpolated and stitched into one smooth mesh. The design keyframes are in `coupe.ts`, written relative to `chassis.halfExtents`, the axles and the resting ground line.
- **Wheel wells** are cut by raising the outer part of each ring around the axles; the floor between them is left alone. Over the wheels the body is 4% wider than the collision box so the tyres sit flush.
- **Two-tone areas** (grille, sills, wells, windows, roof) are assigned per face. Edges along a ring or along a constant angle come out clean; anything else steps at mesh resolution, so new areas should follow those lines.
- **Wheels** (`wheel.ts`): a lathed tyre, a five-twin-spoke rim with the brake disc behind it, and a caliper that steers but doesn't spin.
- **Preview:** `npm run dev`, then open `/car.html` (dev only): a turntable you can drag. `?view=three|front|side|rear|rearThree|top|wheel` fixes the camera for screenshots.

## 9. Input pipeline

Every device produces the same `InputState` (`packages/shared/src/input.ts`). `InputSystem` merges the sources: the source with the largest `|steer| + throttle + brake` drives the axes, and buttons from all sources are OR'd together. Button presses are edge-detected for toggles.

### 9.1 Keyboard (`input/KeyboardInput.ts`)
Keys are digital, so the axes ramp like a wheel and pedals:

- **Steering:** in 3.2/s, back to centre 6/s.
- **Pedals:** in 6/s, out 10/s.
- A tap shorter than one frame still registers.

| Key | Action |
|---|---|
| W/S or ↑/↓ | Throttle / brake (hold brake at a stop to reverse) |
| A/D or ←/→ | Steer |
| Space | Handbrake |
| C / R / P or Esc | Camera / reset to track / pause |
| T / B | Toggle traction control / ABS |

### 9.2 Gamepad (`input/GamepadInput.ts`)
Standard mapping, with a stick deadzone of 0.08 rescaled to full range.

- **Driving:** RT throttle, LT brake, left stick steer, A handbrake.
- **Buttons:** Y camera, B reset, Start pause, D-pad left/right toggle TC/ABS.

### 9.3 Phone controller
The phone does all signal processing and sends a finished `steer` value, so the car treats it like any other device.

**Tilt → steer** (`packages/shared/src/controller.ts`, `controller/tilt.ts`, `controller/main.ts`):

1. **Gravity vector:**
   - Source: `GravitySensor` at 60 Hz. If it gives no reading within 1 s, the phone falls back to `devicemotion` `accelerationIncludingGravity`, which is noisier. The calibrate screen shows which one is in use.
   - It is rotated into screen coordinates using `screen.orientation.angle`.
2. **Wheel angle** = `atan2(−right, up)` in degrees, clockwise positive. This does not depend on how far back the phone is tipped. Readings are ignored when the in-screen gravity is below 3 m/s², i.e. the phone is nearly flat.
3. **Calibration:** the angle at the moment you tap becomes the centre. The CENTRE button re-centres instantly.
4. **One-euro filter** on the tilt from centre:
   - `minCutoff` 1.2 Hz: smooth when held still.
   - `beta` 0.05: lag drops as you turn faster.
5. **Shaping** (`shapeSteering`, defaults in `DEFAULT_STEERING`):
   ```
   x = clamp((|tilt| − deadzone) / (maxLock − deadzone), 0, 1)
   steer = sign(tilt) × ((1 − curve)·x + curve·x³)
   ```

| Setting | Default | Phone slider range |
|---|---|---|
| `deadzoneDeg` | 2.5° | 0–8 |
| `maxLockDeg` (tilt for full steer) | 40° | 15–70 |
| `curve` (0 linear … 1 cubic) | 0.4 | 0–1 |

Slider values are saved on the phone under `localStorage['drivee.steering.v4']`. **Bump the key version whenever the defaults change**, or phones keep their old saved values.

**Pedals** (`controller/pedal.ts`):
- The right half of the screen is the throttle and the left half is the brake.
- The value comes from finger height: 25% minimum anywhere in the zone, full from 65% of the zone height upwards, and the bottom 10% maps to the minimum.

**Buttons:**
- CAM, RESET and PAUSE send the same `Button` bits as the keyboard. HANDBRAKE is held.
- A tap is latched until the next packet, so short taps aren't lost.
- Opening ⚙ settings pauses the game, and closing it resumes.

**Transport** (`apps/signaling/`, `net/SignalClient.ts`, `input/PhoneInput.ts`, `controller/PadLink.ts`):
- **Packets:** 8-byte binary input packets at 60 Hz: version, sequence number, steer i16, throttle u8, brake u8, buttons + handbrake bit.
- **Pairing and signalling:** a FastAPI server (`apps/signaling`, port 8000), reached over plain HTTP through the Vite server's `/signal` proxy so it shares the page's origin and certificate. No WebSocket. Each side joins a room (`POST /signal/host` or `/signal/pad`), long-polls `GET /signal/poll` (20 s) for messages and posts its own with `POST /signal/send`; it says goodbye with `POST /signal/leave` (a beacon on `pagehide`). The server hands out the room code and the LAN addresses for the QR, announces the phone joining or leaving, and accepts only WebRTC signalling (`rtc-offer`, `rtc-answer`, `rtc-ice`). A peer that stops polling for 10 s is dropped. Rooms live in a dictionary (`MemoryRoomStore`) behind the `RoomStore` interface, to be swapped for Redis.
- **Data channel:** once paired, the phone offers a WebRTC data channel (unordered, no retransmits, no STUN since both are on the LAN) and the game answers. Inputs, ping/pong, status and buzzes go over it and nowhere else. The phone shows "Linking to the game…" until the channel is up, and the game counts the phone as paired only while it is. A channel that's up keeps working if the signalling server goes away.
- **Retry:** if the channel closes, fails, or isn't up within 8 s, the phone tears it down and offers again after 1 s, for as long as the game is in the room.
- **Freshness:** packets older than the newest are dropped, and a send is skipped if the channel is backed up.
- **Disconnect:** no packet for 500 ms means the game pauses ("Controller disconnected") and resumes when packets return.
- **Latency:** round-trip time is measured by ping/pong every second and shown on both screens.

### 9.4 Haptics (`input/haptics.ts`, phone vibration)

| Event | Trigger | Pattern |
|---|---|---|
| Impact | Velocity change > 0.8 m/s in one 120 Hz step (~10 g) | One pulse, 40 ms + 35 ms per m/s over the threshold, max 300 ms. Kerb and limiter pulses wait 0.3 s after it. |
| Kerb | A grounded wheel on a kerb and speed > 4 m/s | 22 ms pulse every 0.14 s |
| Rev limiter | Throttle > 0.5 and rpm ≥ 99% of redline | 10 ms pulse every 0.15 s |

---

## 10. Tuning log

Newest first. Keep the reason, so a change can be judged or undone later.

| Date | Change | Why |
|---|---|---|
| 2026-10-29 | Torque −32% (peak 450 → **306 N·m**, ~300 → ~200 kW); **`throttleResponse` 0.25 s** added; ratios 3.2…0.88 → **2.6…0.88**, final drive 3.6 → **3.9**; drag 0.88 → **0.72**. Tests: 0–100 in 5.2–6.8 s, top speed 215–250 km/h, torque builds over the first moment, and the wheelspin test uses wet-road rear grip 0.8. | Initial acceleration was too fast: a 0.87 g kick from the first frame, 0–100 in 3.6 s (supercar pace). The target is a warm sports car: 0–100 in **5.9 s**, peaking at about 0.5 g. The shorter final drive puts top gear near peak power, and the old drag figure only existed to cap the stronger engine. |
| 2026-10-27 | Tyre grip 1.35/1.42 → **1.7/1.78**; downforce 1.4 → **3**. Tests updated: braking range 18–32 m, wheelspin test uses road-car rear grip. | Still "not turning much" at speed. The track's tight corners (46–64 m radius) need ~100 km/h; this raises cornering to ~1.6 g at 100 km/h and ~2.2 g at 200 km/h (NFS-style rather than road car). |
| 2026-10-27 | `minLockFactor` 0.18 → **0.3**, `highSpeed` 38 → **45**; drag 0.85 → **0.88** | At high speed full lock couldn't use all the tyre grip. Drag offsets the top-speed gain from extra downforce. |
| 2026-10-27 | Grip 1.15/1.22 → 1.35/1.42; downforce 0.35 → 1.4; stability yaw cap includes downforce | Low cornering at speed (the car was at road-car ~1 g). |
| 2026-10-27 | **Stability assist added**; rear grip 1.15 → 1.22. Centre of mass moved forward to +0.05, then reverted (cost traction). | Phone steering: the car went into a slide and never straightened (34°/s yaw 3 s after centring the wheel). Now it straightens in ~0.4 s. |
| 2026-10-27 | `minLockFactor` 0.22 → 0.18, `highSpeed` 55 → 38 | Phone steering twitchy at speed (superseded by the rows above). |
| 2026-10-27 | Phone defaults: deadzone/lock/curve 2/35/0.35 → 2.5/45/0.6 → 2.5/40/0.5 → **2.5/40/0.4**; one-euro 2.5 Hz/0.08 → **1.2 Hz/0.05** | Twitchy steering at first, then too slow to change direction once the car itself was stable. |
| M1 | `dragArea` raised to 0.85 | Top speed was too high. |

---

## 11. Reference measurements

These are headless runs on flat asphalt with the current `car.json` and all assists on, so they show what the car is capable of. Re-measure after changing anything above.

**Cornering limit at steady speed** (full steer):

| Speed | Lateral | Tightest radius |
|---|---|---|
| 100 km/h | 1.63 g | 48 m |
| 150 km/h | 1.85 g | 95 m |
| 200 km/h | 2.16 g | 133 m |

- At 30% steer the car still reaches about 1.6–1.7 g.
- **Recovery:** after a hard turn at 100 km/h with the steering centred, the yaw rate is under 2°/s within 0.6 s.
- **Braking 100 → 0 km/h:** 22.7 m.
- **Acceleration:** 0–100 km/h in **5.9 s**, 0–200 in 23.4 s, 1 km from a standstill in 25.6 s. Peaks at about 0.5 g, building from 0.14 g in the first 0.1 s.
- **Top speed:** ≈ **230 km/h** in 6th, limited by drag.

**Track context (Eifel Ring, 4.5 km):** most corners have a tightest radius of 46–64 m, so they top out around 100–110 km/h even at this grip. The fast sections are a 110 m bend (~150 km/h) and 166–182 m bends (~180–200 km/h). Arriving much faster than that needs braking; no grip setting fixes it.

---

## 12. Changing things safely

- **Per-car values** live in `car.json`. Add new fields to `car-schema.ts` with `.default()` so older car files still parse.
- **Assist constants** are at the top of `Vehicle.ts`. Phone defaults are `DEFAULT_STEERING` in `controller.ts`; remember to bump the phone settings key.
- **Tests guarding the behaviour:**
  - `apps/game/test/vehicle.test.ts`: settling, acceleration and shifting, braking distance, cornering direction and staying upright, reversing, wheelspin without TC, handbrake, top speed, straightening after centring the steering.
  - `apps/game/test/world.test.ts`: the autopilot lap on the real track.
  - `apps/game/test/controller.test.ts`: tilt maths, shaping, filter, pedals, haptics.
- **Run** `npm test`. To check feel numbers, write a throwaway vitest probe like those in section 11: hold a speed, steer, and read `body.angvel()` and `telemetry.speed`.
