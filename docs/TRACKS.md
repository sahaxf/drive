# Tracks

A track is pure data: one folder under `public/tracks/<id>/` with a `track.json`, validated by [`packages/shared/src/track-schema.ts`](../packages/shared/src/track-schema.ts). The game generates the road, terrain, forest and mountains from that file at load time.

## Registering a track

1. Create `public/tracks/<id>/track.json`. Its `meta.id` must equal the folder name.
2. Add the id to [`public/tracks/index.json`](../public/tracks/index.json).

The track then appears on the home screen, with a minimap, length, elevation range and best lap. It is also covered automatically by the tests:
- `world.test.ts`: generation, terrain under the road, trees off the road, and an **autopilot lap** that must finish without flipping, falling through or leaving the road.
- `tracks.test.ts`: the schema parses, and the id matches the folder.

**Navigation:** `/` is the home screen, and `/?track=<id>` drives a track. Pause (P) then Q returns to the home screen. Best laps are stored per track in the browser (`drivee.bestLap.<id>`).

## Current tracks

| Id | Name | Length | Elevation | Source |
|---|---|---|---|---|
| `eifel-ring` | Eifel Ring | 4.5 km | 83 m | Hand-made: 31 control points |
| `spa-replica` | Spa-Francorchamps (Replica) | 7.0 km | ~105 m | Generated from real data, see below |
| `nordschleife` | Nürburgring Nordschleife | 20.8 km | ~290 m | Generated from real data, see below |

## Spa-Francorchamps replica

Built by [`tools/tracks/spa/build.mjs`](../tools/tracks/spa/build.mjs). Run it with `node tools/tracks/spa/build.mjs`. Downloads are cached in `.cache/spa/` (git-ignored); delete that folder to fetch fresh data.

Each real circuit's script holds only its settings. The steps they share are in [`tools/tracks/lib.mjs`](../tools/tracks/lib.mjs): fetching and chaining the OSM ways, projection, resampling, smoothing, elevation, simplification and writing.

1. **Layout:**
   - the `highway=raceway` ways around Spa, fetched from OpenStreetMap through the Overpass API,
   - the karting, pit and moto-layout ways dropped,
   - the rest chained into the Grand Prix loop from La Source. The result is **7,003 m** (real: 7.004 km).
2. **Projection:** lat/lon to metres around the centroid, with x = east and z = south (a rotation, not a mirror).
3. **Resampling:** every 12 m (584 points), with 10 m smoothing to remove kinks at map nodes.
4. **Elevation:**
   - SRTM 30 m from the OpenTopoData public API (1 request per second, 100 points each),
   - smoothed over 28 m to remove canopy noise,
   - gradient capped at 20%,
   - shifted so the lowest point is at 20 m.
5. **Simplification:**
   - The script starts from every 10th point and keeps adding back the original point where the game's curve deviates most.
   - It stops when the curve stays within **0.3 m** of the full-detail curve everywhere, height included. It uses the same centripetal Catmull-Rom as `TrackSpline`, so the check matches what the game draws.
   - Result: 584 → **394 points**, dense in corners and sparse on straights. The file went from 37 KB to 16 KB, with one point per line.
   - The autopilot lap is unchanged (224.5 s against 223.3 s, same worst offset).
   - The tolerance is `MAX_SIMPLIFY_ERROR` in the script.
6. **Output:** `public/tracks/spa-replica/track.json`. The build prints the height at each named corner, so it can be checked against the real profile.

**The control point count doesn't affect frame rate:** at load, the game resamples every track into a spline sample every 2 m, however many control points the file has. Fewer points only means a smaller, easier-to-edit file.

**Result:**
- **Overall:** 105 m of elevation change (real: about 102 m). The highest point is at Les Combes and Malmedy, the lowest around Paul Frère and Stavelot.
- **Eau Rouge and Raidillon:** a dip at Eau Rouge, then about a 32 m climb to Kemmel.

**Known approximations:**
- **The start/finish line** is placed 230 m before La Source (`START_BEFORE_LA_SOURCE`), not surveyed. Adjust it in the script, or `race.startDistance` in the JSON.
- **Raidillon peaks at about 14–15%** against the real 17–18%. SRTM's 30 m resolution and the smoothing soften it.
- **No banking or camber yet.** Roads are flat across.
- **The scenery is generic Ardennes:** the game's own forest and hills. Grandstands, buildings and run-off areas are not modelled.

## Nürburgring Nordschleife

Built by [`tools/tracks/nordschleife/build.mjs`](../tools/tracks/nordschleife/build.mjs), with the same steps as Spa. Downloads are cached in `.cache/nordschleife/`. The elevation download takes about 10 minutes, because the public API allows 1 request per second and the lap needs 18 requests.

