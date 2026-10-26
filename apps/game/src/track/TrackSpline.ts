import { Vector3 } from 'three';
import type { TrackSpec } from '@drivee/shared';

export interface TrackFrame {
  position: Vector3;
  tangent: Vector3;
  /** Banked road "right" (driver's right) and surface normal. */
  right: Vector3;
  up: Vector3;
  width: number;
  /** Distance along the loop, m. */
  distance: number;
}

export interface NearestResult {
  /** Fractional sample index. */
  index: number;
  /** Distance along the loop, m. */
  distance: number;
  /** Signed horizontal offset from the centreline, + = right of the driving direction. */
  lateral: number;
  /** Horizontal distance to the centreline, m. */
  offset: number;
}

const DENSE_STEPS = 48;
const HASH_CELL = 20;
const CURVATURE_SMOOTHING = 5;

/**
 * The centreline as a closed, uniformly resampled loop. Everything that follows the
 * road (mesh sweep, terrain carving, forest clearance, resets) reads from here.
 *
 * Frames are built from world up rather than parallel transport: roads are never
 * vertical, so this never twists and keeps the road level side-to-side except where
 * banking is asked for.
 */
export class TrackSpline {
  readonly count: number;
  readonly step: number;
  readonly length: number;
  /** Packed xyz per sample. */
  readonly positions: Float32Array;
  readonly tangents: Float32Array;
  readonly rights: Float32Array;
  readonly ups: Float32Array;
  readonly widths: Float32Array;
  /** Signed curvature, 1/m, + = turning right. Lightly smoothed. */
  readonly curvature: Float32Array;
  private readonly hash = new Map<number, number[]>();

  static fromSpec(spec: TrackSpec, step = 2): TrackSpline {
    const pts = spec.centreline.points;
    return new TrackSpline(
      pts.map((p) => new Vector3(...p.p)),
      pts.map((p) => p.width ?? spec.centreline.width),
      pts.map((p) => ((p.banking ?? 0) * Math.PI) / 180),
      step,
    );
  }

  constructor(control: Vector3[], widths: number[], bankings: number[], targetStep: number) {
    const dense = densify(control, widths, bankings);
    const n = Math.max(8, Math.round(dense.totalLength / targetStep));
    this.count = n;
    this.length = dense.totalLength;
    this.step = this.length / n;

    this.positions = new Float32Array(n * 3);
    this.tangents = new Float32Array(n * 3);
    this.rights = new Float32Array(n * 3);
    this.ups = new Float32Array(n * 3);
    this.widths = new Float32Array(n);
    this.curvature = new Float32Array(n);
    const banking = new Float32Array(n);

    // Uniform resample by arc length.
    let j = 0;
    for (let k = 0; k < n; k++) {
      const s = k * this.step;
      while (dense.lengths[j + 1]! < s) j++;
      const seg = dense.lengths[j + 1]! - dense.lengths[j]!;
      const f = seg > 0 ? (s - dense.lengths[j]!) / seg : 0;
      const a = dense.points[j]!;
      const b = dense.points[(j + 1) % dense.points.length]!;
      this.positions[k * 3] = a.x + (b.x - a.x) * f;
      this.positions[k * 3 + 1] = a.y + (b.y - a.y) * f;
      this.positions[k * 3 + 2] = a.z + (b.z - a.z) * f;
      this.widths[k] = lerp(dense.widths[j]!, dense.widths[(j + 1) % dense.widths.length]!, f);
      banking[k] = lerp(dense.bankings[j]!, dense.bankings[(j + 1) % dense.bankings.length]!, f);
    }

    const t = new Vector3();
    const right = new Vector3();
    const up = new Vector3();
    const flatUp = new Vector3();
    const headings = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const prev = this.wrap(k - 1);
      const next = this.wrap(k + 1);
      t.set(
        this.positions[next * 3]! - this.positions[prev * 3]!,
        this.positions[next * 3 + 1]! - this.positions[prev * 3 + 1]!,
        this.positions[next * 3 + 2]! - this.positions[prev * 3 + 2]!,
      ).normalize();
      // right = tangent × worldUp, up = right × tangent.
      right.set(-t.z, 0, t.x).normalize();
      flatUp.crossVectors(right, t);
      // Positive banking raises the left edge (suits a right-hander).
      const b = banking[k]!;
      up.copy(flatUp).multiplyScalar(Math.cos(b)).addScaledVector(right, Math.sin(b));
      right.multiplyScalar(Math.cos(b)).addScaledVector(flatUp, -Math.sin(b));
      t.toArray(this.tangents, k * 3);
      right.toArray(this.rights, k * 3);
      up.toArray(this.ups, k * 3);
      headings[k] = Math.atan2(t.x, t.z);
    }

