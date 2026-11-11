# Drivee — Requirements Specification

Version 1.0 · 2026-10-26

---

## 1. Vision

A browser-based racing game, written in TypeScript with Three.js, set on the **Nürburgring Nordschleife**. The player steers by **tilting an Android phone** like a steering wheel and controls throttle and brake with touch zones on the phone screen.

The feel is inspired by late-90s exotic-car arcade racers: saturated colours, loud music, a chunky HUD and short, intense sessions. The graphics are modern, using physically based materials, real-time lighting and post-processing. Handling is **slightly sim-like**: the car has weight, grip and controllable slides, and driver assists keep phone steering enjoyable.

All cars, branding and UI are original. We borrow the feel of the era, not its content.

---

## 2. Decisions

| Topic | Decision |
|---|---|
| Language / rendering | TypeScript + Three.js |
| Track | Nürburgring Nordschleife (~20.8 km, ~300 m elevation change) |
| Track system | Data-driven track packages; new tracks need no engine code changes |
| Visual style | "Remastered 90s": modern lighting, bold and realistic, saturated grade |
| Controller | Android phone (Chrome), tilt to steer, touch zones for throttle/brake |
| Network | Same Wi-Fi (LAN) only |
| Physics | Slightly sim-like, with assists |
| Cars (MVP) | Low-poly CC0 models (Kenney, Quaternius), re-materialed at runtime |
| iOS | Out of scope for now |

---

## 3. Scope

### 3.1 MVP (in scope)
- Free drive and time trial on the Nordschleife
- Best-lap ghost car
- Phone controller with QR pairing; keyboard and gamepad as fallbacks
- 3 cars from CC0 packs, each with distinct handling data
- Chase, hood and bumper cameras
- Lap timing with sectors, checkpoints and reset-to-track
- Main menu, car select (showroom), settings, results screen
- RPM-driven engine audio, tyre and impact sounds, music playlist
- Low, Medium and High quality presets

### 3.2 Later (out of MVP scope)
- AI opponents and races
- Championship mode
- Weather (rain, fog) and night driving
- In-game track editor
- Additional tracks
- Replays with cinematic cameras
- Higher-quality hero car models
- iOS controller support
- Internet (non-LAN) play

---

## 4. Phone Controller

### 4.1 Platform
- Android, Chrome 100+.
- Served over **HTTPS**. Motion sensors require a secure context, so local development uses a self-signed certificate (Vite basic-ssl plugin or mkcert).

### 4.2 Pairing flow
1. The game screen shows a **QR code** and a 4-character room code.
2. The phone scans the QR code and the controller page opens. No app install is needed.
3. The player taps **Start**. The page goes fullscreen, locks to landscape and acquires a Wake Lock.
4. A calibration prompt asks the player to hold the phone in a neutral position and tap to confirm.
5. The game screen shows "Controller connected" with a latency readout.

### 4.3 Input
| Input | Source |
|---|---|
| Steering | Tilt the phone held in landscape (roll angle) |
| Throttle | Right half of the screen; analog based on finger position (vertical) |
| Brake | Left half of the screen; analog in the same way |
| Handbrake | Dedicated button |
| Camera / Pause / Reset | Small buttons along the top edge |

**Steering signal processing:**
- Primary source: the `GravitySensor` (Generic Sensor API). Roll = `atan2` of the gravity components. Fallback: the `deviceorientation` event.
- Calibrated zero point, with a configurable deadzone (default 2°).
- Configurable max lock angle (default ±35° of phone tilt = full steering lock).
- Configurable response curve (linear to exponential).
- Low-pass smoothing (one-euro filter) to remove jitter without adding perceptible lag.

### 4.4 Feedback
Haptics through the Vibration API:
- Short pulses when driving over kerbs
- A pulse proportional to impact strength on collisions
- A light buzz at the rev limiter

