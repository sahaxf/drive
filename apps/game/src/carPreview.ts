import './style.css';
import { Mesh, MeshStandardMaterial, PlaneGeometry, Quaternion, Vector3 } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CarView, restHubY } from './render/CarView';
import { Renderer } from './render/Renderer';
import { loadCarSpec } from './tracks';

/**
 * Dev-only turntable for working on the car's looks (`/car.html`, not part of the build).
 * Drag to orbit. `?view=front|side|rear|three|top` holds a fixed camera for screenshots.
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

  const car = new CarView(spec);
  renderer.scene.add(car.root);
  // Body height that puts the tyres on the ground at rest.
  const position = new Vector3(0, spec.wheels.radius - (restHubY(spec, true) + restHubY(spec, false)) / 2, 0);
  renderer.setShadowFocus(position);

  const viewName = new URLSearchParams(location.search).get('view') ?? '';
  const view = VIEWS[viewName];
  const controls = new OrbitControls(renderer.camera, renderer.webgl.domElement);
  controls.target.set(...(TARGETS[viewName] ?? [0, 0.5, 0]));
  renderer.camera.position.set(...(view ?? VIEWS.three!));
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
    const t = view ? 0 : (performance.now() - start) / 1000;
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
