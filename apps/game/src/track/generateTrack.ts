import RAPIER, { type World } from '@dimforge/rapier3d-compat';
import { Euler, Quaternion } from 'three';
import type { TrackSpec } from '@drivee/shared';
import { buildFarTerrain, type FarTerrain } from './farTerrain';
import { placeForest, type ForestPlacement } from './forest';
import { buildRoadGeometry, type MeshData, type RoadGeometry } from './road';
import { buildTerrainGrid, createWorldField, type TerrainGrid, type WorldField } from './terrain';
import { TrackSpline } from './TrackSpline';

/** Everything derived from track.json, with no rendering objects: usable headlessly. */
export interface GeneratedTrack {
  spec: TrackSpec;
  spline: TrackSpline;
  field: WorldField;
  terrain: TerrainGrid;
  far: FarTerrain;
  road: RoadGeometry;
  forest: ForestPlacement;
}

export type GenerationStep = 'road' | 'terrain' | 'forest';

export async function generateTrack(
  spec: TrackSpec,
  onStep: (step: GenerationStep) => Promise<void> | void = () => {},
): Promise<GeneratedTrack> {
  await onStep('road');
  const spline = TrackSpline.fromSpec(spec);
  const road = buildRoadGeometry(spec, spline);
  await onStep('terrain');
  const field = createWorldField(spec, spline);
  const terrain = buildTerrainGrid(spec, spline, field);
  const far = buildFarTerrain(spec, field, terrain);
  await onStep('forest');
  const forest = placeForest(spec, field, terrain, far);
  return { spec, spline, field, terrain, far, road, forest };
}

/** Grip multipliers by surface, read by the tyre model through the wheel's ground contact. */
export const SURFACE_GRIP = {
  asphalt: 1,
  kerb: 0.95,
  verge: 0.65,
  terrain: 0.55,
} as const;
export type Surface = keyof typeof SURFACE_GRIP;

const BARRIER_HALF_HEIGHT = 0.6;
const BARRIER_HALF_THICKNESS = 0.15;

/** Adds road, verge, kerb, barrier and terrain colliders. Returns a collider → grip lookup. */
export function addTrackPhysics(world: World, track: GeneratedTrack): (colliderHandle: number) => number {
  const surfaces = new Map<number, Surface>();
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const addMesh = (mesh: MeshData, surface: Surface) => {
    const collider = world.createCollider(
      RAPIER.ColliderDesc.trimesh(mesh.positions, mesh.indices).setFriction(0.8),
      body,
    );
    surfaces.set(collider.handle, surface);
  };

  for (const chunk of track.road.chunks) {
    addMesh(chunk.asphalt, 'asphalt');
    addMesh(chunk.verge, 'verge');
    if (chunk.kerb) addMesh(chunk.kerb, 'kerb');
  }

  for (const line of [track.road.barriers.left, track.road.barriers.right]) addBarrier(world, body, line);

  const t = track.terrain;
  // Rapier heightfields are column-major with rows along Z: index = xi * nz + zi.
  const heights = new Float32Array(t.nx * t.nz);
  for (let zi = 0; zi < t.nz; zi++) {
    for (let xi = 0; xi < t.nx; xi++) heights[xi * t.nz + zi] = t.heights[zi * t.nx + xi]!;
  }
  const width = (t.nx - 1) * t.resolution;
  const depth = (t.nz - 1) * t.resolution;
  const terrain = world.createCollider(
    RAPIER.ColliderDesc.heightfield(t.nz - 1, t.nx - 1, heights, { x: width, y: 1, z: depth })
      .setTranslation(t.originX + width / 2, 0, t.originZ + depth / 2)
      .setFriction(0.8),
    body,
  );
  surfaces.set(terrain.handle, 'terrain');

  return (handle) => SURFACE_GRIP[surfaces.get(handle) ?? 'asphalt'];
}

/** One thin box per span between barrier posts, tall enough that the car can't roll over it. */
function addBarrier(world: World, body: RAPIER.RigidBody, posts: Float32Array): void {
  const count = posts.length / 3;
  const euler = new Euler(0, 0, 0, 'YXZ');
  const q = new Quaternion();
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    const ax = posts[i * 3]!;
    const ay = posts[i * 3 + 1]!;
    const az = posts[i * 3 + 2]!;
    const dx = posts[j * 3]! - ax;
    const dy = posts[j * 3 + 1]! - ay;
    const dz = posts[j * 3 + 2]! - az;
    const length = Math.hypot(dx, dy, dz);
    euler.set(-Math.asin(dy / length), Math.atan2(dx, dz), 0);
    q.setFromEuler(euler);
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(BARRIER_HALF_THICKNESS, BARRIER_HALF_HEIGHT, length / 2 + 0.05)
        .setTranslation(ax + dx / 2, ay + dy / 2 + BARRIER_HALF_HEIGHT - 0.1, az + dz / 2)
        .setRotation(q)
        .setFriction(0.2),
      body,
    );
  }
}