### 4.5 Connection
- **v1:** WebSocket through the local Node server. Inputs are sent at 60 Hz as small binary packets: steering, throttle, brake, button bitmask and sequence number.
- **v2:** WebRTC DataChannel (unordered, unreliable) for lower latency. A FastAPI signalling server pairs the devices and passes signalling over plain HTTP (long-polling); there is no WebSocket. Inputs and messages travel only over the data channel.
- **Latency target:** under 50 ms from phone to car on typical home Wi-Fi. Latency is measured with ping/pong and shown in debug.
- If no input arrives for 500 ms, the game **pauses automatically** and shows "Controller disconnected". It reconnects automatically when the phone comes back.

### 4.6 Fallbacks
Keyboard (WASD or arrows) and a standard gamepad (Gamepad API) are always available. They are used for development and for players without a phone.

---

## 5. Track System

### 5.1 Principle
A track is a **data package**. The engine contains no track-specific code. To add a track, add a folder that passes schema validation.

### 5.2 Package layout
```
public/tracks/<track-id>/
  track.json          definition (schema-validated)
  heightmap.png       optional 16-bit terrain elevation
  splat.png           optional terrain material mask
  scenery/*.glb       optional custom props / landmarks
  textures/           optional overrides
  thumbnail.jpg       menu image
```

### 5.3 `track.json` contents
- **meta:** id, name, country, length, author, version, licence and attribution (e.g. OpenStreetMap ODbL)
- **centreline:** ordered 3D control points (Catmull-Rom spline). Each point can carry:
  - width (left and right separately)
  - banking angle
  - surface type: asphalt, concrete, kerb, grass or gravel
  - roadside tags (barrier type, kerb style)
- **branches** (optional): pit lane, alternate layouts
- **race:**
  - mode: loop or point-to-point
  - start/finish line and grid slots
  - ordered checkpoints (anti-shortcut and lap validation)
  - sector boundaries
  - reset points, auto-generated every N metres plus hand-placed ones
- **roadside:** rules for generating kerbs, Armco, walls, fences and catch-fencing along the spline, plus overrides by distance range
- **scenery:**
  - procedural regions (forest density, grass, rocks, by distance range or polygon)
  - hand-placed props (bridges, grandstands, signs, buildings) with transforms
- **environment:** allowed time-of-day presets, sky, fog, sun angle, music playlist
- **ai** (later): racing line and braking zones

The schema is defined with Zod. Both the loader and the import tools use it.

### 5.4 Engine modules (track-agnostic)
| Module | Responsibility |
|---|---|
| TrackRegistry | Lists the available tracks (from a manifest) for the menu |
| TrackLoader | Fetches and validates `track.json`; drives chunk streaming |
| RoadMeshGenerator | Builds the road surface, kerbs and barrier meshes from the spline; outputs a physics collider per chunk |
| TerrainGenerator | Builds terrain from the heightmap and blends it into the road edges |
| SceneryPlacer | Places instanced vegetation and props, with LODs |
| ChunkStreamer | Splits the track into ~250 m segments and loads/unloads by distance from the player |
| RaceLogic | Checkpoints, laps, sectors, timing, reset-to-track |
| Minimap | Draws the minimap automatically from the centreline |

### 5.5 Nordschleife-specific needs
- At 20.8 km, chunk streaming is mandatory. At most about 2 km of full-detail geometry should be resident at any time.
- Elevation fidelity matters, especially at Fuchsröhre, Flugplatz, Karussell and Pflanzgarten. Use the best available elevation data (SRTM 30 m minimum; better DEM data if available) and smooth the road profile.
- The Karussell needs a concrete, banked inner surface, using surface type and banking overrides.

### 5.6 Track Generation Pipeline

Tracks are generated from real geographic data, not modelled by hand. Work is split into two stages:
- **Offline import:** the `tools/track-import` Node CLI does the heavy data processing once and outputs a track package.
- **Runtime generation:** the game turns `track.json` into meshes and colliders as it loads.

