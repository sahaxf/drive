/** A lap only counts after covering this fraction of the loop since the last crossing. */
const MIN_LAP_FRACTION = 0.9;
/** Progress jumping further than this in one step is a teleport or a jump to a nearby section: ignored. */
const MAX_STEP_JUMP = 50;

export type LapEvent = { kind: 'start' } | { kind: 'lap'; time: number; best: boolean };

/**
 * Lap timing from the car's distance along the loop. The first forward crossing of the
 * start/finish line starts lap 1; each later crossing completes a lap if the car really
 * went round (reversing over the line and back doesn't count). Crossing times are
 * interpolated within the physics step, so times are exact to the millisecond.
 */
export class LapTimer {
  /** Current lap number; 0 until the car first crosses the line. */
  lap = 0;
  /** Time into the current lap, s. */
  current = 0;
  last: number | null = null;
  best: number | null;

  private running = false;
  private previous: number | null = null;
  /** Signed metres travelled since the last crossing. */
  private covered = 0;

  constructor(
    private readonly length: number,
    private readonly startDistance: number,
    best: number | null = null,
  ) {
    this.best = best;
  }

  /**
   * Advance by one physics step. `distance` is metres along the loop, or null when the
   * car isn't near the track (progress is then held, the clock keeps running).
   */
  update(distance: number | null, dt: number): LapEvent | null {
    if (this.running) this.current += dt;
    if (distance === null) return null;

    const rel = this.wrap(distance - this.startDistance);
    const previous = this.previous;
    this.previous = rel;
    if (previous === null) return null;

    const delta = this.wrap(rel - previous);
    if (Math.abs(delta) > MAX_STEP_JUMP) return null;
    this.covered += delta;

    if (!(previous < 0 && rel >= 0 && delta > 0)) return null;
    // Share of this step spent after the line.
    const after = (rel / delta) * dt;

    if (!this.running) {
      this.running = true;
      this.lap = 1;
      this.current = after;
      this.covered = rel;
      return { kind: 'start' };
    }
    if (this.covered < this.length * MIN_LAP_FRACTION) return null;

    const time = this.current - after;
    const best = this.best === null || time < this.best;
    this.last = time;
    if (best) this.best = time;
    this.lap++;
    this.current = after;
    this.covered = rel;
    return { kind: 'lap', time, best };
  }

  /** Signed distance wrapped to (-length/2, length/2]. */
  private wrap(d: number): number {
    const L = this.length;
    let r = ((d % L) + L) % L;
    if (r > L / 2) r -= L;
    return r;
  }
}

/** 83.456 → "1:23.456". */
export function formatLapTime(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const minutes = Math.floor(totalMs / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${minutes}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}
