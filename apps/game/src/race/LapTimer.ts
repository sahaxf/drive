/** A lap only counts after covering this fraction of the loop since the last crossing. */
const MIN_LAP_FRACTION = 0.9;
/** Progress jumping further than this in one step is a teleport or a jump to a nearby section: ignored. */
const MAX_STEP_JUMP = 50;
/** Spacing of the reference lap's time samples, metres along the loop. */
export const REFERENCE_STEP = 20;
const DEFAULT_SECTORS = 3;

/** A completed lap to measure later ones against, as time at each point round the loop. */
export interface ReferenceLap {
  /** Lap time, s. */
  time: number;
  /** Time spent in each sector, s. */
  sectors: number[];
  /** Lap time on reaching each multiple of {@link REFERENCE_STEP} metres past the line, s. */
  times: number[];
}

export type LapEvent =
  | { kind: 'start' }
  | { kind: 'sector'; index: number; time: number }
  | {
      kind: 'lap';
      time: number;
      /** Valid and quicker than the best so far. */
      best: boolean;
      /** False when part of the lap was skipped or driven off the track. */
      valid: boolean;
      /** Set when this lap became the one later laps are compared with. */
      reference: ReferenceLap | null;
    };

export interface LapTimerOptions {
  /** Where each sector after the first begins, metres along the loop. Default: equal thirds. */
  sectors?: number[];
  /** A lap from an earlier session to compare against. */
  reference?: ReferenceLap | null;
}

/**
 * Lap timing from the car's distance along the loop. The first forward crossing of the
 * start/finish line starts lap 1; each later crossing completes a lap if the car really
 * went round (reversing over the line and back doesn't count). Crossing times are
 * interpolated within the physics step, so times are exact to the millisecond.
 *
 * The loop is split into sectors, each timed on its own, and the lap in progress is
 * compared with the reference lap point for point (`delta`). A lap during which the car
 * skipped part of the loop or left the track is still timed but marked invalid.
 */
export class LapTimer {
  /** Current lap number; 0 until the car first crosses the line. */
  lap = 0;
  /** Time into the current lap, s. */
  current = 0;
  last: number | null = null;
  /** Whether `last` was a valid lap. */
  lastValid = true;
  best: number | null;
  /** The current lap can no longer count. */
  invalid = false;
  /** Seconds ahead (−) or behind (+) the reference lap at this point; null with nothing to compare. */
  delta: number | null = null;
  /** Sector times of the lap in progress; the finished lap's stay up until the next sector 1. */
  readonly sectors: (number | null)[];
  /** Each sector against the reference lap's, s (− is faster); null with nothing to compare. */
  readonly sectorDeltas: (number | null)[];
  reference: ReferenceLap | null;

  private running = false;
  private previous: number | null = null;
  /** Signed metres travelled since the last crossing. */
  private covered = 0;
  /** Sector boundaries as metres past the line, ascending. */
  private readonly bounds: number[];
  /** Number of reference samples round the loop. */
  private readonly samples: number;
  /** Furthest point reached this lap (metres past the line) and the lap time on getting there. */
  private reached = 0;
  private reachedTime = 0;
  /** Where the car was one step ago, for timing a point passed between two steps. */
  private stepProgress = 0;
  private stepTime = 0;
  private sector = 0;
  private sectorStart = 0;
  private times: number[] = [];
  private clearSectors = false;

  constructor(
    private readonly length: number,
    private readonly startDistance: number,
    best: number | null = null,
    { sectors, reference = null }: LapTimerOptions = {},
  ) {
    this.best = best;
    const bounds = sectors
      ? sectors.map((d) => this.progress(this.wrap(d - startDistance)))
      : Array.from({ length: DEFAULT_SECTORS - 1 }, (_, k) => (length * (k + 1)) / DEFAULT_SECTORS);
    this.bounds = bounds.filter((b) => b > 0 && b < length).sort((a, b) => a - b);
    this.sectors = new Array<number | null>(this.bounds.length + 1).fill(null);
    this.sectorDeltas = new Array<number | null>(this.bounds.length + 1).fill(null);
    this.samples = Math.floor(length / REFERENCE_STEP) + 1;
    this.reference = reference && this.fits(reference) ? reference : null;
  }

  /**
   * Advance by one physics step. `distance` is metres along the loop, or null when the
   * car isn't near the track (progress is then held, the clock keeps running).
   */
  update(distance: number | null, dt: number): LapEvent | null {
    if (this.running) this.current += dt;
    if (distance === null) {
      this.invalidate();
      return null;
    }

    const rel = this.wrap(distance - this.startDistance);
    const previous = this.previous;
    this.previous = rel;
    if (previous === null) return null;

    const delta = this.wrap(rel - previous);
    if (Math.abs(delta) > MAX_STEP_JUMP) {
      // Part of the loop wasn't driven.
      this.invalidate();
      return null;
    }
    this.covered += delta;

    if (!(previous < 0 && rel >= 0 && delta > 0)) return this.running ? this.advance(this.progress(rel)) : null;
    // Share of this step spent after the line.
    const after = (rel / delta) * dt;

    if (!this.running) {
      this.running = true;
      this.lap = 1;
      this.beginLap(after, rel);
      return { kind: 'start' };
    }
    if (this.covered < this.length * MIN_LAP_FRACTION) return null;

    const time = this.current - after;
    this.fillSamples(this.reached, this.reachedTime, this.length, time);
    this.completeSector(time);
    const valid = !this.invalid;
    const best = valid && (this.best === null || time < this.best);
    this.last = time;
    this.lastValid = valid;
    if (best) this.best = time;

    let reference: ReferenceLap | null = null;
    if (valid && (this.reference === null || time < this.reference.time)) {
      const candidate = { time, sectors: this.sectors.map((s) => s ?? Number.NaN), times: this.times };
      if (this.fits(candidate)) this.reference = reference = candidate;
    }

    this.lap++;
    this.beginLap(after, rel);
    return { kind: 'lap', time, best, valid, reference };
  }

