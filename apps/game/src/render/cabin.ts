import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, TorusGeometry } from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { CarSpec } from '@drivee/shared';

export type CabinSpec = NonNullable<CarSpec['cameras']['cabin']>;

export interface Cabin {
  /** Everything the driver sees inside the car that the model doesn't have. */
  root: Group;
  /** Turns with the front wheels. */
  steeringWheel: Group;
}

/** Turns of the steering wheel per radian of front-wheel angle, and the most it turns either way. */
const STEERING_RATIO = 9;
const STEERING_LOCK = Math.PI * 0.75;
const WHEEL_RADIUS = 0.17;
/** How far the steering wheel leans back from upright, rad. */
const WHEEL_RAKE = 0.38;
/** Lowest point of the cabin furniture: below the floor of any car. */
const FLOOR = -0.45;

/**
 * The inside of a closed car, which body-shell models leave empty: a dashboard across the
 * cabin with a bulkhead down to the floor (so the nose and front suspension don't show
 * under it), an instrument binnacle and a steering wheel in front of the driver, and a
 * centre console. Sized from the car's `cabin` data; `driverX` is where the driver sits
 * across the car.
 */
export function buildCabin(cabin: CabinSpec, driverX: number): Cabin {
  const { dashTop, dashRear, dashFront, width } = cabin;
  const depth = dashFront - dashRear;
  const trim = new MeshStandardMaterial({ color: '#17181c', roughness: 0.85, envMapIntensity: 0.3 });
  const soft = new MeshStandardMaterial({ color: '#0e0f12', roughness: 0.95, envMapIntensity: 0.15 });
  const metal = new MeshStandardMaterial({ color: '#7d8188', metalness: 0.9, roughness: 0.4 });
  const screen = new MeshStandardMaterial({ color: '#05070a', emissive: '#2c4a66', emissiveIntensity: 0.6, roughness: 0.3 });
  const dial = new MeshStandardMaterial({ color: '#05070a', emissive: '#35506b', emissiveIntensity: 0.5, roughness: 0.4 });

  const root = new Group();
  root.name = 'cabin';
  const add = (mesh: Mesh, x: number, y: number, z: number) => {
    mesh.position.set(x, y, z);
    root.add(mesh);
    return mesh;
  };

  // Dashboard top: a pad from under the windscreen back to the driver, its edge rolled over.
  add(new Mesh(new RoundedBoxGeometry(width, 0.14, depth, 3, 0.05), trim), 0, dashTop - 0.07, dashRear + depth / 2);
  // Its face, down to the floor, and the bulkhead behind it.
  const faceHeight = dashTop - 0.06 - FLOOR;
  add(new Mesh(new BoxGeometry(width, faceHeight, 0.05), soft), 0, FLOOR + faceHeight / 2, dashRear + 0.07);
  add(new Mesh(new BoxGeometry(width, faceHeight, 0.05), soft), 0, FLOOR + faceHeight / 2, dashFront - 0.03);

  // Instrument binnacle: a hooded pod ahead of the driver, with two lit dials.
  add(new Mesh(new RoundedBoxGeometry(0.38, 0.09, 0.24, 3, 0.04), trim), driverX, dashTop + 0.02, dashRear + 0.15);
  for (const side of [-1, 1]) {
    const face = new Mesh(new CylinderGeometry(0.034, 0.034, 0.01, 24), dial);
    face.rotation.x = Math.PI / 2;
    add(face, driverX + side * 0.08, dashTop + 0.018, dashRear + 0.026);
  }

  // Centre console: a screen in the dashboard and a tunnel running back between the seats.
  const display = add(new Mesh(new RoundedBoxGeometry(0.26, 0.15, 0.02, 2, 0.008), screen), 0, dashTop - 0.14, dashRear + 0.04);
  display.rotation.x = -0.2;
  add(new Mesh(new RoundedBoxGeometry(0.24, 0.22, 1.2, 2, 0.04), trim), 0, dashTop - 0.42, dashRear - 0.5);

  // Steering wheel: rim, hub and three spokes, on a column into the dashboard.
  const mount = new Group();
  mount.position.set(driverX, dashTop - 0.07, dashRear - 0.1);
  mount.rotation.x = -WHEEL_RAKE;
  root.add(mount);
  const column = new Mesh(new CylinderGeometry(0.03, 0.035, 0.3, 16), soft);
  column.rotation.x = Math.PI / 2;
  column.position.z = 0.15;
  mount.add(column);
  const steeringWheel = new Group();
  mount.add(steeringWheel);
  steeringWheel.add(new Mesh(new TorusGeometry(WHEEL_RADIUS, 0.017, 12, 48), soft));
  const hub = new Mesh(new CylinderGeometry(0.05, 0.05, 0.04, 24), trim);
  hub.rotation.x = Math.PI / 2;
  steeringWheel.add(hub);
  for (const angle of [Math.PI / 2 + 0.25, -Math.PI / 2 - 0.25, Math.PI]) {
    // Each spoke runs from the hub out to the rim.
    const spoke = new Mesh(new BoxGeometry(0.032, WHEEL_RADIUS, 0.014).translate(0, WHEEL_RADIUS / 2, 0), angle === Math.PI ? trim : metal);
    spoke.rotation.z = angle;
    steeringWheel.add(spoke);
  }

  return { root, steeringWheel };
}

/** Steering wheel rotation for a front-wheel steer angle (rad, + = left). */
export function steeringWheelAngle(frontWheelAngle: number): number {
  return Math.max(-STEERING_LOCK, Math.min(STEERING_LOCK, frontWheelAngle * STEERING_RATIO));
}