    const raw = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const dh = wrapAngle(headings[this.wrap(k + 1)]! - headings[this.wrap(k - 1)]!);
      // Turning right decreases heading = atan2(x, z).
      raw[k] = -dh / (2 * this.step);
    }
    for (let k = 0; k < n; k++) {
      let sum = 0;
      for (let o = -CURVATURE_SMOOTHING; o <= CURVATURE_SMOOTHING; o++) sum += raw[this.wrap(k + o)]!;
      this.curvature[k] = sum / (CURVATURE_SMOOTHING * 2 + 1);
    }

    for (let k = 0; k < n; k++) {
      const key = cellKey(this.positions[k * 3]!, this.positions[k * 3 + 2]!);
      let bucket = this.hash.get(key);
      if (!bucket) this.hash.set(key, (bucket = []));
      bucket.push(k);
    }
  }

  wrap(index: number): number {
    return ((index % this.count) + this.count) % this.count;
  }

  /** Interpolated frame at `distance` along the loop (wraps). */
  frameAt(distance: number, out?: TrackFrame): TrackFrame {
    const frame = out ?? {
      position: new Vector3(),
      tangent: new Vector3(),
      right: new Vector3(),
      up: new Vector3(),
      width: 0,
      distance: 0,
    };
    const d = ((distance % this.length) + this.length) % this.length;
    const fi = d / this.step;
    const i0 = Math.floor(fi) % this.count;
    const i1 = this.wrap(i0 + 1);
    const f = fi - Math.floor(fi);
    lerpPacked(frame.position, this.positions, i0, i1, f);
    lerpPacked(frame.tangent, this.tangents, i0, i1, f).normalize();
    lerpPacked(frame.right, this.rights, i0, i1, f).normalize();
    lerpPacked(frame.up, this.ups, i0, i1, f).normalize();
    frame.width = lerp(this.widths[i0]!, this.widths[i1]!, f);
    frame.distance = d;
    return frame;
  }

  /** Closest point on the centreline in the horizontal plane, or null if beyond `maxOffset`. */
  nearest(x: number, z: number, maxOffset = Infinity): NearestResult | null {
    let best = -1;
    let bestD2 = Infinity;
    const cx = Math.floor(x / HASH_CELL);
    const cz = Math.floor(z / HASH_CELL);
    const maxRing = Number.isFinite(maxOffset) ? Math.ceil(maxOffset / HASH_CELL) + 1 : 10_000;
    for (let ring = 0; ring <= maxRing; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dz = -ring; dz <= ring; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const bucket = this.hash.get(packKey(cx + dx, cz + dz));
          if (!bucket) continue;
          for (const k of bucket) {
            const ex = this.positions[k * 3]! - x;
            const ez = this.positions[k * 3 + 2]! - z;
            const d2 = ex * ex + ez * ez;
            if (d2 < bestD2) {
              bestD2 = d2;
              best = k;
            }
          }
        }
      }
      // Anything in a further ring is at least (ring * cell) away.
      if (best >= 0 && Math.sqrt(bestD2) <= ring * HASH_CELL) break;
    }
    if (best < 0) return null;

    // Refine by projecting onto the two segments either side of the closest sample.
    let result: NearestResult | null = null;
    for (const [a, b] of [
      [this.wrap(best - 1), best],
      [best, this.wrap(best + 1)],
    ] as const) {
      const ax = this.positions[a * 3]!;
      const az = this.positions[a * 3 + 2]!;
      const sx = this.positions[b * 3]! - ax;
      const sz = this.positions[b * 3 + 2]! - az;
      const len2 = sx * sx + sz * sz;
      const f = Math.min(Math.max(((x - ax) * sx + (z - az) * sz) / len2, 0), 1);
      const px = ax + sx * f;
      const pz = az + sz * f;
      const offset = Math.hypot(x - px, z - pz);
      if (result && offset >= result.offset) continue;
      // Sign from the flat right vector (-tz, tx) of the segment.
      const side = (x - px) * -sz + (z - pz) * sx >= 0 ? 1 : -1;
      const index = a + f;
      result = { index, distance: (index * this.step) % this.length, lateral: side * offset, offset };
    }
    if (!result || result.offset > maxOffset) return null;
    return result;
  }
}

