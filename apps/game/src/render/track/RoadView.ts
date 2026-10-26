import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
} from 'three';
import type { GeneratedTrack } from '../../track/generateTrack';
import type { MeshData } from '../../track/road';
import { asphaltTexture, bannerTexture, checkerTexture, grassTexture, kerbTexture } from '../textures';

const RAIL_BOTTOM = 0.42;
const RAIL_TOP = 0.78;
const POST_HEIGHT = 0.95;
const GANTRY_HEIGHT = 7;

export function buildRoadView(track: GeneratedTrack, anisotropy: number): Group {
  const group = new Group();
  group.name = 'road';

  const asphalt = new MeshStandardMaterial({ map: asphaltTexture(anisotropy), roughness: 0.88 });
  const grass = new MeshStandardMaterial({ map: grassTexture(anisotropy), roughness: 1 });
  const kerb = new MeshStandardMaterial({ map: kerbTexture(anisotropy), roughness: 0.7 });

  for (const chunk of track.road.chunks) {
    group.add(surface(chunk.asphalt, asphalt), surface(chunk.verge, grass));
    if (chunk.kerb) group.add(surface(chunk.kerb, kerb));
  }

  const line = surface(track.road.startLine, new MeshStandardMaterial({ map: checkerTexture(anisotropy), roughness: 0.8 }));
  line.material.polygonOffset = true;
  line.material.polygonOffsetFactor = -2;
  group.add(line);

  group.add(buildBarriers(track), buildGantry(track, anisotropy));
  return group;
}

function geometryFrom(data: MeshData): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
  geometry.setAttribute('uv', new BufferAttribute(data.uvs, 2));
  geometry.setIndex(new BufferAttribute(data.indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

function surface(data: MeshData, material: MeshStandardMaterial): Mesh<BufferGeometry, MeshStandardMaterial> {
  const mesh = new Mesh(geometryFrom(data), material);
  mesh.receiveShadow = true;
  return mesh;
}

/** Armco: a continuous galvanised band on posts, both sides of the road. */
function buildBarriers(track: GeneratedTrack): Group {
  const group = new Group();
  const steel = new MeshStandardMaterial({ color: '#b9bec3', metalness: 0.75, roughness: 0.35, side: DoubleSide });
  const postMaterial = new MeshStandardMaterial({ color: '#8d9296', metalness: 0.6, roughness: 0.5 });
  const postGeometry = new BoxGeometry(0.12, POST_HEIGHT, 0.12);

  for (const posts of [track.road.barriers.left, track.road.barriers.right]) {
    const count = posts.length / 3;
    const positions = new Float32Array((count + 1) * 2 * 3);
    const indices: number[] = [];
    for (let i = 0; i <= count; i++) {
      const p = (i % count) * 3;
      for (const [row, h] of [
        [0, RAIL_BOTTOM],
        [1, RAIL_TOP],
      ] as const) {
        const v = (i * 2 + row) * 3;
        positions[v] = posts[p]!;
        positions[v + 1] = posts[p + 1]! + h;
        positions[v + 2] = posts[p + 2]!;
      }
      if (i < count) {
        const a = i * 2;
        indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const rail = new BufferGeometry();
    rail.setAttribute('position', new BufferAttribute(positions, 3));
    rail.setIndex(indices);
    rail.computeVertexNormals();
    const railMesh = new Mesh(rail, steel);
    railMesh.castShadow = true;
    railMesh.receiveShadow = true;
    group.add(railMesh);

    const instanced = new InstancedMesh(postGeometry, postMaterial, count);
    const m = new Matrix4();
    for (let i = 0; i < count; i++) {
      m.makeTranslation(posts[i * 3]!, posts[i * 3 + 1]! + POST_HEIGHT / 2 - 0.1, posts[i * 3 + 2]!);
      instanced.setMatrixAt(i, m);
    }
    instanced.castShadow = true;
    group.add(instanced);
  }
  return group;
}

/** Start/finish gantry spanning the road outside the barriers. */
function buildGantry(track: GeneratedTrack, anisotropy: number): Object3D {
  const { spline, spec } = track;
  const frame = spline.frameAt(spec.race.startDistance);
  const span = frame.width / 2 + spec.roadside.vergeWidth + 1.4;
  const frameMaterial = new MeshStandardMaterial({ color: '#2a2f38', metalness: 0.6, roughness: 0.4 });

  const gantry = new Group();
  gantry.position.copy(frame.position);
  gantry.rotation.y = Math.atan2(frame.tangent.x, frame.tangent.z);
  for (const side of [-1, 1]) {
    const pillar = new Mesh(new BoxGeometry(0.5, GANTRY_HEIGHT + 1, 0.5), frameMaterial);
    pillar.position.set(side * span, (GANTRY_HEIGHT + 1) / 2 - 1, 0);
    pillar.castShadow = true;
    gantry.add(pillar);
  }
  const beam = new Mesh(new BoxGeometry(span * 2 + 0.5, 0.4, 0.5), frameMaterial);
  beam.position.y = GANTRY_HEIGHT;
  beam.castShadow = true;

  const banner = bannerTexture(spec.meta.name.toUpperCase(), anisotropy);
  const bannerMaterial = new MeshStandardMaterial({ map: banner, roughness: 0.6, emissive: '#ffffff', emissiveMap: banner, emissiveIntensity: 0.25 });
  for (const side of [-1, 1]) {
    const board = new Mesh(new PlaneGeometry(span * 1.4, span * 0.175), bannerMaterial);
    board.position.set(0, GANTRY_HEIGHT - 1.1, side * 0.27);
    // Face both approach directions; the back board is mirrored so its text reads correctly.
    board.rotation.y = side > 0 ? 0 : Math.PI;
    gantry.add(board);
  }
  gantry.add(beam);
  return gantry;
}