**Layout:**
- OSM names every section of the Nordschleife (Hatzenbach, Flugplatz, Fuchsröhre, … Döttinger Höhe, Antoniusbuche, Tiergarten, Hohenrain, T13).
- The GP circuit, pit lanes, the sprint layout and the link roads are excluded by name.
- The chained loop is **20,769 m** (real: 20.832 km, the full lap including the Hohenrain chicane).
- The lap starts and ends at **T13**, 100 m into that section, where official Nordschleife lap times are taken.

**Elevation:**
- SRTM is smoothed over 35 m, more than Spa's 28 m, because much of the track runs through forest and the canopy adds noise.
- The range is **292 m** (real: about 300 m). The lowest point is Breidscheid; the highest is the start area and Hohe Acht / Hedwigshöhe.

**Settings:**
- **Road width 10 m.** The real track is 7–12 m; 10 m is a little more forgiving for phone steering.
- **Karussell:** banked 15° into the corner (it's a left-hander), ramped in and out over 25 m. This stands in for the real concrete bowl.
- **Terrain grid at 8 m** (Spa uses 5 m). The track's bounding box is about 6 × 6 km, roughly ten times Spa's, so 5 m would mean 2 M vertices. At 8 m the grid is 848 × 696, and every cell under the road is still inside the flattened corridor.
- **Forest:** `density 55`, `meadowAmount 0.9`, about **32k trees**.

**Result:**
- Generation takes about 1.2 s.
- The autopilot lap takes 10:54.
- On an Intel Iris Xe, frame rate is about 100–130 fps on Medium shadows (Spa: 115–125), 65–75 on High and 130–180 with shadows off.

**Known approximations:**
- **Breidscheid to Exmühle peaks at the 20% gradient cap** over about 40 m (real maximum: about 17%). SRTM probably measures the valley floor under the Breidscheid bridge.
- **SRTM's 30 m resolution and the smoothing soften the crests** (Flugplatz, Pflanzgarten), so the car jumps less than it would on the real track.
- **The scenery is generic,** as at Spa. Real forest areas, buildings and bridges are not modelled.

## Forest and performance

Each track sets its forest in `track.json` `forest`:

| Field | Meaning |
|---|---|
| `meadowAmount` | 0 = unbroken forest, 1 = all open land. Woodland grows where a noise pattern (patches about 400 m across) is above a threshold set by this value. |
| `seed` | Which noise pattern, i.e. *where* the woods are. If the woods happen to line the road too much, try another seed. |
| `density` | Trees per hectare inside woodland. |
| `broadleaf` | Fraction of broadleaf trees. |

Open fields still get scattered lone trees (`MEADOW_TREES` in `track/forest.ts`), and a sparser band of distant trees continues on the far slopes (`FAR_DENSITY`).

**Current setup:** mostly open fields with a few forest sections.

| Track | Settings | Wooded | Trees |
|---|---|---|---|
| Eifel | `meadowAmount` 0.82 | about 13% of the roadside | ~16k (was 84k) |
| Spa | `meadowAmount` 0.85, seed 77 | about 10% of the roadside, 14% of the land | ~15k (was 96k) |
| Nordschleife | `meadowAmount` 0.9, density 55 | sparse; three times the track length of Spa | ~32k |

**Shadows are the other big cost.** The shadow quality setting is None / Low / Medium / High, with shadow maps off, 1024, 2048 and 4096. The default is **Medium**.
- Change it on the home screen (click it, G, or gamepad Y), or with G while paused.
- It's stored in `localStorage` under `drivee.settings`.
- On an Intel Iris Xe, High (the old fixed setting) cost 2–3× the frame rate of Medium.

**The near terrain is drawn in tiles** of 128 × 128 grid cells, so only the tiles in view are drawn. Physics still uses one heightfield for the whole grid. Tile normals come straight from the height grid, so no seams show between tiles.

## Licences and credits

- **Layout:** © OpenStreetMap contributors, under the [ODbL](https://opendatacommons.org/licenses/odbl/). Attribution is required, and is stored in `meta.credits` and shown on the home screen card. Derived data (our control points) stays under ODbL.
- **Elevation:** SRTM (NASA, public domain), served by [OpenTopoData](https://www.opentopodata.org/).

## Adding another real circuit

Copy `tools/tracks/nordschleife/build.mjs` (it uses the shared `lib.mjs`) and change:
- the bounding box,
- the excluded way names,
- the first section (where the loop and lap start),
- the length check,
- the output id and name, and `meta.credits`.

Check that the chained loop length matches the official length. The track must still pass the autopilot lap test.
