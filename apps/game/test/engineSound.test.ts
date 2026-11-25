import { describe, expect, it } from 'vitest';
import { engineTone } from '../src/audio/EngineSound';

const ENGINE = { idleRpm: 900, redlineRpm: 7800, cylinders: 6 };

describe('engine tone', () => {
  it('pitches to the exhaust pulse rate: cylinders / 2 per revolution', () => {
    expect(engineTone(ENGINE, 6000, 0).frequency).toBeCloseTo(300);
    expect(engineTone({ ...ENGINE, cylinders: 4 }, 6000, 0).frequency).toBeCloseTo(200);
  });

  it('gets louder with revs and load, never past full', () => {
    const idle = engineTone(ENGINE, 900, 0);
    const revving = engineTone(ENGINE, 6000, 0);
    const loaded = engineTone(ENGINE, 6000, 1);
    expect(revving.level).toBeGreaterThan(idle.level);
    expect(loaded.level).toBeGreaterThan(revving.level);
    expect(engineTone(ENGINE, 9000, 1).level).toBeLessThanOrEqual(1);
    expect(idle.level).toBeGreaterThan(0);
  });

  it('keeps the crank orders and some rasp in the note at speed, so it never thins to a hum', () => {
    const cruising = engineTone(ENGINE, 6000, 0);
    // A six fires three times per turn of the crank.
    expect(cruising.crankFrequency).toBeCloseTo(cruising.frequency / 3);
    // Off the throttle at least five harmonics of the pulse still pass the filter.
    expect(cruising.cutoff).toBeGreaterThan(cruising.frequency * 5);
    expect(cruising.drive).toBeGreaterThan(1);
    expect(cruising.rasp).toBeGreaterThan(engineTone(ENGINE, 900, 0).rasp);
    expect(engineTone(ENGINE, 6000, 1).rasp).toBeGreaterThan(cruising.rasp);
    expect(engineTone(ENGINE, 9000, 1).rasp).toBeLessThanOrEqual(1);
  });

  it('sounds brighter and harsher under load than on the overrun', () => {
    const overrun = engineTone(ENGINE, 6000, 0);
    const loaded = engineTone(ENGINE, 6000, 1);
    expect(loaded.cutoff).toBeGreaterThan(overrun.cutoff * 2);
    expect(loaded.drive).toBeGreaterThan(overrun.drive);
  });
});
