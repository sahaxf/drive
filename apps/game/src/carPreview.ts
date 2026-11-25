import './style.css';
import { Mesh, MeshStandardMaterial, PlaneGeometry, Quaternion, Vector3 } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { cameraMounts } from './camera/CameraRig';
import { loadCarModel } from './render/carModel';
import { CarView, restHubY } from './render/CarView';
import { Renderer } from './render/Renderer';
import { loadCarSpec } from './tracks';

/**
 * Dev-only turntable for working on the car's looks (`/car.html`, not part of the build).
 * Drag to orbit. `?view=front|side|rear|three|top` holds a fixed camera for screenshots;
 * `?view=cabin` looks out from the driver's seat (the windshield camera).
 */
const VIEWS: Record<string, [number, number, number]> = {
  three: [4.2, 1.6, 4.6],
  front: [0, 0.9, 6.5],
  side: [6.5, 0.8, 0],
  rear: [0, 1.2, -6.5],
  rearThree: [-4.2, 1.8, -4.8],
  top: [0, 7, 0.01],
  wheel: [2.1, 0.42, 1.8],
};
/** Where each view looks; the car's centre unless listed. */
const TARGETS: Record<string, [number, number, number]> = { wheel: [0.8, 0.35, 1.35] };

async function preview(): Promise<void> {
  const spec = await loadCarSpec(new URLSearchParams(location.search).get('car') ?? 'strada-gt');
  const renderer = new Renderer(document.getElementById('viewport')!);
  const ground = new Mesh(new PlaneGeometry(200, 200), new MeshStandardMaterial({ color: '#3a3b3e', roughness: 0.9 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  renderer.scene.add(ground);

  const car = new CarView(spec, await loadCarModel(spec));
  renderer.scene.add(car.root);
  // Body height that puts the tyres on the ground at rest.
  const position = new Vector3(0, spec.wheels.radius - (restHubY(spec, true) + restHubY(spec, false)) / 2, 0);
  renderer.setShadowFocus(position);

  const viewName = new URLSearchParams(location.search).get('view') ?? '';
  const cabin = viewName === 'cabin';
  const [eyeX, eyeY, eyeZ] = cameraMounts(spec).windshield;
  // The driver's eye, and a point just ahead of it to orbit about: drag to look round the cabin.
  const view = cabin ? ([eyeX, position.y + eyeY, eyeZ] as [number, number, number]) : VIEWS[viewName];
  const controls = new OrbitControls(renderer.camera, renderer.webgl.domElement);
  controls.target.set(...(cabin ? ([eyeX, position.y + eyeY - 0.003, eyeZ + 0.05] as const) : (TARGETS[viewName] ?? [0, 0.5, 0])));
  renderer.camera.position.set(...(view ?? VIEWS.three!));
  car.setInteriorView(cabin);
  if (import.meta.env.DEV) Object.assign(window, { __preview: { car, renderer, spec, controls } });
  controls.autoRotate = !view;
  controls.autoRotateSpeed = 0.8;
  controls.update();

  const wheels = (['FL', 'FR', 'RL', 'RR'] as const).map((id) => {
    const front = id.startsWith('F');
    const track = front ? spec.wheels.trackFront : spec.wheels.trackRear;
    return {
      id,
      front,
      mount: new Vector3((id.endsWith('L') ? 1 : -1) * (track / 2), spec.wheels.mountY, front ? spec.wheels.frontAxleZ : spec.wheels.rearAxleZ),
      length: spec.wheels.mountY - restHubY(spec, front),
      steerAngle: 0,
      spinAngle: 0,
    };
  });

  const start = performance.now();
  const frame = () => {
    const t = view && !cabin ? 0 : (performance.now() - start) / 1000;
    for (const w of wheels) {
      w.steerAngle = w.front ? Math.sin(t * 0.7) * 0.45 : 0;
      w.spinAngle = t * 3;
    }
    car.update(position, new Quaternion(), wheels, Math.floor(t) % 4 === 1, Math.floor(t) % 4 === 3);
    controls.update();
    renderer.render();
    requestAnimationFrame(frame);
  };
  frame();
}

void preview();
