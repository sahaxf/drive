import { Quaternion, Vector3 } from 'three';
import type { CarSpec, TrackSpec } from '@drivee/shared';
import { generateTrack } from '../track/generateTrack';
import type { TrackSpline } from '../track/TrackSpline';
import { loadCarModel } from './carModel';
import { CarView, restHubY } from './CarView';
import { Renderer } from './Renderer';
import { buildTrackScene } from './track/buildTrackScene';

const SIZE = [1920, 1080] as const;
/** Grid slot the car sits in: metres behind the start line (as in the game). */
const GRID_OFFSET = 15;
/** Corners pictured besides the grid, sharpest first. */
const CORNER_SHOTS = 3;
/** Car is placed this far before a corner's apex, on its way in, m. */
const CORNER_ENTRY = 18;
/** Where the car lands across the picture (0 left, 1 right), clear of the title panel. */
const CAR_SCREEN_X = 0.68;
// Bump to throw away stills cached by an older version of this file.
const CACHE_VERSION = 3;

/**
 * A drone position relative to the car, m: `back` along its heading (negative is ahead),
 * `out` towards the outside of the corner (to the car's right on the grid), and `up`.
 */
interface Drone {
  back: number;
  out: number;
  up: number;
  fov: number;
}

/** Grid: behind and above, looking down the straight. */
const GRID_DRONE: Drone = { back: 30, out: 16, up: 26, fov: 48 };
/** One per corner, in turn: from the outside, from ahead looking back, and nearly overhead. */
const CORNER_DRONES: Drone[] = [
  { back: 12, out: 34, up: 28, fov: 50 },
  { back: -30, out: 12, up: 22, fov: 46 },
  { back: 14, out: 8, up: 58, fov: 44 },
];

interface Shot {
  /** Distance along the track where the car sits, m. */
  distance: number;
  /** +1 for a right-hander, -1 for a left (the grid counts as a left: drone on the car's right). */
  turn: number;
  drone: Drone;
}

/**
 * Aerial stills of the track with the car on it, as JPEG data URLs: the car on the grid
 * first, then at the track's sharpest corners from varied angles. Rendered offscreen with
 * the game's own renderer, which is then freed. Each still is handed to `onShot` as soon
 * as it's ready, since generating the track takes a moment; they're cached in localStorage
 * per track and car.
 */
export async function heroShots(track: TrackSpec, car: CarSpec, onShot: (url: string) => void): Promise<void> {
  const key = `drivee.hero.v${CACHE_VERSION}.${track.meta.id}.${car.id}`;
  const cached = readCache(key);
  if (cached) {
    cached.forEach(onShot);
    return;
  }
  const shots: string[] = [];
  await renderHeroShots(track, car, (url) => {
    shots.push(url);
    onShot(url);
  });
  writeCache(key, shots);
}

