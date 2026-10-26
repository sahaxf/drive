import type { TrackSpec } from '@drivee/shared';
import type { FarTerrain } from './farTerrain';
import { createRandom } from './noise';
import type { TerrainGrid, WorldField } from './terrain';

export const Species = {
  SpruceTall: 0,
  SpruceSlim: 1,
  Broadleaf: 2,
} as const;
export const SPECIES_COUNT = 3;

/** Packed per tree: x, y, z, scale, rotationY, tint. */
export const TREE_STRIDE = 6;

export interface ForestPlacement {
  /** One packed array per species. */
  trees: Float32Array[];
  /** Simplified distant trees on the far slopes (same packing). */
  farTrees: Float32Array;
  count: number;
}

/** Keep trees off slopes steeper than this (rise over run). */
const MAX_SLOPE = 0.75;
/** Chance of a lone tree standing in a meadow. */
const MEADOW_TREES = 0.025;
/** Leave the outermost strip of near terrain bare so no tree hangs over its edge. */
const EDGE_MARGIN = 12;
/** Distant trees continue this far beyond the near terrain, thinning out with distance. */
const FAR_BAND = 1800;
const FAR_DENSITY = 32;
/** Trees give way to rock above this fraction of the mountains' peak height. */
const TREELINE = 0.42;

/**
 * Jittered-grid placement: even coverage without visible rows, deterministic per seed.
 * Trees stay clear of the road and barriers, off steep slopes, and mostly out of meadows.
 */
export function placeForest(
  spec: TrackSpec,
  field: WorldField,
  terrain: TerrainGrid,
  far: FarTerrain,
): ForestPlacement {
  const f = spec.forest;
  const random = createRandom(f.seed);
  const spacing = Math.sqrt(10_000 / f.density);
  const clearance = f.clearance;
  const out: number[][] = Array.from({ length: SPECIES_COUNT }, () => []);
  let count = 0;

  const minX = terrain.originX + EDGE_MARGIN;
  const minZ = terrain.originZ + EDGE_MARGIN;
  const maxX = terrain.originX + (terrain.nx - 1) * terrain.resolution - EDGE_MARGIN;
  const maxZ = terrain.originZ + (terrain.nz - 1) * terrain.resolution - EDGE_MARGIN;

  for (let gz = minZ; gz < maxZ; gz += spacing) {
    for (let gx = minX; gx < maxX; gx += spacing) {
      const x = gx + (random() - 0.5) * spacing * 0.9;
      const z = gz + (random() - 0.5) * spacing * 0.9;
      const chance = Math.max(field.woodedness(x, z), MEADOW_TREES);
      const roll = random();
      const kind = random();
      const scale = 0.75 + random() * 0.7;
      const rotation = random() * Math.PI * 2;
      const tint = 0.82 + random() * 0.3;
      if (roll > chance) continue;
      // Bigger trees need more room from the barrier so their canopy doesn't overhang it.
      if (terrain.roadDistanceAt(x, z) < clearance + scale * 2.5) continue;
      const h = terrain.heightAt(x, z);
      const r = terrain.resolution;
      const slope = Math.hypot(terrain.heightAt(x + r, z) - h, terrain.heightAt(x, z + r) - h) / r;
      if (slope > MAX_SLOPE) continue;

      const species =
        kind < f.broadleaf ? Species.Broadleaf : kind < f.broadleaf + (1 - f.broadleaf) * 0.45 ? Species.SpruceSlim : Species.SpruceTall;
      // Sink the trunk slightly so it never floats on a slope.
      out[species]!.push(x, h - 0.3, z, scale, rotation, tint);
      count++;
    }
  }
  const farTrees = placeFarForest(spec, field, terrain, far);
  count += farTrees.length / TREE_STRIDE;
  return { trees: out.map((a) => new Float32Array(a)), farTrees, count };
}

/**
 * Sparser, bigger trees on the far slopes so the forest runs on to the mountains instead
 * of stopping at the edge of the near terrain. Seated on the far mesh's rendered surface.
 */
function placeFarForest(spec: TrackSpec, field: WorldField, near: TerrainGrid, far: FarTerrain): Float32Array {
  const random = createRandom(spec.forest.seed + 1);
  const spacing = Math.sqrt(10_000 / FAR_DENSITY);
  const minX = near.originX;
  const minZ = near.originZ;
  const maxX = near.originX + (near.nx - 1) * near.resolution;
  const maxZ = near.originZ + (near.nz - 1) * near.resolution;
  const basin = field.natural((minX + maxX) / 2, (minZ + maxZ) / 2);
  const treeline = basin + spec.terrain.mountains.peakHeight * TREELINE;
  const out: number[] = [];

  for (let gz = minZ - FAR_BAND; gz < maxZ + FAR_BAND; gz += spacing) {
    for (let gx = minX - FAR_BAND; gx < maxX + FAR_BAND; gx += spacing) {
      const x = gx + (random() - 0.5) * spacing * 0.9;
      const z = gz + (random() - 0.5) * spacing * 0.9;
      const roll = random();
      const scale = 1.1 + random() * 0.7;
      const rotation = random() * Math.PI * 2;
      const tint = 0.8 + random() * 0.3;
      if (x > minX && x < maxX && z > minZ && z < maxZ) continue;
      const beyond = Math.hypot(Math.max(minX - x, 0, x - maxX), Math.max(minZ - z, 0, z - maxZ));
      // Thin out gradually so there's no visible outer edge either.
      if (roll > field.woodedness(x, z) * (1 - (beyond / FAR_BAND) ** 2)) continue;
      const h = far.surfaceHeight(x, z);
      if (h === null || h > treeline) continue;
      const hx = far.surfaceHeight(x + 15, z);
      const hz = far.surfaceHeight(x, z + 15);
      if (hx === null || hz === null || Math.hypot(hx - h, hz - h) / 15 > MAX_SLOPE) continue;
      out.push(x, h - 0.8, z, scale, rotation, tint);
    }
  }
  return new Float32Array(out);
}
