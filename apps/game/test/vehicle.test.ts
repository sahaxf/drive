import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { neutralInput, parseCarSpec, type CarSpec, type InputState } from '@drivee/shared';
import { addStaticBoxes, createWorld, initPhysics, PHYSICS_DT } from '../src/physics/PhysicsWorld';
import { Vehicle } from '../src/vehicle/Vehicle';

const carPath = fileURLToPath(new URL('../../../public/cars/strada-gt/car.json', import.meta.url));
let spec: CarSpec;

beforeAll(async () => {
  await initPhysics();
  spec = parseCarSpec(JSON.parse(readFileSync(carPath, 'utf8')));
});

function setup(overrides?: (s: CarSpec) => void) {
  const s: CarSpec = structuredClone(spec);
  overrides?.(s);
  const world = createWorld();
  addStaticBoxes(world, [
    { position: [0, -0.5, 0], halfExtents: [3000, 0.5, 3000], friction: 0.9 },
  ]);
  const car = new Vehicle(world, s, new Vector3(0, 0.6, 0));
  const run = (seconds: number, input: Partial<InputState>) => {
    const full = { ...neutralInput(), ...input };
    for (let t = 0; t < seconds; t += PHYSICS_DT) {
      car.step(full, PHYSICS_DT);
      world.step();
    }
  };
  return { world, car, run };
}

function upright(car: Vehicle): number {
  const r = car.body.rotation();
  return new Vector3(0, 1, 0).applyQuaternion({ x: r.x, y: r.y, z: r.z, w: r.w } as never).y;
}

function heading(car: Vehicle): number {
  const r = car.body.rotation();
  const f = new Vector3(0, 0, 1).applyQuaternion({ x: r.x, y: r.y, z: r.z, w: r.w } as never);
  return Math.atan2(f.x, f.z);
}

describe('Vehicle', () => {
  it('settles on its suspension and stays still', () => {
    const { car, run } = setup();
    run(3, {});
    const y = car.body.translation().y;
    run(3, {});
    expect(car.telemetry.speed).toBeLessThan(0.05);
    expect(Math.abs(car.body.translation().y - y)).toBeLessThan(0.005);
    expect(car.wheels.every((w) => w.grounded)).toBe(true);
    expect(upright(car)).toBeGreaterThan(0.999);
  });

  it('accelerates hard and shifts up', () => {
    const { car, run } = setup();
    run(1, {});
    run(4, { throttle: 1 });
    const kmh4 = car.telemetry.forwardSpeed * 3.6;
    run(6, { throttle: 1 });
    const kmh10 = car.telemetry.forwardSpeed * 3.6;
    // 0-100 in roughly 4-5 s for a 330 kW-ish GT car.
    expect(kmh4).toBeGreaterThan(80);
    expect(kmh4).toBeLessThan(140);
    expect(kmh10).toBeGreaterThan(170);
    expect(car.telemetry.gear).toBeGreaterThanOrEqual(3);
    expect(upright(car)).toBeGreaterThan(0.98);
    expect(Math.abs(car.body.translation().x)).toBeLessThan(1.5);
  });

  it('tops out at a plausible speed', () => {
    const { car, run } = setup();
    run(60, { throttle: 1 });
    const kmh = car.telemetry.forwardSpeed * 3.6;
    expect(kmh).toBeGreaterThan(260);
    expect(kmh).toBeLessThan(340);
  });

  it('brakes from 100 km/h in a realistic distance', () => {
    const { car, run } = setup();
    run(1, {});
    while (car.telemetry.forwardSpeed < 100 / 3.6) run(0.05, { throttle: 1 });
    const start = car.body.translation().z;
    while (car.telemetry.forwardSpeed > 0.3) run(0.05, { brake: 1 });
    const distance = car.body.translation().z - start;
    // Arcade-grip tyres (~1.7 g) stop shorter than a real performance car (~33-38 m).
    expect(distance).toBeGreaterThan(18);
    expect(distance).toBeLessThan(32);
    expect(upright(car)).toBeGreaterThan(0.98);
  });

  it('turns right for positive steer and stays upright through a hard corner', () => {
    const { car, run } = setup();
    run(1, {});
    while (car.telemetry.forwardSpeed < 80 / 3.6) run(0.05, { throttle: 1 });
    const before = heading(car);
    run(3, { throttle: 0.4, steer: 1 });
    const turned = heading(car) - before;
    // Heading is atan2(x, z): turning right (toward -X) decreases it.
    expect(turned).toBeLessThan(-0.6);
    expect(upright(car)).toBeGreaterThan(0.9);
    expect(car.wheels.filter((w) => w.grounded).length).toBeGreaterThanOrEqual(3);
  });

  it('reverses when brake is held at a standstill', () => {
    const { car, run } = setup();
    run(1, {});
    run(3, { brake: 1 });
    expect(car.telemetry.gear).toBe(-1);
    expect(car.telemetry.forwardSpeed).toBeLessThan(-2);
    run(2, { throttle: 1 });
    run(2, { throttle: 1 });
    expect(car.telemetry.gear).toBe(1);
    expect(car.telemetry.forwardSpeed).toBeGreaterThan(2);
  });

  it('spins the rear wheels on launch without traction control', () => {
    const { car, run } = setup((s) => {
      s.assists.tractionControl = false;
      // The stock tyres out-grip the engine; on road-car grip the rears can still be lit up.
      s.tyres.rear.grip = 1.1;
    });
    run(1, {});
    let spun = false;
    for (let k = 0; k < 20; k++) {
      run(0.05, { throttle: 1 });
      spun ||= car.telemetry.wheelspin;
    }
    expect(spun).toBe(true);
  });

  it('handbrake makes the rear step out', () => {
    const { car, run } = setup();
    run(1, {});
    while (car.telemetry.forwardSpeed < 70 / 3.6) run(0.05, { throttle: 1 });
    run(0.3, { steer: 0.6, throttle: 0.2 });
    run(0.6, { steer: 0.6, handbrake: true });
    const lv = car.body.linvel();
    const r = car.body.rotation();
    const left = new Vector3(1, 0, 0).applyQuaternion({ x: r.x, y: r.y, z: r.z, w: r.w } as never);
    const sideways = Math.abs(lv.x * left.x + lv.y * left.y + lv.z * left.z);
    expect(sideways).toBeGreaterThan(2);
    expect(upright(car)).toBeGreaterThan(0.9);
  });
  it('straightens up by itself when the steering is centred mid-corner at speed', () => {
    for (const steer of [0.6, 1]) {
      const { car, run } = setup();
      run(1, {});
      while (car.telemetry.speed < 28) run(0.1, { throttle: 1 });
      run(1, { steer, throttle: 0.4 });
      run(0.6, { steer: 0, throttle: 0.4 });
      expect(Math.abs(car.body.angvel().y)).toBeLessThan(0.04); // under ~2°/s: driving straight again
    }
  });
});
