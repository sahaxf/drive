import RAPIER, { type World } from '@dimforge/rapier3d-compat';

export interface StaticBox {
  position: [number, number, number];
  halfExtents: [number, number, number];
  /** Quaternion [x, y, z, w]. */
  rotation?: [number, number, number, number];
  friction?: number;
}

export const PHYSICS_HZ = 120;
export const PHYSICS_DT = 1 / PHYSICS_HZ;

let initialised: Promise<void> | null = null;

/** Rapier ships as WASM and must be initialised once before any world is created. */
export function initPhysics(): Promise<void> {
  initialised ??= RAPIER.init();
  return initialised;
}

export function createWorld(): World {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = PHYSICS_DT;
  return world;
}

export function addStaticBoxes(world: World, boxes: readonly StaticBox[]): void {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  for (const box of boxes) {
    const [hx, hy, hz] = box.halfExtents;
    const [x, y, z] = box.position;
    const desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setTranslation(x, y, z)
      .setFriction(box.friction ?? 0.6);
    if (box.rotation) {
      const [qx, qy, qz, qw] = box.rotation;
      desc.setRotation({ x: qx, y: qy, z: qz, w: qw });
    }
    world.createCollider(desc, body);
  }
}
