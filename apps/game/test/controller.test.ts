import { describe, expect, it } from 'vitest';
import {
  angleDiffDeg,
  Button,
  decodeInput,
  DEFAULT_STEERING,
  encodeInput,
  INPUT_PACKET_BYTES,
  isNewerSeq,
  isRoomCode,
  OneEuroFilter,
  shapeSteering,
  wheelAngleDeg,
} from '@drivee/shared';
import { pedalValue, PEDAL_MIN } from '../src/controller/pedal';
import { HapticsDirector } from '../src/input/haptics';

describe('input packet', () => {
  it('round-trips with 8 bytes and keeps handbrake separate from buttons', () => {
    const buffer = encodeInput(
      { steer: -0.42, throttle: 0.8, brake: 0.1, handbrake: true, buttons: Button.Camera | Button.Pause },
      65535,
    );
    expect(buffer.byteLength).toBe(INPUT_PACKET_BYTES);
    const decoded = decodeInput(buffer)!;
    expect(decoded.seq).toBe(65535);
    expect(decoded.input.steer).toBeCloseTo(-0.42, 4);
    expect(decoded.input.throttle).toBeCloseTo(0.8, 2);
    expect(decoded.input.brake).toBeCloseTo(0.1, 2);
    expect(decoded.input.handbrake).toBe(true);
    expect(decoded.input.buttons).toBe(Button.Camera | Button.Pause);
  });

  it('clamps out-of-range values and rejects foreign packets', () => {
    const decoded = decodeInput(encodeInput({ steer: 3, throttle: -1, brake: 2, handbrake: false, buttons: 0 }, 0))!;
    expect(decoded.input.steer).toBe(1);
    expect(decoded.input.throttle).toBe(0);
    expect(decoded.input.brake).toBe(1);
    expect(decodeInput(new ArrayBuffer(4))).toBeNull();
    const wrongVersion = encodeInput({ steer: 0, throttle: 0, brake: 0, handbrake: false, buttons: 0 }, 0);
    new DataView(wrongVersion).setUint8(0, 99);
    expect(decodeInput(wrongVersion)).toBeNull();
  });

  it('orders sequence numbers across the 16-bit wrap', () => {
    expect(isNewerSeq(1, 0)).toBe(true);
    expect(isNewerSeq(0, 65535)).toBe(true);
    expect(isNewerSeq(65535, 0)).toBe(false);
    expect(isNewerSeq(5, 5)).toBe(false);
  });

  it('validates room codes', () => {
    expect(isRoomCode('AB2C')).toBe(true);
    expect(isRoomCode('ABO1')).toBe(false); // look-alikes excluded
    expect(isRoomCode('ABC')).toBe(false);
  });
});

