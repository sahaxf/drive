import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { parseTrackSpec, type TrackSpec } from '@drivee/shared';
import { TrackSpline } from '../src/track/TrackSpline';
import { trackStats } from '../src/tracks';
import { minimapPath, minimapPoint } from '../src/ui/minimap';

const read = (rel: string) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'));
const ids: string[] = read('../../../public/tracks/index.json').tracks;
const specs = new Map<string, TrackSpec>(ids.map((id) => [id, parseTrackSpec(read(`../../../public/tracks/${id}/track.json`))]));

describe('track registry', () => {
  it('lists folders whose track.json parses and whose id matches the folder', () => {
    expect(ids.length).toBeGreaterThanOrEqual(2);
    for (const [id, spec] of specs) expect(spec.meta.id).toBe(id);
  });

  it('builds Spa as a closed ~7 km loop with its real ~100 m of elevation change', () => {
    const spec = specs.get('spa-replica')!;
    const spline = TrackSpline.fromSpec(spec);
    expect(spline.length).toBeGreaterThan(6900);
    expect(spline.length).toBeLessThan(7100);
    const { elevationRange } = trackStats(spec);
    expect(elevationRange).toBeGreaterThan(90);
    expect(elevationRange).toBeLessThan(120);
    expect(spec.meta.credits).toMatch(/OpenStreetMap/);
    expect(spec.race.startDistance).toBeLessThan(spline.length);
  });

  it('builds the Nordschleife as a closed ~20.8 km loop with ~300 m of elevation change', () => {
    const spec = specs.get('nordschleife')!;
    const spline = TrackSpline.fromSpec(spec);
    expect(spline.length).toBeGreaterThan(20_600);
    expect(spline.length).toBeLessThan(21_000);
    const { elevationRange } = trackStats(spec);
    expect(elevationRange).toBeGreaterThan(250);
    expect(elevationRange).toBeLessThan(330);
    expect(spec.meta.credits).toMatch(/OpenStreetMap/);
    expect(spec.race.startDistance).toBeLessThan(spline.length);
  });

  it('banks the Karussell into the corner', () => {
    const spline = TrackSpline.fromSpec(specs.get('nordschleife')!);
    let k = 0;
    for (let i = 0; i < spline.count; i++) if (spline.ups[i * 3 + 1]! < spline.ups[k * 3 + 1]!) k = i;
    const up = new Vector3().fromArray(spline.ups, k * 3);
    const right = new Vector3().fromArray(spline.rights, k * 3).setY(0).normalize();
    expect(up.y).toBeLessThan(0.98);
    // Up leaning toward +right means the right side is low: the inside of a right-hander.
    expect(Math.sign(up.dot(right))).toBe(Math.sign(spline.curvature[k]!));
  });
});

describe('trackStats', () => {
  it('measures the loop length and elevation range from the control points', () => {
    const square = parseTrackSpec({
      ...read('../../../public/tracks/eifel-ring/track.json'),
      centreline: { width: 10, points: [{ p: [0, 5, 0] }, { p: [100, 15, 0] }, { p: [100, 5, 100] }, { p: [0, 5, 100] }] },
    });
    expect(trackStats(square)).toEqual({ length: 400, elevationRange: 10 });
  });
});

describe('minimap', () => {
  const points = [
    [0, 0, 0],
    [200, 0, 0],
    [200, 0, 100],
    [0, 0, 100],
  ] as const;

  it('fits the track into the box keeping its aspect ratio, centred', () => {
    expect(minimapPoint(points, [0, 0, 0])).toEqual([6, 28]);
    expect(minimapPoint(points, [200, 0, 100])).toEqual([94, 72]);
  });

  it('draws a closed path through every point', () => {
    const path = minimapPath(points);
    expect(path.startsWith('M6 28 L94 28')).toBe(true);
    expect(path.endsWith('Z')).toBe(true);
    expect(path.match(/[ML]/g)).toHaveLength(points.length);
  });
});
