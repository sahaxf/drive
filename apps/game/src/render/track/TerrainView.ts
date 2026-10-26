import { BufferAttribute, BufferGeometry, Color, Mesh, MeshStandardMaterial } from 'three';
import type { GeneratedTrack } from '../../track/generateTrack';
import { createNoise, smoothstep } from '../../track/noise';
import type { WorldField } from '../../track/terrain';
import { canopyTexture, groundDetailTexture } from '../textures';

/** Metres per repeat of the ground detail texture. */
const DETAIL_TILE = 7;
/** Metres per repeat of the forest canopy texture on the far slopes. */
const CANOPY_TILE = 45;
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

export function buildTerrainView(track: GeneratedTrack, anisotropy: number): Mesh {
  const t = track.terrain;
  const { nx, nz, resolution: res } = t;
  const gridCount = nx * nz;
  const perimeter = perimeterIndices(nx, nz);
  const vertexCount = gridCount + perimeter.length;

  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  for (let zi = 0; zi < nz; zi++) {
    for (let xi = 0; xi < nx; xi++) {
      const c = zi * nx + xi;
      const x = t.originX + xi * res;
      const z = t.originZ + zi * res;
      positions.set([x, t.heights[c]!, z], c * 3);
      uvs.set([x / DETAIL_TILE, z / DETAIL_TILE], c * 2);
    }
  }

  const indices: number[] = [];
  for (let zi = 0; zi < nz - 1; zi++) {
    for (let xi = 0; xi < nx - 1; xi++) {
      const a = zi * nx + xi;
      const b = a + nx;
      // Normal up for +x right, +z down the grid.
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }

  // Skirt: a copy of each edge vertex dropped straight down, stitched to the edge.
  perimeter.forEach((c, i) => {
    const s = gridCount + i;
    positions.set([positions[c * 3]!, positions[c * 3 + 1]! - SKIRT_DEPTH, positions[c * 3 + 2]!], s * 3);
    uvs.set([uvs[c * 2]!, uvs[c * 2 + 1]!], s * 2);
    const nextC = perimeter[(i + 1) % perimeter.length]!;
    const nextS = gridCount + ((i + 1) % perimeter.length);
    // Both windings: the skirt is only ever seen edge-on, and this avoids caring about facing.
    indices.push(c, s, nextC, nextC, s, nextS, c, nextC, s, nextC, nextS, s);
  });

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const normals = geometry.getAttribute('normal');
  // The skirt's opposing windings cancel its normals out; light it like the ground above.
  perimeter.forEach((c, i) => normals.setXYZ(gridCount + i, normals.getX(c), normals.getY(c), normals.getZ(c)));
  const colours = new Float32Array(vertexCount * 3);
  const variation = createNoise(track.spec.terrain.seed + 7).fbm;
  const colour = new Color();
  for (let c = 0; c < gridCount; c++) {
    groundColour(colour, track.field, variation, positions[c * 3]!, positions[c * 3 + 2]!, normals.getY(c), t.roadDistance[c]!, false);
    colour.toArray(colours, c * 3);
  }
  perimeter.forEach((c, i) => colours.copyWithin((gridCount + i) * 3, c * 3, c * 3 + 3));
  geometry.setAttribute('color', new BufferAttribute(colours, 3));

  const mesh = new Mesh(
    geometry,
    new MeshStandardMaterial({ vertexColors: true, map: groundDetailTexture(anisotropy), roughness: 1 }),
  );
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  return mesh;
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