describe('tilt steering', () => {
  const g = 9.81;
  /** Gravity in device coordinates for a phone in landscape-primary turned `deg` clockwise. */
  const landscapeTurned = (deg: number) => {
    const r = (deg * Math.PI) / 180;
    // Landscape-primary: the device's +x points up the screen, +y points left.
    return { gx: g * Math.cos(r), gy: g * Math.sin(r) };
  };

  it('reads clockwise turns as positive in both landscape orientations', () => {
    const right = landscapeTurned(20);
    expect(wheelAngleDeg(right.gx, right.gy, 90)).toBeCloseTo(20, 6);
    const left = landscapeTurned(-15);
    expect(wheelAngleDeg(left.gx, left.gy, 90)).toBeCloseTo(-15, 6);
    // Landscape-secondary is the same hold rotated 180°: every device axis flips.
    expect(wheelAngleDeg(-right.gx, -right.gy, 270)).toBeCloseTo(20, 6);
  });

  it('is unaffected by how far the phone is tipped back', () => {
    const turned = landscapeTurned(25);
    const tippedBack = 0.4; // ~66° back: only part of gravity stays in the screen plane
    expect(wheelAngleDeg(turned.gx * tippedBack, turned.gy * tippedBack, 90)).toBeCloseTo(25, 6);
  });

  it('gives up when the phone lies flat', () => {
    expect(wheelAngleDeg(0.3, 0.2, 90)).toBeNull();
  });

  it('wraps angle differences', () => {
    expect(angleDiffDeg(170, -170)).toBeCloseTo(-20);
    expect(angleDiffDeg(-170, 170)).toBeCloseTo(20);
  });

  it('applies deadzone, lock and curve', () => {
    const cfg = DEFAULT_STEERING;
    expect(shapeSteering(1.5, cfg)).toBe(0);
    expect(shapeSteering(cfg.maxLockDeg, cfg)).toBeCloseTo(1);
    expect(shapeSteering(80, cfg)).toBe(1);
    expect(shapeSteering(-80, cfg)).toBe(-1);
    const half = (cfg.deadzoneDeg + cfg.maxLockDeg) / 2;
    const linear = shapeSteering(half, { ...cfg, curve: 0 });
    expect(linear).toBeCloseTo(0.5);
    // The curve makes small inputs finer.
    expect(shapeSteering(half, cfg)).toBeLessThan(linear);
    // Continuous at the deadzone edge.
    expect(shapeSteering(cfg.deadzoneDeg + 0.01, cfg)).toBeLessThan(0.01);
  });

  it('one-euro filter smooths jitter at rest but follows a fast turn', () => {
    const dt = 1 / 60;
    const still = new OneEuroFilter();
    let maxDeviation = 0;
    for (let i = 0; i < 240; i++) {
      const noise = (i % 2 === 0 ? 1 : -1) * 0.5;
      if (i > 60) maxDeviation = Math.max(maxDeviation, Math.abs(still.filter(10 + noise, dt) - 10));
      else still.filter(10 + noise, dt);
    }
    expect(maxDeviation).toBeLessThan(0.2);

    const fast = new OneEuroFilter();
    fast.filter(0, dt);
    let value = 0;
    // A 30° turn in 0.2 s, then held.
    for (let i = 1; i <= 12; i++) value = fast.filter(Math.min(i / 12, 1) * 30, dt);
    for (let i = 0; i < 6; i++) value = fast.filter(30, dt);
    expect(value).toBeGreaterThan(27);
  });
});

describe('pedal zones', () => {
  it('maps finger height to pedal travel', () => {
    expect(pedalValue(1)).toBe(PEDAL_MIN);
    expect(pedalValue(0.95)).toBe(PEDAL_MIN);
    expect(pedalValue(0)).toBe(1);
    expect(pedalValue(0.3)).toBe(1);
    const mid = pedalValue(0.6);
    expect(mid).toBeGreaterThan(PEDAL_MIN);
    expect(mid).toBeLessThan(1);
  });
});

describe('haptics', () => {
  const quiet = { onKerb: false, speed: 20, impact: 0, atLimiter: false };

  it('buzzes harder for harder hits and stays quiet for normal driving', () => {
    const h = new HapticsDirector();
    expect(h.update({ ...quiet, impact: 0.3 }, 1 / 60)).toBeNull();
    const small = new HapticsDirector().update({ ...quiet, impact: 1 }, 1 / 60)!;
    const big = new HapticsDirector().update({ ...quiet, impact: 8 }, 1 / 60)!;
    expect(big[0]!).toBeGreaterThan(small[0]!);
    expect(big[0]!).toBeLessThanOrEqual(300);
  });

  it('rumbles on kerbs at a limited rate', () => {
    const h = new HapticsDirector();
    let pulses = 0;
    for (let i = 0; i < 60; i++) if (h.update({ ...quiet, onKerb: true }, 1 / 60)) pulses++;
    expect(pulses).toBeGreaterThanOrEqual(6);
    expect(pulses).toBeLessThanOrEqual(8);
    // Not when crawling over one.
    expect(new HapticsDirector().update({ ...quiet, onKerb: true, speed: 1 }, 1 / 60)).toBeNull();
  });

  it('lets an impact buzz finish before kerb pulses resume', () => {
    const h = new HapticsDirector();
    expect(h.update({ ...quiet, impact: 3, onKerb: true }, 1 / 60)).not.toBeNull();
    expect(h.update({ ...quiet, onKerb: true }, 0.1)).toBeNull();
    expect(h.update({ ...quiet, onKerb: true }, 0.25)).not.toBeNull();
  });
});
