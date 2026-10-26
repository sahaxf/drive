import { describe, expect, it } from 'vitest';
import { sampleTorqueCurve } from '../src/vehicle/drivetrain';
import { computeTyreForce, magicFormula, type TyreForceInput } from '../src/vehicle/tyre';

describe('sampleTorqueCurve', () => {
  const curve: Array<[number, number]> = [
    [1000, 200],
    [3000, 400],
    [6000, 300],
  ];

  it('interpolates between points and clamps at the ends', () => {
    expect(sampleTorqueCurve(curve, 500)).toBe(200);
    expect(sampleTorqueCurve(curve, 2000)).toBe(300);
    expect(sampleTorqueCurve(curve, 4500)).toBe(350);
    expect(sampleTorqueCurve(curve, 9000)).toBe(300);
  });
});

describe('magicFormula', () => {
  it('is odd, peaks near 1, then falls off', () => {
    const at = (s: number) => magicFormula(s, 10, 1.9, 0.97);
    expect(at(-0.1)).toBeCloseTo(-at(0.1));
    let peak = 0;
    for (let s = 0; s < 1; s += 0.005) peak = Math.max(peak, at(s));
    expect(peak).toBeGreaterThan(0.99);
    expect(at(0.6)).toBeLessThan(peak);
  });
});

describe('computeTyreForce', () => {
  const base: TyreForceInput = {
    tyre: {
      grip: 1.1,
      lateralB: 10,
      lateralC: 1.9,
      lateralE: 0.97,
      loadSensitivity: 0,
      slidingGrip: 0.8,
      rollingResistance: 0,
    },
    load: 4000,
    nominalLoad: 4000,
    vLong: 20,
    vLat: 0,
    driveForce: 0,
    brakeForce: 0,
    massShare: 400,
    dt: 1 / 120,
    tractionControl: false,
    abs: false,
    handbrake: false,
  };

  it('opposes sideways motion', () => {
    expect(computeTyreForce({ ...base, vLat: 2 }).fy).toBeLessThan(0);
    expect(computeTyreForce({ ...base, vLat: -2 }).fy).toBeGreaterThan(0);
  });

  it('never exceeds the friction circle', () => {
    const r = computeTyreForce({ ...base, vLat: 3, driveForce: 3000 });
    expect(Math.hypot(r.fx, r.fy)).toBeLessThanOrEqual(1.1 * 4000 + 1e-6);
  });

  it('spins up when drive exceeds grip, unless traction control intervenes', () => {
    const spin = computeTyreForce({ ...base, driveForce: 9000 });
    expect(spin.spinning).toBe(true);
    expect(spin.unusedDrive).toBeGreaterThan(0);
    const tc = computeTyreForce({ ...base, driveForce: 9000, tractionControl: true });
    expect(tc.spinning).toBe(false);
    expect(tc.fx).toBeCloseTo(4400);
  });

  it('locks without ABS and keeps steering with ABS', () => {
    const locked = computeTyreForce({ ...base, vLat: 2, brakeForce: 20000 });
    expect(locked.locked).toBe(true);
    const abs = computeTyreForce({ ...base, vLat: 2, brakeForce: 20000, abs: true });
    expect(abs.locked).toBe(false);
    expect(abs.fx).toBeLessThan(0);
    expect(Math.abs(abs.fy)).toBeGreaterThan(0);
  });

  it('does not push a stationary car backwards when braking', () => {
    const r = computeTyreForce({ ...base, vLong: 0, brakeForce: 5000 });
    expect(r.fx).toBe(0);
  });
});
