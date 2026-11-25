import { Mesh, MeshStandardMaterial, PlaneGeometry, Quaternion, Vector3 } from 'three';
import type { CarSpec } from '@drivee/shared';
import { loadCarModel } from './carModel';
import { CarView, restHubY } from './CarView';
import { Renderer } from './Renderer';

const SIZE = [640, 360] as const;
/** Front three-quarter view: where the camera sits and what it looks at, car-local, m. */
const CAMERA = { position: [4.4, 1.5, 5] as const, target: [0, 0.4, 0.1] as const, fov: 21 };
// Bump to throw away stills cached by an older version of this file.
const CACHE_VERSION = 2;
/** Brighter than the game's dusk, so the car reads at thumbnail size. */
const EXPOSURE = 1.1;

/**
 * A still of each car for the selection screen, as JPEG data URLs: parked on a plain floor
 * under the game's own lighting, seen from the front three-quarter. Rendered offscreen
 * with one renderer, which is then freed; each still is handed to `onStill` as soon as it
 * is ready and cached in localStorage per car.
 */
export async function carStills(cars: CarSpec[], onStill: (carId: string, url: string) => void): Promise<void> {
  const missing: CarSpec[] = [];
  for (const car of cars) {
    const cached = readCache(car.id);
    if (cached) onStill(car.id, cached);
    else missing.push(car);
  }
  if (missing.length === 0) return;

  // Offscreen but laid out, so the renderer reads a real size from it.
  const container = document.createElement('div');
  container.style.cssText = `position:fixed;left:-99999px;top:0;width:${SIZE[0]}px;height:${SIZE[1]}px;pointer-events:none`;
  document.body.appendChild(container);
  const renderer = new Renderer(container, 'high');
  try {
    const floor = new Mesh(new PlaneGeometry(400, 400), new MeshStandardMaterial({ color: '#3a3b3e', roughness: 0.9 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    renderer.scene.add(floor);
    renderer.webgl.toneMappingExposure = EXPOSURE;
    const camera = renderer.camera;
    camera.fov = CAMERA.fov;
    camera.updateProjectionMatrix();
    camera.position.set(...CAMERA.position);
    camera.lookAt(...CAMERA.target);

    for (const spec of missing) {
      const view = new CarView(spec, await loadCarModel(spec));
      renderer.scene.add(view.root);
      // Body height that puts the tyres on the floor at rest.
      const position = new Vector3(0, spec.wheels.radius - (restHubY(spec, true) + restHubY(spec, false)) / 2, 0);
      view.update(position, new Quaternion(), restingWheels(spec), false, false);
      renderer.setShadowFocus(position);
      renderer.render();
      // Read straight after drawing, before the browser can clear the buffer.
      const url = renderer.webgl.domElement.toDataURL('image/jpeg', 0.86);
      renderer.scene.remove(view.root);
      writeCache(spec.id, url);
      onStill(spec.id, url);
      // Give the page a frame between renders.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  } finally {
    renderer.dispose();
    container.remove();
  }
}

/** Wheels at rest, fronts turned a little towards the camera. */
function restingWheels(spec: CarSpec) {
  return (['FL', 'FR', 'RL', 'RR'] as const).map((id) => {
    const front = id.startsWith('F');
    const track = front ? spec.wheels.trackFront : spec.wheels.trackRear;
    return {
      id,
      mount: new Vector3((id.endsWith('L') ? 1 : -1) * (track / 2), spec.wheels.mountY, front ? spec.wheels.frontAxleZ : spec.wheels.rearAxleZ),
      length: spec.wheels.mountY - restHubY(spec, front),
      steerAngle: front ? 0.3 : 0,
      spinAngle: 0,
    };
  });
}

function key(carId: string): string {
  return `drivee.carStill.v${CACHE_VERSION}.${carId}`;
}

function readCache(carId: string): string | null {
  try {
    const value = localStorage.getItem(key(carId));
    return value?.startsWith('data:image/') ? value : null;
  } catch {
    return null;
  }
}

function writeCache(carId: string, url: string): void {
  try {
    localStorage.setItem(key(carId), url);
  } catch {
    // Too big or private mode: it's rendered again next time.
  }
}
