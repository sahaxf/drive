import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SPECIES_COUNT, Species, TREE_STRIDE } from '../../track/forest';
import type { GeneratedTrack } from '../../track/generateTrack';

/** Trees are split into square tiles so off-screen tiles are culled as a whole. */
const TILE_SIZE = 250;

const TRUNK = '#4b3a2a';
const SPRUCE = '#2c4724';
const SPRUCE_DARK = '#25391f';
const BROADLEAF = '#4f6e2c';

/** Paint a whole part one colour (stored as a vertex attribute, so one material serves all). */
function painted(geometry: BufferGeometry, colour: string, y: number): BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  g.translate(0, y, 0);
  const c = new Color(colour);
  const colours = new Float32Array(g.getAttribute('position').count * 3);
  for (let i = 0; i < colours.length; i += 3) c.toArray(colours, i);
  g.setAttribute('color', new BufferAttribute(colours, 3));
  g.deleteAttribute('uv');
  return g;
}

/** Low-poly, faceted trees in the spirit of late-90s racers, ~10-20 m tall after scaling. */
function treeGeometry(species: number): BufferGeometry {
  const parts: BufferGeometry[] = [];
  if (species === Species.Broadleaf) {
    parts.push(painted(new CylinderGeometry(0.22, 0.35, 5, 5), TRUNK, 2.5));
    parts.push(painted(new IcosahedronGeometry(3.4, 0), BROADLEAF, 7.2));
    parts.push(painted(new IcosahedronGeometry(2.4, 0).translate(1.6, 0, 0.8), BROADLEAF, 8.8));
    parts.push(painted(new IcosahedronGeometry(2.2, 0).translate(-1.4, 0, -1), BROADLEAF, 9.4));
  } else {
    const slim = species === Species.SpruceSlim;
    parts.push(painted(new CylinderGeometry(0.16, 0.3, 4, 5), TRUNK, 2));
    const tiers = slim ? 5 : 4;
    for (let t = 0; t < tiers; t++) {
      const f = t / tiers;
      const radius = (slim ? 2.0 : 2.8) * (1 - f * 0.8);
      const height = slim ? 4.2 : 4.6;
      parts.push(painted(new ConeGeometry(radius, height, 7), t % 2 ? SPRUCE_DARK : SPRUCE, 3.5 + t * (slim ? 2.6 : 2.7)));
    }
  }
  const merged = mergeGeometries(parts)!;
  merged.computeVertexNormals();
  return merged;
}

/** Distant tree: a single faceted cone on a stub, a fraction of the triangles of a near tree. */
function farTreeGeometry(): BufferGeometry {
  const merged = mergeGeometries([
    painted(new CylinderGeometry(0.3, 0.4, 3, 4), TRUNK, 1.5),
    painted(new ConeGeometry(3, 13, 6), SPRUCE_DARK, 8.5),
  ])!;
  merged.computeVertexNormals();
  return merged;
}

export function buildForestView(track: GeneratedTrack): Group {
  const group = new Group();
  group.name = 'forest';
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true });

  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();
  const up = new Vector3(0, 1, 0);
  const tint = new Color();

  const addTiled = (trees: Float32Array, geometry: BufferGeometry, castShadow: boolean) => {
    // Bucket tree indices by tile.
    const tiles = new Map<string, number[]>();
    for (let i = 0; i < trees.length; i += TREE_STRIDE) {
      const key = `${Math.floor(trees[i]! / TILE_SIZE)},${Math.floor(trees[i + 2]! / TILE_SIZE)}`;
      let bucket = tiles.get(key);
      if (!bucket) tiles.set(key, (bucket = []));
      bucket.push(i);
    }

    for (const bucket of tiles.values()) {
      const mesh = new InstancedMesh(geometry, material, bucket.length);
      bucket.forEach((i, n) => {
        const s = trees[i + 3]!;
        position.set(trees[i]!, trees[i + 1]!, trees[i + 2]!);
        rotation.setFromAxisAngle(up, trees[i + 4]!);
        // Slightly taller than wide for variety between otherwise identical models.
        scale.set(s, s * (0.9 + (trees[i + 4]! % 0.3)), s);
        matrix.compose(position, rotation, scale);
        mesh.setMatrixAt(n, matrix);
        const v = trees[i + 5]!;
        mesh.setColorAt(n, tint.setRGB(v * 0.97, v, v * 0.9));
      });
      mesh.castShadow = castShadow;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
  };

  for (let species = 0; species < SPECIES_COUNT; species++) {
    addTiled(track.forest.trees[species]!, treeGeometry(species), true);
  }
  // Far trees are hundreds of metres away: their shadows would never be seen.
  addTiled(track.forest.farTrees, farTreeGeometry(), false);
  return group;
}
