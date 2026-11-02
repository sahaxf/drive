import {
  BoxGeometry,
  type BufferGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  type Object3D,
  type Quaternion,
  Shape,
  type Vector3,
} from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { CarSpec } from '@drivee/shared';
import type { WheelId, WheelState } from '../vehicle/Vehicle';

interface WheelNodes {
  /** Positioned at the hub; moves with suspension. */
  hub: Group;
  /** Rotates about Y for steering. */
  steer: Group;
  /** Rotates about X for rolling. */
  spin: Group;
}

/**
 * Procedural placeholder car until the CC0 models arrive (M5). Nodes use the same
 * logical names (`body`, `wheel_FL`, ...) that car.json mappings will target.
 */
export class CarView {
  readonly root = new Group();
  private readonly wheels = new Map<WheelId, WheelNodes>();
  private readonly brakeLight: MeshStandardMaterial;
  private readonly reverseLight: MeshStandardMaterial;

  constructor(private readonly spec: CarSpec) {
    const paint = new MeshPhysicalMaterial({
      color: spec.visual.paintColor,
      metalness: 0.15,
      roughness: 0.38,
      clearcoat: 0.8,
      clearcoatRoughness: 0.08,
      envMapIntensity: 0.6,
    });
    const glass = new MeshPhysicalMaterial({ color: '#0d1116', metalness: 0.1, roughness: 0.04, clearcoat: 1 });
    const trim = new MeshStandardMaterial({ color: '#141414', roughness: 0.55 });
    this.brakeLight = new MeshStandardMaterial({ color: '#4a0000', emissive: '#ff1a10', emissiveIntensity: 0.3 });
    this.reverseLight = new MeshStandardMaterial({ color: '#cccccc', emissive: '#ffffff', emissiveIntensity: 0 });
    const headLight = new MeshStandardMaterial({ color: '#fff', emissive: '#fff6dd', emissiveIntensity: 1.5 });

    const [hx, , hz] = spec.chassis.halfExtents;
    const body = new Group();
    body.name = 'body';
    body.add(
      shadowed(new Mesh(new RoundedBoxGeometry(hx * 2, 0.5, hz * 2, 6, 0.21), paint), 0, -0.06, 0),
      shadowed(new Mesh(cabinGeometry(hx * 1.6), glass), 0, 0, 0),
      // Rear wing and its two posts.
      shadowed(new Mesh(new RoundedBoxGeometry(hx * 1.85, 0.05, 0.36, 2, 0.022), trim), 0, 0.48, -hz + 0.2),
      shadowed(new Mesh(new RoundedBoxGeometry(0.06, 0.28, 0.16, 2, 0.025), trim), 0.5, 0.32, -hz + 0.22),
      shadowed(new Mesh(new RoundedBoxGeometry(0.06, 0.28, 0.16, 2, 0.025), trim), -0.5, 0.32, -hz + 0.22),
      // Front splitter.
      shadowed(new Mesh(new RoundedBoxGeometry(hx * 1.9, 0.04, 0.3, 2, 0.018), trim), 0, -0.3, hz - 0.1),
    );
    for (const side of [1, -1]) {
      body.add(
        at(new Mesh(new RoundedBoxGeometry(0.36, 0.08, 0.04, 2, 0.018), headLight), side * 0.6, 0.02, hz + 0.005),
        at(new Mesh(new RoundedBoxGeometry(0.42, 0.07, 0.04, 2, 0.018), this.brakeLight), side * 0.58, 0.06, -hz - 0.005),
        at(new Mesh(new RoundedBoxGeometry(0.12, 0.06, 0.04, 2, 0.018), this.reverseLight), side * 0.25, 0.06, -hz - 0.005),
      );
    }
    this.root.add(body);

    for (const id of ['FL', 'FR', 'RL', 'RR'] as const) {
      this.wheels.set(id, this.buildWheel(id));
    }
  }

