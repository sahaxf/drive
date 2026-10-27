import { describe, expect, it } from 'vitest';
import { formatLapTime, LapTimer } from '../src/race/LapTimer';

const LENGTH = 1000;
const START = 100;
const DT = 1 / 120;

/** Drive at constant speed from `from` metres along the loop for `seconds`. */
function drive(timer: LapTimer, from: number, speed: number, seconds: number) {
  const events = [];
  let d = from;
  for (let t = 0; t < seconds - 1e-9; t += DT) {
    d = (d + speed * DT) % LENGTH;
    const e = timer.update(d, DT);
    if (e) events.push(e);
  }
  return { events, at: d };
}

describe('LapTimer', () => {
  it('starts on the first crossing and times full laps exactly', () => {
    const timer = new LapTimer(LENGTH, START);
    // Grid slot 15 m behind the line, 50 m/s: crosses after 0.3 s.
    const first = drive(timer, START - 15, 50, 1);
    expect(first.events).toEqual([{ kind: 'start' }]);
    expect(timer.lap).toBe(1);
    expect(timer.current).toBeCloseTo(0.7, 6);

    // One lap at 50 m/s takes exactly 20 s.
    const lap = drive(timer, first.at, 50, 20);
    expect(lap.events).toHaveLength(1);
    expect(lap.events[0]).toMatchObject({ kind: 'lap', best: true });
    expect(timer.last).toBeCloseTo(20, 6);
    expect(timer.lap).toBe(2);
  });

  it('keeps the best lap and reports a new best only when faster', () => {
    const timer = new LapTimer(LENGTH, START, 25);
    let at = drive(timer, START - 1, 50, 0.1).at;
    const slow = drive(timer, at, 38, 27); // ~26.3 s lap: slower than the stored 25 s
    at = slow.at;
    expect(slow.events[0]).toMatchObject({ kind: 'lap', best: false });
    const fast = drive(timer, at, 50, 20);
    // This lap began partway through the slow run, so it's a little over 20 s, but under 25.
    expect(fast.events[0]).toMatchObject({ kind: 'lap', best: true });
    expect(timer.best).toBe(timer.last);
    expect(timer.best!).toBeLessThan(21);
  });

  it('does not count reversing back over the line', () => {
    const timer = new LapTimer(LENGTH, START);
    let at = drive(timer, START - 5, 20, 0.5).at; // started
    at = drive(timer, at, -20, 1).at; // back over the line
    const forward = drive(timer, at, 20, 1); // and forward again
    expect(forward.events).toEqual([]);
    expect(timer.lap).toBe(1);
  });

  it('ignores jumps along the track (resets, nearby sections)', () => {
    const timer = new LapTimer(LENGTH, START);
    const at = drive(timer, START - 5, 20, 0.5).at;
    // Teleport to just before the line, then cross it: no lap, it wasn't driven.
    timer.update(START - 2, DT);
    expect(drive(timer, START - 2, 20, 0.5).events).toEqual([]);
    expect(at).toBeGreaterThan(START);
  });
});

describe('formatLapTime', () => {
  it('formats minutes, seconds and milliseconds', () => {
    expect(formatLapTime(83.4564)).toBe('1:23.456');
    expect(formatLapTime(5.0)).toBe('0:05.000');
    expect(formatLapTime(600.0005)).toBe('10:00.001');
  });
});
