import type { TrackSpec } from '@drivee/shared';
import type { TrackSpline } from './TrackSpline';

/** Plain geometry buffers: no Three.js objects, so physics and tests can use them headlessly. */
export interface MeshData {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

export interface RoadChunk {
  asphalt: MeshData;
  verge: MeshData;
  kerb: MeshData | null;
}

export interface RoadGeometry {
  chunks: RoadChunk[];
  /** Barrier post positions (xyz) around the loop, one closed line per side. */
  barriers: { left: Float32Array; right: Float32Array };
  startLine: MeshData;
}

export const CHUNK_SAMPLES = 100;
/** Metres of road covered by one repeat of the asphalt / grass / kerb textures. */
export const ASPHALT_TILE = 20;
export const GRASS_TILE = 4;
export const KERB_TILE = 2;
const KERB_LIFT = 0.04;
const KERB_EXTEND = 4;
const BARRIER_STRIDE = 2;
const BARRIER_GAP = 0.2;

class StripBuilder {
  private positions: number[] = [];
  private uvs: number[] = [];
  private indices: number[] = [];

  /** Two vertices per sample (inner, outer edge), stitched into quads. */
  addStrip(rows: Array<{ inner: number[]; outer: number[]; uvInner: number[]; uvOuter: number[] }>): void {
    const base = this.positions.length / 3;
    for (const row of rows) {
      this.positions.push(...row.inner, ...row.outer);
      this.uvs.push(...row.uvInner, ...row.uvOuter);
    }
    for (let r = 0; r < rows.length - 1; r++) {
      const a = base + r * 2;
      // Counter-clockwise seen from above (normal up) when inner is left of outer along travel.
      this.indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  get empty(): boolean {
    return this.indices.length === 0;
  }

  build(): MeshData {
    return {
      positions: new Float32Array(this.positions),
      uvs: new Float32Array(this.uvs),
      indices: new Uint32Array(this.indices),
    };
  }
}

export function buildRoadGeometry(spec: TrackSpec, spline: TrackSpline): RoadGeometry {
  const { vergeWidth, kerbRadius, kerbWidth } = spec.roadside;
  const point = (k: number, offset: number, lift: number): number[] => {
    const i = spline.wrap(k);
    return [0, 1, 2].map(
      (a) => spline.positions[i * 3 + a]! + spline.rights[i * 3 + a]! * offset + spline.ups[i * 3 + a]! * lift,
    );
  };
  const half = (k: number) => spline.widths[spline.wrap(k)]! / 2;
  const distance = (k: number) => k * spline.step;

  // Kerb side per sample: +1 right, -1 left, 0 none. Laid on the inside of tight corners.
  const kerbSide = new Int8Array(spline.count);
  for (let k = 0; k < spline.count; k++) {
    const c = spline.curvature[k]!;
    if (Math.abs(c) < 1 / kerbRadius) continue;
    for (let o = -KERB_EXTEND; o <= KERB_EXTEND; o++) kerbSide[spline.wrap(k + o)] = Math.sign(c);
  }

  const chunks: RoadChunk[] = [];
  for (let start = 0; start < spline.count; start += CHUNK_SAMPLES) {
    // Inclusive end so neighbouring chunks share their boundary row (no cracks).
    const end = Math.min(start + CHUNK_SAMPLES, spline.count);
    const asphalt = new StripBuilder();
    const verge = new StripBuilder();
    const kerb = new StripBuilder();

    const asphaltRows = [];
    const leftVerge = [];
    const rightVerge = [];
    for (let k = start; k <= end; k++) {
      const h = half(k);
      const v = distance(k);
      asphaltRows.push({
        inner: point(k, -h, 0),
        outer: point(k, h, 0),
        uvInner: [0, v / ASPHALT_TILE],
        uvOuter: [1, v / ASPHALT_TILE],
      });
      leftVerge.push({
        inner: point(k, -h - vergeWidth, 0),
        outer: point(k, -h, 0),
        uvInner: [0, v / GRASS_TILE],
        uvOuter: [vergeWidth / GRASS_TILE, v / GRASS_TILE],
      });
      rightVerge.push({
        inner: point(k, h, 0),
        outer: point(k, h + vergeWidth, 0),
        uvInner: [0, v / GRASS_TILE],
        uvOuter: [vergeWidth / GRASS_TILE, v / GRASS_TILE],
      });
    }
    asphalt.addStrip(asphaltRows);
    verge.addStrip(leftVerge);
    verge.addStrip(rightVerge);

    // Kerb runs: contiguous samples with the same side.
    let k = start;
    while (k <= end) {
      const side = kerbSide[spline.wrap(k)]!;
      if (side === 0) {
        k++;
        continue;
      }
      const rows = [];
      while (k <= end && kerbSide[spline.wrap(k)] === side) {
        const h = half(k);
        const v = distance(k) / KERB_TILE;
        const near = side * (h - 0.05);
        const far = side * (h + kerbWidth);
        // Keep the strip winding consistent: inner is always the left-most edge.
        const [a, b] = side > 0 ? [near, far] : [far, near];
        rows.push({ inner: point(k, a, KERB_LIFT), outer: point(k, b, KERB_LIFT), uvInner: [0, v], uvOuter: [1, v] });
        k++;
      }
      if (rows.length > 1) kerb.addStrip(rows);
    }

    chunks.push({ asphalt: asphalt.build(), verge: verge.build(), kerb: kerb.empty ? null : kerb.build() });
  }

  const posts = (side: 1 | -1): Float32Array => {
    const out: number[] = [];
    for (let k = 0; k < spline.count; k += BARRIER_STRIDE) {
      out.push(...point(k, side * (half(k) + vergeWidth + BARRIER_GAP), 0));
    }
    return new Float32Array(out);
  };

  return {
    chunks,
    barriers: { left: posts(-1), right: posts(1) },
    startLine: buildStartLine(spec, spline),
  };
}

function buildStartLine(spec: TrackSpec, spline: TrackSpline): MeshData {
  const strip = new StripBuilder();
  const rows = [];
  for (const d of [-0.9, 0.9]) {
    const f = spline.frameAt(spec.race.startDistance + d);
    const h = f.width / 2;
    const at = (o: number) => [0, 1, 2].map((a) => {
      const key = (['x', 'y', 'z'] as const)[a]!;
      return f.position[key] + f.right[key] * o + f.up[key] * 0.015;
    });
    const v = d < 0 ? 0 : 1;
    rows.push({ inner: at(-h), outer: at(h), uvInner: [0, v], uvOuter: [1, v] });
  }
  strip.addStrip(rows);
  return strip.build();
}
