import { describe, expect, it } from 'vitest';
import { loadBestLap, saveBestLap } from '../src/race/bestLapStore';
import { formatDelta, LapTimer, REFERENCE_STEP, type LapEvent, type ReferenceLap } from '../src/race/LapTimer';
import { WrongWayDetector } from '../src/race/WrongWay';

const LENGTH = 1200;
const START = 100;
const DT = 1 / 120;

/** Drive at constant speed from `from` metres along the loop for `seconds`. */
function drive(timer: LapTimer, from: number, speed: number, seconds: number) {
  const events: LapEvent[] = [];
  let d = from;
  for (let t = 0; t < seconds - 1e-9; t += DT) {
    d = (((d + speed * DT) % LENGTH) + LENGTH) % LENGTH;
    const e = timer.update(d, DT);
    if (e) events.push(e);
  }
  return { events, at: d };
}

/** Drive at `speed` until a lap is completed. Returns the lap event and where the car is (just past the line). */
function lap(timer: LapTimer, from: number, speed: number) {
  let d = from;
  for (let step = 0; step < 1e6; step++) {
    d = (d + speed * DT) % LENGTH;
    const e = timer.update(d, DT);
    if (e?.kind === 'lap') return { lap: e, at: d };
  }
  throw new Error('no lap completed');
}

describe('sectors', () => {
  it('splits a lap into three equal sectors that add up to the lap time', () => {
    const timer = new LapTimer(LENGTH, START);
    const start = drive(timer, START - 6, 40, 0.3).at;
    const run = drive(timer, start, 40, 30.2);
    expect(run.events.map((e) => e.kind)).toEqual(['sector', 'sector', 'lap']);
    // 400 m at 40 m/s.
    expect(timer.sectors).toHaveLength(3);
    for (const s of timer.sectors) expect(s).toBeCloseTo(10, 5);
    expect(timer.sectors.reduce<number>((sum, s) => sum + s!, 0)).toBeCloseTo(timer.last!, 6);
  });

  it('takes sector boundaries from the track when given', () => {
    // One boundary 300 m past the line: two sectors, 300 m and 900 m.
    const timer = new LapTimer(LENGTH, START, null, { sectors: [START + 300] });
    const start = drive(timer, START - 6, 30, 0.4).at;
    drive(timer, start, 30, 40.2);
    expect(timer.sectors).toHaveLength(2);
    expect(timer.sectors[0]).toBeCloseTo(10, 5);
    expect(timer.sectors[1]).toBeCloseTo(30, 5);
  });

  it('keeps the finished lap on show until the next lap sets its first sector', () => {
    const timer = new LapTimer(LENGTH, START);
    let at = drive(timer, START - 6, 40, 0.3).at;
    at = drive(timer, at, 40, 30.2).at;
    expect(timer.sectors.every((s) => s !== null)).toBe(true);
    drive(timer, at, 40, 10.2);
    expect(timer.sectors[0]).toBeCloseTo(10, 5);
    expect(timer.sectors.slice(1)).toEqual([null, null]);
  });

  it('compares each sector with the reference lap', () => {
    const timer = new LapTimer(LENGTH, START);
    let at = lap(timer, START - 6, 40).at;
    // No reference during the first lap.
    expect(timer.sectorDeltas[0]).toBeNull();
    // Second lap faster: every sector beats the first lap's.
    at = drive(timer, at, 50, 8.5).at;
    expect(timer.sectorDeltas[0]!).toBeLessThan(-1.5);
    at = lap(timer, at, 50).at;
    // Third lap slower than the second.
    drive(timer, at, 30, 14);
    expect(timer.sectorDeltas[0]!).toBeGreaterThan(1);
  });
});

describe('live delta', () => {
  it('has nothing to show until a lap is on the board', () => {
    const timer = new LapTimer(LENGTH, START);
    drive(timer, START - 6, 40, 5);
    expect(timer.delta).toBeNull();
  });

  it('is zero when matching the reference and grows when slower', () => {
    const timer = new LapTimer(LENGTH, START);
    let at = lap(timer, START - 6, 40).at;
    expect(timer.reference).not.toBeNull();
    expect(timer.reference!.times).toHaveLength(Math.floor(LENGTH / REFERENCE_STEP) + 1);

    // Same speed: level with the reference all the way round.
    at = drive(timer, at, 40, 12).at;
    expect(timer.delta!).toBeCloseTo(0, 3);
    at = lap(timer, at, 40).at;

    // 20 m/s takes twice as long: after 400 m (20 s) the car is 10 s down.
    const progress = (at - START + LENGTH) % LENGTH;
    drive(timer, at, 20, (400 - progress) / 20);
    expect(timer.delta!).toBeCloseTo(10, 1);
  });

  it('is negative when ahead, and the quicker lap becomes the reference', () => {
    const timer = new LapTimer(LENGTH, START);
    let at = lap(timer, START - 6, 30).at;
    const first = timer.reference!.time;
    at = drive(timer, at, 60, 5).at;
    expect(timer.delta!).toBeLessThan(-4);
    const run = lap(timer, at, 60);
    expect(run.lap).toMatchObject({ kind: 'lap', best: true, valid: true });
    expect(timer.reference!.time).toBeLessThan(first);
    expect(run.lap.reference).toBe(timer.reference);
  });

  it('keeps counting against a car that stops', () => {
    const timer = new LapTimer(LENGTH, START);
    let at = lap(timer, START - 6, 40).at;
    at = drive(timer, at, 40, 5).at;
    const before = timer.delta!;
    drive(timer, at, 0, 3);
    expect(timer.delta!).toBeCloseTo(before + 3, 3);
  });

  it('starts from a reference lap of an earlier session, if it fits this track', () => {
    const recorder = new LapTimer(LENGTH, START);
    lap(recorder, START - 6, 40);
    const saved = recorder.reference!;

    const timer = new LapTimer(LENGTH, START, null, { reference: saved });
    drive(timer, START - 6, 40, 8);
    expect(timer.delta!).toBeCloseTo(0, 3);

    // Recorded on a loop of another length: unusable.
    expect(new LapTimer(LENGTH + 500, START, null, { reference: saved }).reference).toBeNull();
    expect(new LapTimer(LENGTH, START, null, { reference: { ...saved, sectors: [1, 2] } }).reference).toBeNull();
  });
});