async function renderHeroShots(trackSpec: TrackSpec, carSpec: CarSpec, onShot: (url: string) => void): Promise<void> {
  const [model, track] = await Promise.all([
    loadCarModel(carSpec),
    // Let the page paint between generation steps.
    generateTrack(trackSpec, () => nextFrame()),
  ]);

  // Offscreen but laid out, so the renderer reads a real size from it.
  const container = document.createElement('div');
  container.style.cssText = `position:fixed;left:-99999px;top:0;width:${SIZE[0]}px;height:${SIZE[1]}px;pointer-events:none`;
  document.body.appendChild(container);
  const renderer = new Renderer(container, 'high');
  try {
    const env = trackSpec.environment;
    renderer.setFog(env.fogNear, env.fogFar);
    renderer.scene.add(buildTrackScene(track, renderer.maxAnisotropy));
    const view = new CarView(carSpec, model);
    renderer.scene.add(view.root);
    const hubY = (restHubY(carSpec, true) + restHubY(carSpec, false)) / 2;
    const camera = renderer.camera;

    const start = trackSpec.race.startDistance;
    const shots: Shot[] = [
      { distance: start - GRID_OFFSET, turn: -1, drone: GRID_DRONE },
      ...sharpestCorners(track.spline, start, CORNER_SHOTS).map((corner, i) => ({
        distance: corner.distance - CORNER_ENTRY,
        turn: corner.turn,
        drone: CORNER_DRONES[i % CORNER_DRONES.length]!,
      })),
    ];

    for (const shot of shots) {
      // The car on the centreline, at rest, facing the racing direction, steering into the corner.
      const frame = track.spline.frameAt(shot.distance);
      const position = frame.position.clone().addScaledVector(frame.up, carSpec.wheels.radius - hubY);
      const heading = new Vector3(frame.tangent.x, 0, frame.tangent.z).normalize();
      const rotation = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), heading);
      // Positive steer turns the wheels to the car's left.
      const steer = shot.drone === GRID_DRONE ? 0 : -0.14 * shot.turn;
      view.update(position, rotation, restingWheels(carSpec, steer), false, false);
      renderer.setShadowFocus(position);

      // Outside of a right-hander is the car's left, and the other way round.
      const outside = new Vector3(frame.right.x, 0, frame.right.z).normalize().multiplyScalar(-shot.turn);
      const { back, out, up, fov } = shot.drone;
      camera.fov = fov;
      camera.updateProjectionMatrix();
      camera.position
        .copy(position)
        .addScaledVector(heading, -back)
        .addScaledVector(outside, out)
        .add(new Vector3(0, up, 0));
      // Look a little past the car, then turn so it sits right of centre, clear of the panel.
      const target = position.clone().addScaledVector(heading, back >= 0 ? 6 : -4);
      camera.lookAt(target);
      const distance = camera.position.distanceTo(target);
      const halfWidth = distance * Math.tan(((camera.fov / 2) * Math.PI) / 180) * camera.aspect;
      const cameraRight = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
      camera.lookAt(target.addScaledVector(cameraRight, -(CAR_SCREEN_X - 0.5) * 2 * halfWidth));

      renderer.render();
      // Read straight after drawing, before the browser can clear the buffer.
      onShot(renderer.webgl.domElement.toDataURL('image/jpeg', 0.84));
      // Give the page a frame between renders.
      await nextFrame();
    }
  } finally {
    renderer.dispose();
    container.remove();
  }
}

/**
 * The sharpest corners, each well apart from the others and from the start line: peaks of
 * curvature with where their apex is and which way they turn.
 */
export function sharpestCorners(
  spline: Pick<TrackSpline, 'curvature' | 'step' | 'length'>,
  startDistance: number,
  count: number,
): { distance: number; turn: number }[] {
  const minGap = Math.max(150, spline.length / (count + 2));
  const gap = (a: number, b: number) => {
    const d = Math.abs(a - b) % spline.length;
    return Math.min(d, spline.length - d);
  };
  const order = Array.from(spline.curvature.keys()).sort((a, b) => Math.abs(spline.curvature[b]!) - Math.abs(spline.curvature[a]!));
  const corners: { distance: number; turn: number }[] = [];
  for (const i of order) {
    if (corners.length >= count) break;
    const k = spline.curvature[i]!;
    // Anything gentler than a 300 m radius is no corner to show off.
    if (Math.abs(k) < 1 / 300) break;
    const distance = i * spline.step;
    if (gap(distance, startDistance) < minGap / 2) continue;
    if (corners.some((c) => gap(c.distance, distance) < minGap)) continue;
    corners.push({ distance, turn: Math.sign(k) });
  }
  return corners;
}

/** Wheels at rest, fronts turned by `steer` (radians, + to the left). */
function restingWheels(spec: CarSpec, steer: number) {
  return (['FL', 'FR', 'RL', 'RR'] as const).map((id) => {
    const front = id.startsWith('F');
    const track = front ? spec.wheels.trackFront : spec.wheels.trackRear;
    return {
      id,
      mount: new Vector3((id.endsWith('L') ? 1 : -1) * (track / 2), spec.wheels.mountY, front ? spec.wheels.frontAxleZ : spec.wheels.rearAxleZ),
      length: spec.wheels.mountY - restHubY(spec, front),
      steerAngle: front ? steer : 0,
      spinAngle: 0,
    };
  });
}

function readCache(key: string): string[] | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null') as unknown;
    return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v.startsWith('data:image/'))
      ? (value as string[])
      : null;
  } catch {
    return null;
  }
}

function writeCache(key: string, shots: string[]): void {
  try {
    // One set at a time: drop those of other tracks and cars (and older versions).
    for (const k of Object.keys(localStorage)) if (k.startsWith('drivee.hero.')) localStorage.removeItem(k);
    localStorage.setItem(key, JSON.stringify(shots));
  } catch {
    // Too big or private mode: they're rendered again next time.
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
