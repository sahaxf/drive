/**
 * Small deterministic noise toolkit (seeded value noise, fbm, ridged). Same seed,
 * same world: terrain, mountains and forest must agree with each other on every load.
 */
export interface Noise2D {
  /** Smooth value noise in [-1, 1]. */
  value(x: number, z: number): number;
  /** Fractal sum of `octaves` value-noise layers, roughly in [-1, 1]. */
  fbm(x: number, z: number, octaves?: number): number;
  /** Ridged multifractal in [0, 1]: sharp crests, good for mountain ranges. */
  ridged(x: number, z: number, octaves?: number): number;
}

export function createNoise(seed: number): Noise2D {
  const s = Math.imul(seed | 0, 0x9e3779b1) >>> 0;

  const hash = (ix: number, iz: number): number => {
    let h = (Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ s) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };

  const value = (x: number, z: number): number => {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const fx = x - ix;
    const fz = z - iz;
    const ux = fx * fx * (3 - 2 * fx);
    const uz = fz * fz * (3 - 2 * fz);
    const a = hash(ix, iz);
    const b = hash(ix + 1, iz);
    const c = hash(ix, iz + 1);
    const d = hash(ix + 1, iz + 1);
    return (a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz) * 2 - 1;
  };

  const fbm = (x: number, z: number, octaves = 5): number => {
    let sum = 0;
    let amp = 0.5;
    let freq = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      // Offset each octave so the lattices don't line up.
      sum += amp * value(x * freq + o * 17.31, z * freq - o * 9.73);
      norm += amp;
      amp *= 0.5;
      freq *= 2.03;
    }
    return sum / norm;
  };

  const ridged = (x: number, z: number, octaves = 5): number => {
    let sum = 0;
    let amp = 0.5;
    let freq = 1;
    let norm = 0;
    let weight = 1;
    for (let o = 0; o < octaves; o++) {
      let n = 1 - Math.abs(value(x * freq + o * 31.7, z * freq + o * 11.3));
      n *= n * weight;
      weight = Math.min(Math.max(n * 1.6, 0), 1);
      sum += amp * n;
      norm += amp;
      amp *= 0.5;
      freq *= 2.1;
    }
    return sum / norm;
  };

  return { value, fbm, ridged };
}

/** Deterministic PRNG for placement (mulberry32). */
export function createRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}
