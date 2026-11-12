import { describe, expect, it } from 'vitest';
import { sharpestCorners } from '../src/render/heroShots';

/** A 2 km loop sampled every 2 m: straight apart from the given corners (index → curvature). */
function spline(corners: Record<number, number>) {
  const curvature = new Float32Array(1000);
  for (const [i, k] of Object.entries(corners)) curvature[Number(i)] = k;
  return { curvature, step: 2, length: 2000 };
}

describe('sharpestCorners', () => {
  it('picks the sharpest corners, apart from each other and from the start', () => {
    const corners = sharpestCorners(
      spline({ 10: 0.05, 200: -0.04, 210: -0.045, 500: 0.02, 800: 0.03 }),
      0,
      3,
    );
    // Index 10 is 20 m from the start; 200 sits right next to the sharper 210.
    expect(corners).toEqual([
      { distance: 420, turn: -1 },
      { distance: 1600, turn: 1 },
      { distance: 1000, turn: 1 },
    ]);
  });

  it('skips bends too gentle to be corners', () => {
    expect(sharpestCorners(spline({ 300: 0.002 }), 0, 3)).toEqual([]);
  });
});
