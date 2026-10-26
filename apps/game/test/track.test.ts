import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { parseTrackSpec } from '@drivee/shared';
import { TrackSpline } from '../src/track/TrackSpline';

const trackPath = fileURLToPath(new URL('../../../public/tracks/eifel-ring/track.json', import.meta.url));
const spec = parseTrackSpec(JSON.parse(readFileSync(trackPath, 'utf8')));
const spline = TrackSpline.fromSpec(spec);

function point(k: number): Vector3 {
  const i = spline.wrap(k);
  return new Vector3(spline.positions[i * 3], spline.positions[i * 3 + 1], spline.positions[i * 3 + 2]);
}

function vec(data: Float32Array, k: number): Vector3 {
  return new Vector3(data[k * 3], data[k * 3 + 1], data[k * 3 + 2]);
}

describe('TrackSpline', () => {
  it('resamples the loop at a uniform step, closing continuously', () => {
    for (let k = 0; k < spline.count; k++) {
      expect(point(k).distanceTo(point(k + 1))).toBeCloseTo(spline.step, 1);
    }
  });

  it('builds orthonormal frames with up mostly up', () => {
    for (let k = 0; k < spline.count; k += 7) {
      const t = vec(spline.tangents, k);
      const r = vec(spline.rights, k);
      const u = vec(spline.ups, k);
      expect(t.length()).toBeCloseTo(1, 4);
      expect(Math.abs(t.dot(r))).toBeLessThan(1e-4);
      expect(Math.abs(t.dot(u))).toBeLessThan(1e-4);
      expect(Math.abs(r.dot(u))).toBeLessThan(1e-4);
      expect(u.y).toBeGreaterThan(0.95);
      // right-handed: right = tangent × up
      expect(new Vector3().crossVectors(t, u).distanceTo(r)).toBeLessThan(1e-3);
    }
  });

  it('finds the nearest centreline point and the side of the road', () => {
    for (const d of [10, 777, 2500, spline.length - 5]) {
      const f = spline.frameAt(d);
      const flatRight = new Vector3(f.right.x, 0, f.right.z).normalize();
      const probe = f.position.clone().addScaledVector(flatRight, 4);
      const hit = spline.nearest(probe.x, probe.z)!;
      expect(hit.offset).toBeCloseTo(4, 0);
      expect(hit.lateral).toBeGreaterThan(0);
      const wrapDiff = Math.abs(((hit.distance - d + spline.length / 2) % spline.length) - spline.length / 2);
      expect(wrapDiff).toBeLessThan(1);
    }
    expect(spline.nearest(1e5, 1e5, 100)).toBeNull();
  });
});

describe('Eifel Ring circuit', () => {
  it('is a plausible length', () => {
    expect(spline.length).toBeGreaterThan(4500);
    expect(spline.length).toBeLessThan(6000);
  });

  it('never crosses itself', () => {
    const n = spline.count;
    const p = (k: number) => [spline.positions[spline.wrap(k) * 3]!, spline.positions[spline.wrap(k) * 3 + 2]!] as const;
    const crossings: string[] = [];
    for (let i = 0; i < n; i++) {
      const [ax, az] = p(i);
      const [bx, bz] = p(i + 1);
      for (let j = i + 3; j < n; j++) {
        if (i === 0 && j >= n - 2) continue;
        const [cx, cz] = p(j);
        const [dx, dz] = p(j + 1);
        const d1 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
        const d2 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
        const d3 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
        const d4 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
        if (d1 * d2 < 0 && d3 * d4 < 0) crossings.push(`${i}/${j}`);
      }
    }
    expect(crossings).toEqual([]);
  });

  it('keeps separate parts of the track apart (room for verges, barriers and trees)', () => {
    // Any two points more than 150 m apart along the road must be > 45 m apart in the world.
    const window = Math.round(150 / spline.step);
    let closest = Infinity;
    for (let i = 0; i < spline.count; i += 2) {
      const a = point(i);
      for (let j = i + window; j < spline.count - window + i; j += 2) {
        closest = Math.min(closest, Math.hypot(a.x - point(j).x, a.z - point(j).z));
      }
    }
    expect(closest).toBeGreaterThan(45);
  });

  it('has drivable gradients and corner radii', () => {
    let maxGrade = 0;
    let minRadius = Infinity;
    for (let k = 0; k < spline.count; k++) {
      const a = point(k);
      const b = point(k + 5);
      maxGrade = Math.max(maxGrade, Math.abs(b.y - a.y) / Math.hypot(b.x - a.x, b.z - a.z));
      minRadius = Math.min(minRadius, 1 / Math.max(Math.abs(spline.curvature[k]!), 1e-6));
    }
    expect(maxGrade).toBeLessThan(0.12);
    expect(minRadius).toBeGreaterThan(15);
  });

  it('banks the carousel into the corner', () => {
    // Find the most banked sample: its curvature must turn toward the low side.
    let k = 0;
    for (let i = 0; i < spline.count; i++) if (vec(spline.ups, i).y < vec(spline.ups, k).y) k = i;
    const up = vec(spline.ups, k);
    const right = vec(spline.rights, k);
    expect(up.y).toBeLessThan(0.995);
    // Up leaning toward +right means the right side is low: that's the inside of a right-hander.
    expect(Math.sign(up.dot(new Vector3(right.x, 0, right.z).normalize()))).toBe(Math.sign(spline.curvature[k]!));
  });
});