interface Dense {
  points: Vector3[];
  widths: number[];
  bankings: number[];
  /** Cumulative length at each point; one extra entry closes the loop. */
  lengths: number[];
  totalLength: number;
}

/** Centripetal Catmull-Rom through a closed loop (no cusps or loops in tight corners). */
function densify(control: Vector3[], widths: number[], bankings: number[]): Dense {
  const n = control.length;
  const points: Vector3[] = [];
  const w: number[] = [];
  const b: number[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = control[(i - 1 + n) % n]!;
    const p1 = control[i]!;
    const p2 = control[(i + 1) % n]!;
    const p3 = control[(i + 2) % n]!;
    const t0 = 0;
    const t1 = t0 + Math.sqrt(p0.distanceTo(p1));
    const t2 = t1 + Math.sqrt(p1.distanceTo(p2));
    const t3 = t2 + Math.sqrt(p2.distanceTo(p3));
    for (let s = 0; s < DENSE_STEPS; s++) {
      const u = s / DENSE_STEPS;
      const t = t1 + (t2 - t1) * u;
      const a1 = mixV(p0, p1, t0, t1, t);
      const a2 = mixV(p1, p2, t1, t2, t);
      const a3 = mixV(p2, p3, t2, t3, t);
      const b1 = mixV(a1, a2, t0, t2, t);
      const b2 = mixV(a2, a3, t1, t3, t);
      points.push(mixV(b1, b2, t1, t2, t));
      const e = u * u * (3 - 2 * u);
      w.push(lerp(widths[i]!, widths[(i + 1) % n]!, e));
      b.push(lerp(bankings[i]!, bankings[(i + 1) % n]!, e));
    }
  }
  const lengths = [0];
  for (let k = 0; k < points.length; k++) {
    lengths.push(lengths[k]! + points[k]!.distanceTo(points[(k + 1) % points.length]!));
  }
  return { points, widths: w, bankings: b, lengths, totalLength: lengths[lengths.length - 1]! };
}

function mixV(a: Vector3, b: Vector3, ta: number, tb: number, t: number): Vector3 {
  const span = tb - ta;
  if (span === 0) return a.clone();
  return a.clone().multiplyScalar((tb - t) / span).addScaledVector(b, (t - ta) / span);
}

function lerpPacked(out: Vector3, data: Float32Array, i0: number, i1: number, f: number): Vector3 {
  return out.set(
    lerp(data[i0 * 3]!, data[i1 * 3]!, f),
    lerp(data[i0 * 3 + 1]!, data[i1 * 3 + 1]!, f),
    lerp(data[i0 * 3 + 2]!, data[i1 * 3 + 2]!, f),
  );
}

function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function cellKey(x: number, z: number): number {
  return packKey(Math.floor(x / HASH_CELL), Math.floor(z / HASH_CELL));
}

function packKey(cx: number, cz: number): number {
  return (cx + 32768) * 65536 + (cz + 32768);
}