  /** The lap in progress can't count (the car left the track). */
  invalidate(): void {
    if (!this.running) return;
    this.invalid = true;
    this.delta = null;
  }

  /** Back to waiting for the first crossing, e.g. after a restart. Best and last laps are kept. */
  reset(): void {
    this.running = false;
    this.lap = 0;
    this.current = 0;
    this.previous = null;
    this.covered = 0;
    this.invalid = false;
    this.delta = null;
    this.sectors.fill(null);
    this.sectorDeltas.fill(null);
    this.clearSectors = false;
  }

  private beginLap(time: number, progress: number): void {
    this.current = time;
    this.covered = progress;
    this.invalid = false;
    this.sector = 0;
    this.sectorStart = 0;
    this.times = new Array<number>(this.samples).fill(Number.NaN);
    this.times[0] = 0;
    this.fillSamples(0, 0, progress, time);
    this.reached = this.stepProgress = progress;
    this.reachedTime = this.stepTime = time;
    // The finished lap's sector times stay on show until this lap has one of its own.
    this.clearSectors = true;
    this.updateDelta();
  }

  /** The car is at `progress` metres past the line: time what it passed on the way. */
  private advance(progress: number): LapEvent | null {
    let event: LapEvent | null = null;
    const ahead = progress - this.reached;
    // Behind the furthest point (reversing, or back over the line): nothing new was reached.
    if (ahead > 0 && ahead <= MAX_STEP_JUMP) {
      // Coming forward again after reversing, the old furthest point was passed during this step.
      let from = this.reachedTime;
      const span = progress - this.stepProgress;
      if (this.stepProgress < this.reached && span > 0 && span <= MAX_STEP_JUMP) {
        from = this.stepTime + ((this.current - this.stepTime) * (this.reached - this.stepProgress)) / span;
      }
      this.fillSamples(this.reached, from, progress, this.current);
      while (this.sector < this.bounds.length && this.bounds[this.sector]! <= progress) {
        const bound = this.bounds[this.sector]!;
        event = this.completeSector(from + ((this.current - from) * (bound - this.reached)) / ahead);
      }
      this.reached = progress;
      this.reachedTime = this.current;
    }
    this.stepProgress = progress;
    this.stepTime = this.current;
    this.updateDelta();
    return event;
  }

  /** The current sector ended at lap time `at`. */
  private completeSector(at: number): LapEvent {
    if (this.clearSectors) {
      this.sectors.fill(null);
      this.sectorDeltas.fill(null);
      this.clearSectors = false;
    }
    const index = this.sector;
    const time = at - this.sectorStart;
    this.sectors[index] = time;
    const reference = this.reference?.sectors[index];
    this.sectorDeltas[index] = reference === undefined ? null : time - reference;
    this.sectorStart = at;
    this.sector++;
    return { kind: 'sector', index, time };
  }

  /** Record the lap time at each sample point in (from, to], the car going steadily between the two. */
  private fillSamples(from: number, fromTime: number, to: number, toTime: number): void {
    if (to <= from) return;
    for (let i = Math.floor(from / REFERENCE_STEP) + 1; i < this.samples && i * REFERENCE_STEP <= to; i++) {
      this.times[i] = fromTime + ((toTime - fromTime) * (i * REFERENCE_STEP - from)) / (to - from);
    }
  }

  private updateDelta(): void {
    const reference = this.reference;
    this.delta = this.running && !this.invalid && reference ? this.current - this.referenceTime(reference, this.reached) : null;
  }

  /** When the reference lap was `progress` metres past the line. */
  private referenceTime(reference: ReferenceLap, progress: number): number {
    const i = Math.min(Math.floor(progress / REFERENCE_STEP), this.samples - 1);
    const from = i * REFERENCE_STEP;
    const last = i + 1 >= this.samples;
    const span = last ? this.length - from : REFERENCE_STEP;
    const a = reference.times[i]!;
    const b = last ? reference.time : reference.times[i + 1]!;
    return span > 0 ? a + ((b - a) * Math.min(progress - from, span)) / span : a;
  }

  /** A reference lap is only usable if it was recorded on a loop of this length and sector layout. */
  private fits(lap: ReferenceLap): boolean {
    return (
      lap.times.length === this.samples &&
      lap.sectors.length === this.sectors.length &&
      lap.times.every((t) => Number.isFinite(t)) &&
      lap.sectors.every((t) => Number.isFinite(t))
    );
  }

  /** Metres past the line, 0..length, from a wrapped signed distance. */
  private progress(rel: number): number {
    return rel < 0 ? rel + this.length : rel;
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

/** -0.3456 → "−0.346", 1.2 → "+1.200". */
export function formatDelta(seconds: number): string {
  const ms = Math.round(Math.abs(seconds) * 1000);
  return `${seconds < 0 && ms > 0 ? '−' : '+'}${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, '0')}`;
}