```
 OFFLINE (Node CLI, run once)                          RUNTIME (in the game)
┌─────────────┐   ┌──────────────┐   ┌────────────┐   ┌──────────────────────┐
│ OSM         │──▶│ Centreline   │──▶│ track.json │──▶│ RoadMeshGenerator    │
│ (road path) │   │ clean/smooth │   │ heightmap  │   │ TerrainGenerator     │
├─────────────┤   ├──────────────┤   │ scenery    │   │ SceneryPlacer        │
│ Elevation   │──▶│ Elevation    │──▶│ regions    │   │ Physics colliders    │
│ model (DEM) │   │ profile      │   └────────────┘   │ ChunkStreamer        │
├─────────────┤   ├──────────────┤        ▲           └──────────────────────┘
│ OSM land use│──▶│ Forest/field │        │
│ & buildings │   │ polygons     │   manual overrides
└─────────────┘   └──────────────┘   (widths, banking, kerbs)
```

#### 5.6.1 Offline import (`tools/track-import`)

**Inputs:**
- An OSM query or way IDs (or a GPX file)
- A DEM GeoTIFF
- An overrides file (`overrides.json`)

**Steps:**

1. **Centreline acquisition**
   - Fetch the track ways from the Overpass API. The Nordschleife is mapped as `highway=raceway`.
   - Join the separate ways in order into one continuous path, closed for a loop track.
   - Fallback for poor OSM data: a GPX recording of a real lap, or a manual trace over satellite imagery.
2. **Projection**
   - Convert latitude/longitude to local metres using UTM zone 32N (EPSG:25832), with the origin at start/finish.
   - All later steps and the game work in plain metres.
3. **Smoothing and resampling**
   - Fit a smoothing spline through the raw points.
   - Resample at a fixed **5 m** spacing along the road.
   - Limit curvature, so OSM jaggedness is removed but real corner shape is kept.
   - Validation: total length within ±1% of the reference (Nordschleife: 20.832 km).
4. **Elevation**
   - Sample the DEM at every centreline point, with bilinear interpolation.
   - DEM sources, best first; licence of each to be checked before use:
     1. Rhineland-Palatinate state survey DEM, 1 m resolution
     2. Copernicus GLO-30
     3. SRTM, 30 m
   - Smooth along distance to remove DEM noise, while keeping signature features:
     - Flugplatz and Pflanzgarten crests
     - Fuchsröhre compression
     - The climb to Hohe Acht
   - Distance-range overrides can lock or adjust the height profile.
   - Validation: the elevation range is about 300 m, and the profile matches published Nordschleife elevation charts.
5. **Width and banking**
   - Width defaults to 9 m. OSM `width` tags are used where present, plus overrides by distance range.
   - Banking is estimated from the DEM by sampling heights on the left and right of the road.
   - Manual overrides for special sections, e.g. the **Karussell** (steep banked concrete inner lane, surface `concrete`).
6. **Scenery data**
   - OSM land use (`landuse=forest`, `natural=wood`, `landuse=meadow`, etc.) becomes scenery region polygons.
   - OSM buildings become simple raised building outlines, or spots for prop models (Nürburg village, castle, Döttinger Höhe).
   - Crop the terrain **heightmap** around the track bounds plus a margin (roughly 6 × 4 km for the Nordschleife). Export it as a 16-bit PNG.
7. **Race data**
   - Start/finish at the Touristenfahrten gantry.
   - Checkpoints every ~500 m; sector boundaries.
   - Reset points every ~50 m.
   - **Named corners:** a table of corner names by distance (Hatzenbach, Flugplatz, Bergwerk, Karussell, Schwalbenschwanz, …), shown on the HUD on approach.
8. **Output**
   - The package `public/tracks/<id>/`: `track.json`, `heightmap.png`, `splat.png`, scenery data and `thumbnail.jpg`.
   - Validate the package against the Zod schema before writing it.

The CLI is **repeatable**: re-running it with an updated `overrides.json` regenerates the package, so manual fixes are never lost.

#### 5.6.2 Runtime generation