  update(position: Vector3, rotation: Quaternion, wheels: readonly WheelState[], braking: boolean, reversing: boolean): void {
    this.root.position.copy(position);
    this.root.quaternion.copy(rotation);
    for (const w of wheels) {
      const nodes = this.wheels.get(w.id)!;
      nodes.hub.position.set(w.mount.x, w.mount.y - w.length, w.mount.z);
      nodes.steer.rotation.y = w.steerAngle;
      nodes.spin.rotation.x = w.spinAngle;
    }
    this.brakeLight.emissiveIntensity = braking ? 4 : 0.3;
    this.reverseLight.emissiveIntensity = reversing ? 2 : 0;
  }

  private buildWheel(id: WheelId): WheelNodes {
    const { radius, width } = this.spec.wheels;
    const left = id.endsWith('L');
    const hub = new Group();
    hub.name = `wheel_${id}`;
    const steer = new Group();
    const spin = new Group();
    hub.add(steer);
    steer.add(spin);

    const rubber = new MeshStandardMaterial({ color: '#161616', roughness: 0.9 });
    const rim = new MeshStandardMaterial({ color: '#c9ccd1', metalness: 1, roughness: 0.25 });

    const tyre = new Mesh(new CylinderGeometry(radius, radius, width, 32), rubber);
    tyre.rotation.z = Math.PI / 2;
    spin.add(shadowed(tyre, 0, 0, 0));

    // Rim face on the outside of the car, with spokes so rotation is visible.
    const outward = left ? 1 : -1;
    const face = new Mesh(new CylinderGeometry(radius * 0.68, radius * 0.68, 0.02, 24), rim);
    face.rotation.z = Math.PI / 2;
    spin.add(at(face, outward * (width / 2 + 0.005), 0, 0));
    for (let k = 0; k < 5; k++) {
      const spoke = new Mesh(new BoxGeometry(0.03, radius * 1.25, 0.05), rim);
      spoke.rotation.x = (k / 5) * Math.PI;
      spin.add(at(spoke, outward * (width / 2 + 0.02), 0, 0));
    }

    this.root.add(hub);
    return { hub, steer, spin };
  }
}

/**
 * Greenhouse as a side profile extruded across the car, so the windscreen and rear
 * window sweep down into the bonnet and rear deck instead of standing up as a box.
 * The bevel rounds the sides and grows the outline by `round`, so the profile is drawn
 * that much inside the visible shape; its foot dips below the body's top to hide the seam.
 */
function cabinGeometry(width: number): BufferGeometry {
  const round = 0.1;
  const profile = new Shape()
    .moveTo(1.35, 0)
    .lineTo(1.35, 0.1)
    .bezierCurveTo(0.85, 0.13, 0.52, 0.48, 0.25, 0.5)
    .quadraticCurveTo(-0.25, 0.53, -0.72, 0.5)
    .bezierCurveTo(-1.02, 0.49, -1.4, 0.13, -1.8, 0.1)
    .lineTo(-1.8, 0)
    .closePath();
  const depth = width - round * 2;
  const geometry = new ExtrudeGeometry(profile, {
    depth,
    curveSegments: 24,
    bevelThickness: round,
    bevelSize: round,
    bevelSegments: 6,
  });
  // Shape x/y become car z/y; the extrusion runs across the car, centred on it.
  geometry.rotateY(-Math.PI / 2);
  geometry.translate(depth / 2, 0, 0);
  // Weld the caps to the bevel so the whole canopy shades as one smooth surface.
  geometry.deleteAttribute('uv');
  geometry.deleteAttribute('normal');
  const smooth = mergeVertices(geometry);
  smooth.computeVertexNormals();
  return smooth;
}

function at<T extends Object3D>(object: T, x: number, y: number, z: number): T {
  object.position.set(x, y, z);
  return object;
}

function shadowed<T extends Mesh>(mesh: T, x: number, y: number, z: number): T {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return at(mesh, x, y, z);
}
