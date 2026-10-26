import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { CameraRig } from '../src/camera/CameraRig';

describe('CameraRig chase', () => {
  it('drops back a little as the car pulls away, then holds a fixed distance at any speed', () => {
    const camera = new PerspectiveCamera();
    const rig = new CameraRig(camera);
    const car = new Vector3();
    const heading = new Quaternion();
    const dt = 1 / 60;
    const distance = () => Math.hypot(camera.position.x - car.x, camera.position.z - car.z);

    rig.update(dt, car, heading, 0);
    const atRest = distance();

    // Accelerate at 7 m/s² up to ~250 km/h, logging distance each second.
    const samples: number[] = [];
    let speed = 0;
    for (let t = 0; t < 12; t += dt) {
      speed = Math.min(speed + 7 * dt, 70);
      car.z += speed * dt;
      rig.update(dt, car, heading, speed);
      if (Math.abs(t % 1) < dt) samples.push(distance());
    }

    expect(atRest).toBeCloseTo(4.6, 2);
    // It does lag behind once moving...
    expect(samples[2]!).toBeGreaterThan(atRest + 0.3);
    // ...but never by more than the cap, and it settles: the last seconds are flat.
    expect(Math.max(...samples)).toBeLessThanOrEqual(atRest + 1.2 + 1e-6);
    const last = samples.slice(-4);
    expect(Math.max(...last) - Math.min(...last)).toBeLessThan(0.01);
  });
});