1. **Road mesh**
   - Sweep a **cross-section template** along the spline: asphalt, kerbs, verge, ditch and barrier. Distance-range overrides change it, e.g. kerbs only at corners, or walls instead of Armco.
   - Frames: rotation-minimising (parallel-transport) frames along the spline, so the road doesn't twist on climbs. Banking roll is applied on top.
   - Textures run along the road length, so asphalt and racing lines tile cleanly.
   - Chunk boundaries share vertices, so there are no seams.
   - The same geometry produces the **physics collider** per chunk, tagged with surface type (asphalt / concrete / kerb / grass / gravel) for the tyre model.
2. **Terrain**
   - Mesh from the heightmap, detailed near the road and coarser farther away.
   - **Road corridor:** terrain within the corridor is flattened and blended to meet the road edges, so there are no gaps or floating road.
   - Ground textures are blended by slope, distance from the road and land-use region (grass, dirt, forest floor, rock).
3. **Scenery**
   - Instanced trees inside the forest regions, kept out of a clearance zone around the road, with billboard impostors in the distance.
   - Procedural roadside props: Armco, catch-fencing, signs, marshal posts and distance boards.
   - Hand-placed props from `track.json`.
4. **Streaming**
   - The lap is split into **~250 m chunks** (~84 for the Nordschleife).
   - About 2 km around the player is kept at full detail; farther chunks are low-detail; chunks behind are unloaded.
   - Mesh generation runs in a Web Worker to avoid frame stutter.

**Future optimisation:** if runtime generation proves too slow, pre-bake the chunk meshes to glTF at import time. The `track.json` format stays the same.

#### 5.6.3 Debug & validation tools
- **Plan view:** a debug page showing the track outline over satellite imagery (to check alignment), plus an elevation profile chart.
- **In-game debug mode:** draws the centreline, chunk boundaries, checkpoints, reset points and surface types.
- **Import report:** a summary printed by the CLI with length, elevation range, min/max curvature and gradient, and warnings (e.g. sudden height jumps, self-intersections).

#### 5.6.4 Data licences
- OpenStreetMap data is **ODbL**: attribution is required in `CREDITS.md` and on the in-game credits screen.
- The licence of the chosen elevation dataset must be checked and credited.

#### 5.6.5 First tracks, in order
1. **`test-loop`:** a small hand-written `track.json` (no OSM or DEM) that verifies runtime generation end to end.
2. **`nordschleife`:** built through the import CLI.

---

## 6. Cars

### 6.1 Package layout
```
public/cars/<car-id>/
  car.json        physics, handling, audio, node mapping
  model.glb       visual model
  thumbnail.jpg
```

### 6.2 MVP models
- Source: **CC0 low-poly packs** (Kenney Car Kit, Quaternius). Keep the licence notes in `CREDITS.md`.
- At runtime the engine replaces the flat materials with physical (`MeshPhysicalMaterial`) ones, so low-poly shapes still look good under modern lighting:
  - paint: clearcoat
  - glass: transmission
  - chrome: metallic
  - tyres: rough rubber
- **Node mapping:** `car.json` maps the engine's logical part names to whatever node names the model uses. Third-party models then work without editing them in Blender.

  | Logical name | Notes |
  |---|---|
  | `body` | Must contain a material assignable as `paint` |
  | `wheel_FL`, `wheel_FR`, `wheel_RL`, `wheel_RR` | Required; separate nodes pivoted at the hub |
  | `light_brake`, `light_head`, `light_reverse` | Optional; emissive toggle |
  | `steering_wheel` | Optional; for the cockpit camera |
  | `glass` | Optional |

- If a pack model has wheels fused to the body, it is fixed once in Blender, or a separate CC0 wheel model is used and attached through the mapping.
- Scale and orientation corrections (scale factor, forward axis) are also set in `car.json`.

### 6.3 Model standard (for future hero cars)
- Metres, Y-up, facing +Z
- 50–100k triangles for the player car; about 10k LOD for AI cars
- 2K textures, compressed as KTX2
- glTF with Draco-compressed meshes

