import { BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import type { GeneratedTrack } from '../../track/generateTrack';
import { createNoise, smoothstep } from '../../track/noise';
import type { TerrainGrid, WorldField } from '../../track/terrain';
import { canopyTexture, groundDetailTexture } from '../textures';

/** Metres per repeat of the ground detail texture. */
const DETAIL_TILE = 7;
/** Metres per repeat of the forest canopy texture on the far slopes. */
const CANOPY_TILE = 45;
/** Grid cells per side of each terrain tile (129² vertices fit 16-bit indices). */
const TILE_CELLS = 128;
/** Depth of the curtain hung around the near terrain's edge so no gap shows at the seam. */
const SKIRT_DEPTH = 15;
/** Rock takes over from forest between these fractions of the mountains' peak height. */
const ROCK_FROM = 0.4;
const ROCK_TO = 0.68;

const PALETTE = {
  meadow: new Color('#6c8b38'),
  meadowDry: new Color('#8a9445'),
  forestFloor: new Color('#34431f'),
  verge: new Color('#6f8d3a'),
  dirt: new Color('#6e6248'),
  rock: new Color('#77746c'),
  forestFar: new Color('#24341a'),
};

/**
 * Colour by land cover and slope: meadows, darker forest floor under the trees,
 * earthy cuttings and rock on steep faces.
 */
function groundColour(
  out: Color,
  field: WorldField,
  variation: (x: number, z: number) => number,
  x: number,
  z: number,
  normalY: number,
  roadDistance: number,
  far: boolean,
): Color {
  const wood = field.woodedness(x, z);
  const n = variation(x / 90, z / 90);
  out.copy(PALETTE.meadow).lerp(PALETTE.meadowDry, smoothstep(-0.2, 0.6, n));
  out.lerp(far ? PALETTE.forestFar : PALETTE.forestFloor, wood);
  if (roadDistance < 6) out.lerp(PALETTE.verge, 1 - roadDistance / 6);
  const steep = smoothstep(0.88, 0.7, normalY);
  out.lerp(PALETTE.dirt, steep * 0.7);
  out.lerp(PALETTE.rock, smoothstep(0.72, 0.5, normalY));
  return out.multiplyScalar(0.92 + n * 0.08);
}

export function buildTerrainView(track: GeneratedTrack, anisotropy: number): Group {
  const t = track.terrain;
  const { nx, nz } = t;
  const normals = gridNormals(t);
  const colours = new Float32Array(nx * nz * 3);
  const variation = createNoise(track.spec.terrain.seed + 7).fbm;
  const colour = new Color();
  for (let zi = 0; zi < nz; zi++) {
    for (let xi = 0; xi < nx; xi++) {
      const c = zi * nx + xi;
      const x = t.originX + xi * t.resolution;
      const z = t.originZ + zi * t.resolution;
      groundColour(colour, track.field, variation, x, z, normals[c * 3 + 1]!, t.roadDistance[c]!, false);
      colour.toArray(colours, c * 3);
    }
  }

  const material = new MeshStandardMaterial({ vertexColors: true, map: groundDetailTexture(anisotropy), roughness: 1 });
  const group = new Group();
  group.name = 'terrain';
  // Square tiles rather than one big mesh, so the camera only draws the ones in view.
  for (let z0 = 0; z0 < nz - 1; z0 += TILE_CELLS) {
    for (let x0 = 0; x0 < nx - 1; x0 += TILE_CELLS) {
      const tile = new Mesh(
        tileGeometry(t, normals, colours, x0, z0, Math.min(x0 + TILE_CELLS, nx - 1), Math.min(z0 + TILE_CELLS, nz - 1)),
        material,
      );
      tile.receiveShadow = true;
      group.add(tile);
    }
  }
  const skirt = new Mesh(skirtGeometry(t, normals, colours), material);
  skirt.receiveShadow = true;
  group.add(skirt);
  return group;
}

/** Per-vertex normals of the height grid by central differences: identical across tile seams. */
function gridNormals(t: TerrainGrid): Float32Array {
  const { nx, nz, heights, resolution: res } = t;
  const out = new Float32Array(nx * nz * 3);
  const v = new Vector3();
  for (let zi = 0; zi < nz; zi++) {
    for (let xi = 0; xi < nx; xi++) {
      const xa = Math.max(xi - 1, 0);
      const xb = Math.min(xi + 1, nx - 1);
      const za = Math.max(zi - 1, 0);
      const zb = Math.min(zi + 1, nz - 1);
      const dx = (heights[zi * nx + xb]! - heights[zi * nx + xa]!) / ((xb - xa) * res);
      const dz = (heights[zb * nx + xi]! - heights[za * nx + xi]!) / ((zb - za) * res);
      v.set(-dx, 1, -dz).normalize().toArray(out, (zi * nx + xi) * 3);
    }
  }
  return out;
}

/** Grid vertices [x0, x1] × [z0, z1] as one mesh. */
function tileGeometry(
  t: TerrainGrid,
  normals: Float32Array,
  colours: Float32Array,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): BufferGeometry {
  const w = x1 - x0 + 1;
  const h = z1 - z0 + 1;
  const positions = new Float32Array(w * h * 3);
  const tileNormals = new Float32Array(w * h * 3);
  const tileColours = new Float32Array(w * h * 3);
  const uvs = new Float32Array(w * h * 2);
  for (let zi = z0; zi <= z1; zi++) {
    for (let xi = x0; xi <= x1; xi++) {
      const c = zi * t.nx + xi;
      const v = (zi - z0) * w + (xi - x0);
      const x = t.originX + xi * t.resolution;
      const z = t.originZ + zi * t.resolution;
      positions.set([x, t.heights[c]!, z], v * 3);
      uvs.set([x / DETAIL_TILE, z / DETAIL_TILE], v * 2);
      tileNormals.set(normals.subarray(c * 3, c * 3 + 3), v * 3);
      tileColours.set(colours.subarray(c * 3, c * 3 + 3), v * 3);
    }
  }
  const indices = new Uint16Array((w - 1) * (h - 1) * 6);
  let i = 0;
  for (let zi = 0; zi < h - 1; zi++) {
    for (let xi = 0; xi < w - 1; xi++) {
      const a = zi * w + xi;
      const b = a + w;
      // Normal up for +x right, +z down the grid.
      indices.set([a, b, a + 1, a + 1, b, b + 1], i);
      i += 6;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(tileNormals, 3));
  geometry.setAttribute('color', new BufferAttribute(tileColours, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(new BufferAttribute(indices, 1));
  return geometry;
}

/**
 * A curtain hung from the grid's outer edge, so no gap shows at the seam with the far
 * landscape. Lit and coloured like the ground above it.
 */
function skirtGeometry(t: TerrainGrid, normals: Float32Array, colours: Float32Array): BufferGeometry {
  const perimeter = perimeterIndices(t.nx, t.nz);
  const count = perimeter.length;
  const positions = new Float32Array(count * 2 * 3);
  const skirtNormals = new Float32Array(count * 2 * 3);
  const skirtColours = new Float32Array(count * 2 * 3);
  const uvs = new Float32Array(count * 2 * 2);
  perimeter.forEach((c, i) => {
    const x = t.originX + (c % t.nx) * t.resolution;
    const z = t.originZ + Math.floor(c / t.nx) * t.resolution;
    const y = t.heights[c]!;
    positions.set([x, y, z, x, y - SKIRT_DEPTH, z], i * 6);
    for (const v of [i * 2, i * 2 + 1]) {
      skirtNormals.set(normals.subarray(c * 3, c * 3 + 3), v * 3);
      skirtColours.set(colours.subarray(c * 3, c * 3 + 3), v * 3);
      uvs.set([x / DETAIL_TILE, z / DETAIL_TILE], v * 2);
    }
  });
  const indices: number[] = [];
  for (let i = 0; i < count; i++) {
    const top = i * 2;
    const bottom = top + 1;
    const nextTop = ((i + 1) % count) * 2;
    const nextBottom = nextTop + 1;
    // Both windings: the skirt is only ever seen edge-on, and this avoids caring about facing.
    indices.push(top, bottom, nextTop, nextTop, bottom, nextBottom, top, nextTop, bottom, nextTop, nextBottom, bottom);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(skirtNormals, 3));
  geometry.setAttribute('color', new BufferAttribute(skirtColours, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

/** Grid indices around the edge of an nx × nz grid, in order. */
function perimeterIndices(nx: number, nz: number): number[] {
  const out: number[] = [];
  for (let xi = 0; xi < nx - 1; xi++) out.push(xi);
  for (let zi = 0; zi < nz - 1; zi++) out.push(zi * nx + nx - 1);
  for (let xi = nx - 1; xi > 0; xi--) out.push((nz - 1) * nx + xi);
  for (let zi = nz - 1; zi > 0; zi--) out.push(zi * nx);
  return out;
}

/** The far landscape out to the horizon: forested foothills rising to rocky mountains. */
export function buildMountainView(track: GeneratedTrack, anisotropy: number): Mesh {
  const { xs, zs, heights, cellVisible } = track.far;
  const w = xs.length;
  const positions = new Float32Array(w * zs.length * 3);
  const uvs = new Float32Array(w * zs.length * 2);
  for (let zi = 0; zi < zs.length; zi++) {
    for (let xi = 0; xi < w; xi++) {
      const v = zi * w + xi;
      positions.set([xs[xi]!, heights[v]!, zs[zi]!], v * 3);
      uvs.set([xs[xi]! / CANOPY_TILE, zs[zi]! / CANOPY_TILE], v * 2);
    }
  }
  const indices: number[] = [];
  for (let zi = 0; zi < zs.length - 1; zi++) {
    for (let xi = 0; xi < w - 1; xi++) {
      if (!cellVisible(xi, zi)) continue;
      const a = zi * w + xi;
      const b = a + w;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const normals = geometry.getAttribute('normal');
  const variation = createNoise(track.spec.terrain.seed + 7).fbm;
  const { minX, maxX, minZ, maxZ } = track.field.bounds;
  const basin = track.field.natural((minX + maxX) / 2, (minZ + maxZ) / 2);
  const peak = track.spec.terrain.mountains.peakHeight;
  const colours = new Float32Array(positions.length);
  const colour = new Color();
  for (let v = 0; v < positions.length / 3; v++) {
    const x = positions[v * 3]!;
    const y = positions[v * 3 + 1]!;
    const z = positions[v * 3 + 2]!;
    groundColour(colour, track.field, variation, x, z, normals.getY(v), Infinity, true);
    colour.lerp(PALETTE.rock, smoothstep(basin + peak * ROCK_FROM, basin + peak * ROCK_TO, y));
    colour.toArray(colours, v * 3);
  }
  geometry.setAttribute('color', new BufferAttribute(colours, 3));

  const mesh = new Mesh(
    geometry,
    new MeshStandardMaterial({ vertexColors: true, map: canopyTexture(anisotropy), roughness: 1 }),
  );
  mesh.name = 'mountains';
  mesh.receiveShadow = true;
  return mesh;
}