describe('invalid laps', () => {
  it('times a lap the car left the track on, without it counting as best', () => {
    const timer = new LapTimer(LENGTH, START, 100);
    const at = drive(timer, START - 6, 40, 5).at;
    timer.invalidate();
    expect(timer.invalid).toBe(true);
    expect(timer.delta).toBeNull();
    const run = lap(timer, at, 40);
    expect(run.lap).toMatchObject({ kind: 'lap', valid: false, best: false, reference: null });
    expect(timer.lastValid).toBe(false);
    expect(timer.best).toBe(100);
    expect(timer.reference).toBeNull();
    // The next lap starts clean.
    expect(timer.invalid).toBe(false);
  });

  it('marks a lap invalid when part of the loop is skipped', () => {
    const timer = new LapTimer(LENGTH, START);
    const at = drive(timer, START - 6, 40, 5).at;
    // Jump 300 m ahead.
    timer.update((at + 300) % LENGTH, DT);
    expect(timer.invalid).toBe(true);
  });

  it('marks a lap invalid when the car strays far from the track', () => {
    const timer = new LapTimer(LENGTH, START);
    drive(timer, START - 6, 40, 5);
    timer.update(null, DT);
    expect(timer.invalid).toBe(true);
  });

  it('cannot be invalidated before the first lap starts', () => {
    const timer = new LapTimer(LENGTH, START);
    timer.invalidate();
    timer.update(null, DT);
    expect(timer.invalid).toBe(false);
  });
});

describe('restart', () => {
  it('goes back to waiting for the line, keeping the best and last laps', () => {
    const timer = new LapTimer(LENGTH, START);
    const at = lap(timer, START - 6, 40).at;
    drive(timer, at, 40, 12);
    const best = timer.best;
    timer.reset();
    expect(timer).toMatchObject({ lap: 0, current: 0, invalid: false, delta: null, best, last: best });
    expect(timer.sectors).toEqual([null, null, null]);

    // The clock stays stopped until the car crosses the line again from the grid.
    const before = drive(timer, START - 15, 30, 0.3);
    expect(before.events).toEqual([]);
    expect(timer.current).toBe(0);
    const after = drive(timer, before.at, 30, 0.5);
    expect(after.events).toEqual([{ kind: 'start' }]);
    expect(timer.lap).toBe(1);
  });
});

describe('formatDelta', () => {
  it('shows a sign and milliseconds', () => {
    expect(formatDelta(-0.3456)).toBe('−0.346');
    expect(formatDelta(1.2)).toBe('+1.200');
    expect(formatDelta(0)).toBe('+0.000');
    expect(formatDelta(-0.0001)).toBe('+0.000');
    expect(formatDelta(-12.5)).toBe('−12.500');
  });
});

describe('best lap store', () => {
  function memoryStorage() {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  }
  const reference: ReferenceLap = { time: 83.4567, sectors: [30.1234, 25.5, 27.8333], times: [0, 1.23456, 2.5] };

  it('round-trips a lap per track and car, to the millisecond', () => {
    const storage = memoryStorage();
    saveBestLap('spa', 'gt', reference, storage);
    expect(loadBestLap('spa', 'gt', storage)).toEqual({ time: 83.4567, sectors: [30.123, 25.5, 27.833], times: [0, 1.235, 2.5] });
    expect(loadBestLap('spa', 'formula', storage)).toBeNull();
    expect(loadBestLap('eifel', 'gt', storage)).toBeNull();
  });

  it('ignores anything that is not a lap', () => {
    const storage = memoryStorage();
    for (const junk of ['{nope', '{"time":"fast"}', '{"time":80,"sectors":[1],"times":[0,null]}', '[]']) {
      storage.setItem('drivee.bestLap.spa.gt', junk);
      expect(loadBestLap('spa', 'gt', storage)).toBeNull();
    }
    expect(loadBestLap('spa', 'gt', null)).toBeNull();
  });
});

describe('WrongWayDetector', () => {
  const run = (detector: WrongWayDetector, alignment: number, speed: number, seconds: number) => {
    for (let t = 0; t < seconds - 1e-9; t += DT) detector.update(alignment, speed, DT);
    return detector.active;
  };

  it('warns after driving against the track for a moment, not for a spin', () => {
    const detector = new WrongWayDetector();
    expect(run(detector, -1, 20, 1)).toBe(false);
    expect(run(detector, -1, 20, 0.6)).toBe(true);
    // Turned round again: gone at once.
    expect(run(detector, 1, 20, DT)).toBe(false);
  });

  it('stays quiet when slow, sideways or going the right way', () => {
    const detector = new WrongWayDetector();
    expect(run(detector, -1, 3, 5)).toBe(false);
    expect(run(detector, 0, 30, 5)).toBe(false);
    expect(run(detector, 1, 30, 5)).toBe(false);
  });

  it('counts reversing down the track, but not sliding backwards the right way', () => {
    const detector = new WrongWayDetector();
    expect(run(detector, 1, -10, 2)).toBe(true);
    detector.reset();
    expect(detector.active).toBe(false);
    // Spun round and still travelling with the track: facing against it, moving backwards.
    expect(run(detector, -1, -30, 5)).toBe(false);
  });
});