### 6.4 Physics data (`car.json`)
| Group | Fields |
|---|---|
| Chassis | mass, centre-of-gravity height, wheelbase, track width, inertia scale |
| Engine | torque curve (RPM → Nm), idle RPM, redline, rev limiter, engine braking |
| Gearbox | gear ratios, final drive, shift time, auto/manual |
| Drivetrain | FWD / RWD / AWD, torque split, differential (open / LSD) |
| Suspension | per-axle spring rate, damper (bump/rebound), travel, anti-roll bar |
| Tyres | simplified Pacejka-style lateral and longitudinal grip curves, peak slip, grip falloff, load sensitivity |
| Aero | drag coefficient, frontal area, downforce coefficient |
| Brakes | max torque, front/rear bias |
| Assists | traction control, ABS, stability assist, steering assist (counter-steer help), speed-sensitive steering |
| Audio | engine samples at several RPMs plus their RPM points; turbo/blow-off (optional) |

---

## 7. Driving Physics

- **Raycast vehicle model:** one suspension ray per wheel against the track collider.
- **Physics engine:** Rapier (WASM) handles the rigid body and collisions. The tyre, engine and drivetrain model is custom code.
- **Fixed physics step:** 120 Hz, decoupled from rendering, with interpolation.
- **Target feel:**
  - Weight transfer under braking and acceleration is noticeable
  - Lift-off and power oversteer are possible in rear-wheel-drive cars
  - Slides are recoverable
  - Kerbs unsettle the car
  - Grass and gravel reduce grip
  - Crests at Flugplatz and Pflanzgarten can make the car airborne
- **Assists are on by default** and tuned for phone steering. They can be lowered in settings.
- **Collisions** with barriers scrape and deflect. There is no damage model in the MVP.
- **Reset to track:** manually, or automatically after 3 s upside-down or off the track. The car is placed at the nearest reset point behind the car.

---

## 8. Graphics

- **Renderer:** Three.js WebGL2. A WebGPU renderer may be evaluated later.
- **Lighting:**
  - Physically based materials
  - HDR sky with image-based lighting
  - Directional sun with cascaded shadow maps
- **Time-of-day presets:** morning, noon and golden hour in the MVP; dusk and night later.
- **Post-processing:**
  - ACES tone mapping
  - Colour grading (warm, saturated, slight contrast boost for the "remastered 90s" grade)
  - Bloom
  - SSAO (High preset only)
  - Camera motion blur at speed
  - Subtle lens flare
  - Vignette
- **Environment:**
  - Dense instanced forest with billboard impostors in the distance
  - Grass, Armco, fences and signage
  - Distance fog and atmospheric haze for the Eifel hills
- **Effects:** tyre smoke, skid marks (decal ribbon), sparks on scraping, heat haze (High preset only).
- **Quality presets:** Low, Medium and High adjust shadow resolution, vegetation density and distance, post-processing passes and render scale.

---

## 9. Audio

- Built on the Web Audio API.
- **Engine:** RPM-crossfaded samples, with throttle-load blending (on and off throttle).
- **Other sounds:** tyre squeal tied to slip, wind tied to speed, impacts, kerb rumble, gear shifts.
- **Music:** royalty-free playlist in an electronic/rock style; volume set separately from effects.
- Audio starts on the first user gesture, as the browser autoplay policy requires.

---

## 10. UI / UX

- **Flow:** Title → Main menu → Car select (rotating showroom with a stats panel) → Track select / options → Pair controller → Race → Results.
- **HUD:**
  - Large analog tachometer with a gear indicator
  - Digital speed (km/h, or mph as an option)
  - Lap time, best lap and sector delta (green/red)
  - Minimap
  - Controller status icon
- **Style:** bold typography, angular panels and high-contrast accent colours, in the spirit of the 90s.
- **Settings:**
  - Quality preset and individual toggles
  - Steering sensitivity, deadzone, curve and recalibration
  - Assists
  - Units
  - Volume sliders

---

## 11. Technical Architecture

