import type { TrackSpec } from '@drivee/shared';
import { createNoise, smoothstep } from './noise';
import type { TrackSpline } from './TrackSpline';

/** How far mountains take to rise from the foothills to full height, m. */
const MOUNTAIN_RAMP = 2500;
const MOUNTAIN_SCALE = 2600;
/** Spline samples skipped between points of the regional height average. */
const REGIONAL_STRIDE = 25;
const REGIONAL_FALLOFF = 250;

/**
 * Height and land-cover functions for the whole world. Near terrain, far mountains and
 * forest all sample these, so they agree where they meet.
 */
export interface WorldField {
  /** Ground height ignoring the road (hills + mountains), m. */
  natural(x: number, z: number): number;
  /** 0 = meadow, 1 = forest. */
  woodedness(x: number, z: number): number;
  /** Track bounding box in xz, before margins. */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

export function createWorldField(spec: TrackSpec, spline: TrackSpline): WorldField {
  const t = spec.terrain;
  const hills = createNoise(t.seed);
  const peaks = createNoise(t.seed + 101);
  const cover = createNoise(spec.forest.seed);

  const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  const anchors: number[] = [];
  for (let k = 0; k < spline.count; k++) {
    const x = spline.positions[k * 3]!;
    const z = spline.positions[k * 3 + 2]!;
    bounds.minX = Math.min(bounds.minX, x);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minZ = Math.min(bounds.minZ, z);
    bounds.maxZ = Math.max(bounds.maxZ, z);
    if (k % REGIONAL_STRIDE === 0) anchors.push(x, spline.positions[k * 3 + 1]!, z);
  }

  // Smooth "valley floor" that follows the road's elevation, so hills sit on top of the
  // landscape the road runs through instead of forcing huge cuttings and embankments.
  const regional = (x: number, z: number): number => {
    let sum = 0;
    let weights = 0;
    for (let i = 0; i < anchors.length; i += 3) {
      const dx = anchors[i]! - x;
      const dz = anchors[i + 2]! - z;
      const w = 1 / (dx * dx + dz * dz + REGIONAL_FALLOFF * REGIONAL_FALLOFF);
      sum += anchors[i + 1]! * w;
      weights += w;
    }
    return sum / weights;
  };

  const mountainStart = t.margin + t.mountains.startOffset;
  const natural = (x: number, z: number): number => {
    const dx = Math.max(bounds.minX - x, 0, x - bounds.maxX);
    const dz = Math.max(bounds.minZ - z, 0, z - bounds.maxZ);
    const outside = Math.hypot(dx, dz);
    const rise = smoothstep(mountainStart, mountainStart + MOUNTAIN_RAMP, outside);
    const ridge = 0.3 + 0.7 * peaks.ridged(x / MOUNTAIN_SCALE, z / MOUNTAIN_SCALE, 5);
    return (
      regional(x, z) +
      t.hillHeight * hills.fbm(x / t.hillScale, z / t.hillScale, 5) +
      t.mountains.peakHeight * rise * ridge
    );
  };

  const threshold = (spec.forest.meadowAmount - 0.5) * 0.8;
  const woodedness = (x: number, z: number): number =>
    smoothstep(threshold - 0.06, threshold + 0.06, cover.fbm(x / 380 + 50, z / 380 - 20, 4));

  return { natural, woodedness, bounds };
}

/**
 * Near terrain: a regular height grid around the circuit with a corridor carved to sit
 * just under the road and verges, blending out into natural hills.
 * Row-major: index = zi * nx + xi.
 */
export interface TerrainGrid {
  originX: number;
  originZ: number;
  resolution: number;
  nx: number;
  nz: number;
  heights: Float32Array;
  /** Horizontal distance from each vertex to the road footprint edge (0 inside), m. */
  roadDistance: Float32Array;
  heightAt(x: number, z: number): number;
  roadDistanceAt(x: number, z: number): number;
}

export function buildTerrainGrid(spec: TrackSpec, spline: TrackSpline, field: WorldField): TerrainGrid {
  const t = spec.terrain;
  const res = t.resolution;
  const { minX, maxX, minZ, maxZ } = field.bounds;
  const originX = Math.floor((minX - t.margin) / res) * res;
  const originZ = Math.floor((minZ - t.margin) / res) * res;
  const nx = Math.ceil((maxX + t.margin - originX) / res) + 1;
  const nz = Math.ceil((maxZ + t.margin - originZ) / res) + 1;

  const verge = spec.roadside.vergeWidth;
  const centreDist = new Float32Array(nx * nz).fill(Infinity);
  const footprint = new Float32Array(nx * nz);
  const roadY = new Float32Array(nx * nz);

  // Stamp each centreline segment into the cells around it: far cheaper than a
  // nearest-road query per vertex.
  for (let k = 0; k < spline.count; k++) {
    const k1 = spline.wrap(k + 1);
    const ax = spline.positions[k * 3]!;
    const ay = spline.positions[k * 3 + 1]!;
    const az = spline.positions[k * 3 + 2]!;
    const sx = spline.positions[k1 * 3]! - ax;
    const sy = spline.positions[k1 * 3 + 1]! - ay;
    const sz = spline.positions[k1 * 3 + 2]! - az;
    const len2 = sx * sx + sz * sz;
    const half = spline.widths[k]! / 2 + verge;
    // Cross slope of the banked road per metre of horizontal offset to the right.
    const rx = spline.rights[k * 3]!;
    const ry = spline.rights[k * 3 + 1]!;
    const rz = spline.rights[k * 3 + 2]!;
    const slope = ry / Math.hypot(rx, rz);
    const flatRx = -spline.tangents[k * 3 + 2]!;
    const flatRz = spline.tangents[k * 3]!;
    const flatLen = Math.hypot(flatRx, flatRz);
    const reach = half + t.corridorOuter;

    const x0 = Math.max(0, Math.floor((Math.min(ax, ax + sx) - reach - originX) / res));
    const x1 = Math.min(nx - 1, Math.ceil((Math.max(ax, ax + sx) + reach - originX) / res));
    const z0 = Math.max(0, Math.floor((Math.min(az, az + sz) - reach - originZ) / res));
    const z1 = Math.min(nz - 1, Math.ceil((Math.max(az, az + sz) + reach - originZ) / res));
    for (let zi = z0; zi <= z1; zi++) {
      const z = originZ + zi * res;
      for (let xi = x0; xi <= x1; xi++) {
        const x = originX + xi * res;
        const f = Math.min(Math.max(((x - ax) * sx + (z - az) * sz) / len2, 0), 1);
        const px = ax + sx * f;
        const pz = az + sz * f;
        const d = Math.hypot(x - px, z - pz);
        const c = zi * nx + xi;
        if (d >= centreDist[c]!) continue;
        centreDist[c] = d;
        footprint[c] = half;
        const lateral = ((x - px) * flatRx + (z - pz) * flatRz) / flatLen;
        const clamped = Math.max(-half, Math.min(half, lateral));
        roadY[c] = ay + sy * f + clamped * slope;
      }
    }
  }

  const heights = new Float32Array(nx * nz);
  const roadDistance = new Float32Array(nx * nz);
  for (let zi = 0; zi < nz; zi++) {
    for (let xi = 0; xi < nx; xi++) {
      const c = zi * nx + xi;
      const x = originX + xi * res;
      const z = originZ + zi * res;
      const natural = field.natural(x, z);
      if (!Number.isFinite(centreDist[c]!)) {
        heights[c] = natural;
        roadDistance[c] = Infinity;
        continue;
      }
      const beyond = Math.max(0, centreDist[c]! - footprint[c]!);
      roadDistance[c] = beyond;
      const blend = smoothstep(t.corridorInner, t.corridorOuter, beyond);
      heights[c] = roadY[c]! - t.roadDrop + (natural - (roadY[c]! - t.roadDrop)) * blend;
    }
  }

  const bilinear = (data: Float32Array, x: number, z: number): number => {
    const fx = Math.min(Math.max((x - originX) / res, 0), nx - 1.001);
    const fz = Math.min(Math.max((z - originZ) / res, 0), nz - 1.001);
    const xi = Math.floor(fx);
    const zi = Math.floor(fz);
    const u = fx - xi;
    const v = fz - zi;
    const a = data[zi * nx + xi]!;
    const b = data[zi * nx + xi + 1]!;
    const c = data[(zi + 1) * nx + xi]!;
    const d = data[(zi + 1) * nx + xi + 1]!;
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };

  return {
    originX,
    originZ,
    resolution: res,
    nx,
    nz,
    heights,
    roadDistance,
    heightAt: (x, z) => bilinear(heights, x, z),
    roadDistanceAt: (x, z) => {
      // Infinity doesn't interpolate; use the nearest vertex instead.
      const xi = Math.round(Math.min(Math.max((x - originX) / res, 0), nx - 1));
      const zi = Math.round(Math.min(Math.max((z - originZ) / res, 0), nz - 1));
      return roadDistance[zi * nx + xi]!;
    },
  };
}
