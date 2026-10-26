import type { TrackSpec } from '@drivee/shared';
import type { TerrainGrid, WorldField } from './terrain';

/** Ring spacing: fine at the near-terrain edge, coarsening toward the horizon. */
const FIRST_STEP = 40;
const GROWTH = 1.045;
const INNER_STEP = 40;
/** The far grid sits slightly under the near terrain where they meet, hiding any crack. */
const SEAM_DROP = 1.5;

/**
 * Landscape from the near-terrain edge out to the horizon: a grid with a hole where the
 * near terrain is. Heights come from the same world field, so hills run on seamlessly
 * into the mountain ring. Row-major: index = zi * xs.length + xi.
 */
export interface FarTerrain {
  xs: Float64Array;
  zs: Float64Array;
  heights: Float32Array;
  /** Whether a cell (by its lower corner indices) is part of the mesh. */
  cellVisible(xi: number, zi: number): boolean;
  /** Height of the rendered surface (matching its triangulation), or null in the hole. */
  surfaceHeight(x: number, z: number): number | null;
}

export function buildFarTerrain(spec: TrackSpec, field: WorldField, near: TerrainGrid): FarTerrain {
  const minX = near.originX;
  const minZ = near.originZ;
  const maxX = near.originX + (near.nx - 1) * near.resolution;
  const maxZ = near.originZ + (near.nz - 1) * near.resolution;
  const reach = spec.terrain.mountains.outerRadius;
  const xs = Float64Array.from(axis(minX, maxX, reach));
  const zs = Float64Array.from(axis(minZ, maxZ, reach));

  const onNearRect = (x: number, z: number) => x >= minX && x <= maxX && z >= minZ && z <= maxZ;
  const heights = new Float32Array(xs.length * zs.length);
  for (let zi = 0; zi < zs.length; zi++) {
    for (let xi = 0; xi < xs.length; xi++) {
      const x = xs[xi]!;
      const z = zs[zi]!;
      heights[zi * xs.length + xi] = field.natural(x, z) - (onNearRect(x, z) ? SEAM_DROP : 0);
    }
  }

  const cellVisible = (xi: number, zi: number): boolean => {
    const cx = (xs[xi]! + xs[xi + 1]!) / 2;
    const cz = (zs[zi]! + zs[zi + 1]!) / 2;
    return !(cx > minX && cx < maxX && cz > minZ && cz < maxZ);
  };

  const surfaceHeight = (x: number, z: number): number | null => {
    const xi = upperBound(xs, x) - 1;
    const zi = upperBound(zs, z) - 1;
    if (xi < 0 || zi < 0 || xi >= xs.length - 1 || zi >= zs.length - 1 || !cellVisible(xi, zi)) return null;
    const u = (x - xs[xi]!) / (xs[xi + 1]! - xs[xi]!);
    const v = (z - zs[zi]!) / (zs[zi + 1]! - zs[zi]!);
    const w = xs.length;
    const ha = heights[zi * w + xi]!;
    const hb = heights[(zi + 1) * w + xi]!;
    const hc = heights[zi * w + xi + 1]!;
    const hd = heights[(zi + 1) * w + xi + 1]!;
    // Same diagonal as the mesh: triangles (a, b, c) and (c, b, d).
    if (u + v <= 1) return ha + (hc - ha) * u + (hb - ha) * v;
    return hd + (hb - hd) * (1 - u) + (hc - hd) * (1 - v);
  };

  return { xs, zs, heights, cellVisible, surfaceHeight };
}

/** Coordinates: geometric steps outward from each side of [min, max], uniform steps between. */
function axis(min: number, max: number, reach: number): number[] {
  const outward: number[] = [];
  let step = FIRST_STEP;
  for (let d = step; d < reach; d += step, step *= GROWTH) outward.push(d);
  const inner: number[] = [];
  const segments = Math.max(1, Math.round((max - min) / INNER_STEP));
  for (let s = 0; s <= segments; s++) inner.push(min + ((max - min) * s) / segments);
  const below = outward.map((d) => min - d).reverse();
  const above = outward.map((d) => max + d);
  return [...below, ...inner, ...above];
}

/** First index whose value is greater than `value`. */
function upperBound(sorted: Float64Array, value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