### 11.1 Stack
| Layer | Choice |
|---|---|
| Build | Vite, TypeScript (strict) |
| Rendering | three (pinned version), postprocessing library |
| Physics | @dimforge/rapier3d-compat |
| Validation | zod |
| Server | Vite (static hosting over HTTPS, proxies `/signal`); FastAPI signalling server (rooms, WebRTC signalling over HTTP), in-memory store for now, Redis later |
| Controller page | Separate lightweight Vite entry; no Three.js |
| Tests | Vitest (physics maths, spline maths, schema, race logic) |

### 11.2 Repository layout
```
drivee/
  apps/
    game/            Three.js game (desktop browser)
    controller/      phone controller page
    signaling/       FastAPI signalling server: pairing, WebRTC signalling
  packages/
    shared/          protocol types, track/car schemas, maths utils
  tools/
    track-import/    OSM/GPX + DEM → track.json
  public/
    tracks/
    cars/
  docs/
```

### 11.3 Game architecture
- A main loop with a fixed-step simulation and a variable-rate render step.
- Systems: `InputSystem` (phone, keyboard, gamepad behind one interface), `VehicleSystem`, `TrackSystem`, `RaceSystem`, `CameraSystem`, `AudioSystem`, `FxSystem`, `UISystem`.
- Every input source produces the same `InputState { steer, throttle, brake, handbrake, buttons }`.

---

## 12. Non-Functional Requirements

| Area | Target |
|---|---|
| Frame rate | 60 fps at 1080p on Medium, on a mid-range laptop GPU (e.g. RTX 3050 / Radeon 680M class) |
| Initial load | < 10 s to the menu on broadband; track chunks stream during play |
| Memory | < 1.5 GB GPU memory on High |
| Input latency | < 50 ms from phone to car on LAN |
| Browsers (game) | Latest Chrome, Edge and Firefox on desktop |
| Browser (controller) | Chrome 100+ on Android |
| Accounts | None; settings and best laps are stored locally (localStorage) |

---

## 13. Milestones & Acceptance Criteria

| # | Milestone | Done when |
|---|---|---|
| M1 | Project skeleton + driving prototype | A car drives on a flat plane with the keyboard; physics steps at a fixed rate; chase camera works |
| M2 | Phone controller | Pair by QR on LAN; tilt steers and touch drives; latency < 50 ms shown; auto-pause on disconnect |
| M3 | Track pipeline | `test-loop` loads from `track.json`; road, kerbs, barriers and colliders are generated; laps and checkpoints work |
| M4 | Nordschleife | The import CLI produces the Nordschleife; length within ±1% of 20.832 km; elevation profile matches reference; full lap drivable with streaming and no stutter |
| M5 | Cars | 3 CC0 cars loaded via `car.json` with re-materialing and distinct handling |
| M6 | Visual pass | Lighting, shadows, post-processing, forest and effects; quality presets hit the frame-rate target |
| M7 | Game layer | Menus, showroom, time trial, ghost, HUD, audio, settings |
| M8 | Polish | Tuning, bug fixing, performance pass, `CREDITS.md` complete |

---

## 14. Risks

| Risk | Mitigation |
|---|---|
| Nordschleife geometry quality from OSM/DEM data (bumpy or wrong elevation) | Smoothing pass, manual overrides by distance range, better DEM if available |
| 20 km track performance | Chunk streaming, instancing, impostors and LODs from day one |
| Tilt steering feels imprecise | Gravity sensor, one-euro filter, steering assist, tunable curve, early playtesting in M2 |
| Wi-Fi jitter | Small binary packets, input smoothing on the game side, optional WebRTC in v2 |
| Low-poly cars clash with the realistic look | Runtime physical materials and a strong post-processing grade; hero models later |
| Trademarks (Nürburgring name/logo) | Fine for a personal project; rename and remove logos before any public release |

---

## 15. Open Items

- Project/game name (working title: **Drivee**)
- Music source (specific royalty-free tracks)
- Personal project or public release (affects naming and attribution)
