import {
  BoxGeometry,
  BufferGeometry,
  CubicBezierCurve,
  CylinderGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  LatheGeometry,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  type Object3D,
  type Quaternion,
  MathUtils,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  type Vector3,
} from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { CarSpec } from '@drivee/shared';
import type { WheelId, WheelState } from '../vehicle/Vehicle';
import { type CarModel, fitCarModel } from './carModel';

const WHEEL_IDS = ['FL', 'FR', 'RL', 'RR'] as const;

interface WheelNodes {
  /** Positioned at the hub; moves with suspension. */
  hub: Group;
  /** Rotates about Y for steering. */
  steer: Group;
  /** Rotates about X for rolling. */
  spin: Group;
}

/**
 * The car's visuals: its model from car.json when it has one, otherwise a procedural
 * placeholder. Nodes use the logical names (`body`, `wheel_FL`, ...) either way.
 */
export class CarView {
  readonly root = new Group();
  private readonly wheels = new Map<WheelId, WheelNodes>();
  private readonly brakeLight: MeshStandardMaterial;
  private readonly reverseLight: MeshStandardMaterial;

  /** `model` is the car's parsed model file, if it has one (see loadCarModel). */
  constructor(
    private readonly spec: CarSpec,
    model: Group | null = null,
  ) {
    const paint = new MeshPhysicalMaterial({
      color: spec.visual.paintColor,
      metalness: 0.15,
      roughness: 0.38,
      clearcoat: 0.8,
      clearcoatRoughness: 0.08,
      envMapIntensity: 0.6,
    });
    // The body shell darkens its wheel wells through vertex colours.
    const shell = paint.clone();
    shell.vertexColors = true;
    const glass = new MeshPhysicalMaterial({ color: '#0d1116', metalness: 0.1, roughness: 0.04, clearcoat: 1 });
    const trim = new MeshStandardMaterial({ color: '#141414', roughness: 0.55 });
    this.brakeLight = new MeshStandardMaterial({ color: '#4a0000', emissive: '#ff1a10', emissiveIntensity: 0.3 });
    this.reverseLight = new MeshStandardMaterial({ color: '#cccccc', emissive: '#ffffff', emissiveIntensity: 0 });
    const headLight = new MeshStandardMaterial({ color: '#fff', emissive: '#fff6dd', emissiveIntensity: 1.5 });
    const exhaust = new MeshStandardMaterial({ color: '#8a8d92', metalness: 1, roughness: 0.3 });

    const body = new Group();
    body.name = 'body';
    this.root.add(body);
    if (model) {
      const chrome = new MeshStandardMaterial({ color: '#c9ccd1', metalness: 1, roughness: 0.25 });
      const rubber = new MeshStandardMaterial({ color: '#161616', roughness: 0.9 });
      const hubY = (restHubY(spec, true) + restHubY(spec, false)) / 2;
      const fitted = fitCarModel(spec, model, hubY, {
        paint,
        glass,
        trim,
        chrome,
        rubber,
        headlight: headLight,
        brakeLight: this.brakeLight,
        reverseLight: this.reverseLight,
      });
      body.add(fitted.body);
      for (const id of WHEEL_IDS) this.wheels.set(id, this.mountModelWheel(id, fitted));
      return;
    }

    const [hx, , hz] = spec.chassis.halfExtents;
    const { frontAxleZ, rearAxleZ } = spec.wheels;
    body.add(
      shadowed(new Mesh(bodyGeometry(spec), shell), 0, 0, 0),
      shadowed(new Mesh(cabinGeometry(hx * 1.6), glass), 0, 0, 0),
      shadowed(new Mesh(engineLidGeometry(hx * 1.6 + 0.02), paint), 0, 0, 0),
      // Rear wing and its two posts.
      shadowed(new Mesh(new RoundedBoxGeometry(hx * 1.85, 0.05, 0.36, 2, 0.022), trim), 0, 0.48, -hz + 0.2),
      shadowed(new Mesh(new RoundedBoxGeometry(0.06, 0.28, 0.16, 2, 0.025), trim), 0.5, 0.32, -hz + 0.22),
      shadowed(new Mesh(new RoundedBoxGeometry(0.06, 0.28, 0.16, 2, 0.025), trim), -0.5, 0.32, -hz + 0.22),
      // Front splitter tucked under the nose, and a diffuser filling the upswept tail.
      shadowed(new Mesh(new RoundedBoxGeometry(hx * 1.3, 0.035, 0.24, 2, 0.015), trim), 0, -0.3, hz - 0.32),
      shadowed(new Mesh(new RoundedBoxGeometry(hx * 1.3, 0.06, 0.3, 2, 0.025), trim), 0, -0.29, -hz + 0.26),
      // Lights are flattened lenses sunk into the shell; only the part breaking its
      // surface shows, so they follow the curves of the nose and tail.
      at(lens(hx * 0.8, 0.03, 0.1, this.brakeLight), 0, 0.07, -hz + 0.1),
    );
    for (const side of [1, -1]) {
      const pipe = new Mesh(new CylinderGeometry(0.045, 0.045, 0.2, 16, 1, true), exhaust);
      pipe.rotation.x = Math.PI / 2;
      body.add(
        at(lens(0.11, 0.04, 0.2, headLight), side * 0.52, 0.05, hz - 0.26),
        at(lens(0.07, 0.018, 0.06, this.reverseLight), side * 0.3, 0, -hz + 0.06),
        at(pipe, side * 0.13, -0.2, -hz + 0.04),
        // Side skirt between the wheel arches.
        shadowed(
          new Mesh(new RoundedBoxGeometry(0.06, 0.06, frontAxleZ - rearAxleZ - 0.95, 2, 0.025), trim),
          side * (hx - 0.01),
          -0.29,
          (frontAxleZ + rearAxleZ) / 2,
        ),
      );
    }
    for (const id of WHEEL_IDS) this.wheels.set(id, this.buildWheel(id));
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

  /** Empty hub, steer and spin nodes for a wheel, added to the car. */
  private wheelNodes(id: WheelId): WheelNodes {
    const hub = new Group();
    hub.name = `wheel_${id}`;
    const steer = new Group();
    const spin = new Group();
    hub.add(steer);
    steer.add(spin);
    this.root.add(hub);
    return { hub, steer, spin };
  }

  /** A wheel from the car's model, kept where the model has it across the car. */
  private mountModelWheel(id: WheelId, model: CarModel): WheelNodes {
    const nodes = this.wheelNodes(id);
    const front = id.startsWith('F');
    const track = front ? this.spec.wheels.trackFront : this.spec.wheels.trackRear;
    // The hub sits at the spec's track; shift the spinning wheel to the model's arch.
    nodes.spin.position.x = model.wheelX[id] - (id.endsWith('L') ? 1 : -1) * (track / 2);
    nodes.spin.add(model.wheels[id]);
    return nodes;
  }

  private buildWheel(id: WheelId): WheelNodes {
    const { radius, width } = this.spec.wheels;
    const left = id.endsWith('L');
    const { hub, steer, spin } = this.wheelNodes(id);

    const rubber = new MeshStandardMaterial({ color: '#161616', roughness: 0.9 });
    const rim = new MeshStandardMaterial({ color: '#c9ccd1', metalness: 1, roughness: 0.25 });
    const barrel = new MeshStandardMaterial({ color: '#2a2c30', metalness: 0.6, roughness: 0.5 });
    const disc = new MeshStandardMaterial({ color: '#6d7075', metalness: 0.9, roughness: 0.45 });
    const caliper = new MeshStandardMaterial({ color: '#b5281e', roughness: 0.4 });
    const outward = left ? 1 : -1;
    const rimRadius = radius * 0.68;

    // Tyre, barrel and disc are built around the Y axis, then laid on their side to roll about X.
    const axle = new Group();
    axle.rotation.z = Math.PI / 2;
    spin.add(axle);
    axle.add(
      shadowed(new Mesh(tyreGeometry(radius, rimRadius, width), rubber), 0, 0, 0),
      // Dark rim barrel and a brake disc, seen through the spokes.
      new Mesh(new CylinderGeometry(rimRadius, rimRadius, width * 0.9, 32, 1, true), barrel),
      at(new Mesh(new CylinderGeometry(rimRadius * 0.75, rimRadius * 0.75, 0.02, 32), disc), 0, -outward * 0.02, 0),
    );
    // Rim lip, five spokes and a centre cap, recessed just inside the tyre's sidewall.
    const faceX = outward * (width / 2 - 0.02);
    const lip = new Mesh(new TorusGeometry(rimRadius - 0.008, 0.012, 8, 40), rim);
    lip.rotation.y = Math.PI / 2;
    spin.add(at(lip, faceX, 0, 0));
    for (let k = 0; k < 5; k++) {
      const spoke = new Mesh(new BoxGeometry(0.025, rimRadius, 0.06).translate(0, rimRadius / 2, 0), rim);
      spoke.rotation.x = (k / 5) * Math.PI * 2;
      spin.add(at(spoke, faceX, 0, 0));
    }
    const cap = new Mesh(new CylinderGeometry(0.05, 0.05, 0.03, 20), rim);
    cap.rotation.z = Math.PI / 2;
    spin.add(at(cap, faceX, 0, 0));
    // The caliper steers with the wheel but does not spin.
    steer.add(at(new Mesh(new RoundedBoxGeometry(0.05, 0.1, 0.16, 2, 0.02), caliper), outward * 0.01, rimRadius * 0.55, -rimRadius * 0.35));

    return { hub, steer, spin };
  }
}

/** Where a wheel hub sits with the car at rest, sagged under its share of the weight. */
function restHubY(spec: CarSpec, front: boolean): number {
  const { frontAxleZ, rearAxleZ, mountY } = spec.wheels;
  const frontShare = (spec.chassis.centerOfMass[2] - rearAxleZ) / (frontAxleZ - rearAxleZ);
  const suspension = front ? spec.suspension.front : spec.suspension.rear;
  const sag = (spec.chassis.mass * 9.81 * (front ? frontShare : 1 - frontShare)) / 2 / suspension.stiffness;
  return mountY - (suspension.restLength - sag);
}

/** 1 for t <= 0, easing round to 0 at t = 1: the plan shape of a rounded end. */
function endRound(t: number): number {
  return t <= 0 ? 1 : t >= 1 ? 0 : Math.sqrt(1 - t * t);
}

/**
 * Body shell swept along the car as a rounded-rectangle section. Along the way the nose
 * and tail round off, the bonnet drops, the front fenders and wide rear hips rise above
 * the beltline, and wheel arches are pushed in around each tyre, darkened as wells.
 */
function bodyGeometry(spec: CarSpec): BufferGeometry {
  const [hx, , hz] = spec.chassis.halfExtents;
  const { radius, width, frontAxleZ, rearAxleZ, trackFront, trackRear } = spec.wheels;
  const arches = [
    { z: frontAxleZ, y: restHubY(spec, true), inner: trackFront / 2 - width / 2 - 0.04 },
    { z: rearAxleZ, y: restHubY(spec, false), inner: trackRear / 2 - width / 2 - 0.04 },
  ];
  const archRadius = radius + 0.05;
  const bottom = -0.31;
  const slices = 240;
  const around = 192;
  const positions: number[] = [];
  const colors: number[] = [];
  for (let i = 0; i <= slices; i++) {
    const z = -hz + (2 * hz * i) / slices;
    const end = Math.min(endRound((z - hz + 0.5) / 0.5), endRound((-hz + 0.35 - z) / 0.35));
    const top = 0.19 - 0.06 * MathUtils.smoothstep(z, 1.0, hz);
    const halfWidth = hx * (1 - 0.05 * MathUtils.smoothstep(z, 0.8, hz)) * end;
    // The ends shrink towards a point low on the section, so the nose stays planted.
    const anchor = bottom + (top - bottom) * 0.4;
    const yScale = 0.35 + 0.65 * end;
    const hip = Math.exp(-(((z - rearAxleZ + 0.1) / 0.75) ** 2));
    const fender = Math.exp(-(((z - frontAxleZ) / 0.55) ** 2));
    for (let j = 0; j < around; j++) {
      const angle = (j / around) * Math.PI * 2;
      // Superellipse (n = 4): a rectangle with generously rounded corners.
      const sx = Math.sign(Math.cos(angle)) * Math.sqrt(Math.abs(Math.cos(angle)));
      const sy = Math.sign(Math.sin(angle)) * Math.sqrt(Math.abs(Math.sin(angle)));
      const up = (sy + 1) / 2;
      const side = Math.abs(sx);
      let x = halfWidth * sx * (1 - 0.06 * Math.max(0, sy)) * (1 + 0.08 * hip * up + 0.03 * fender * up);
      let y = bottom + (top - bottom) * up + (0.07 * hip + 0.06 * fender) * up * side ** 4;
      y = anchor + (y - anchor) * yScale;
      let well = 0;
      for (const arch of arches) {
        const push = 1 - MathUtils.smoothstep(Math.hypot(z - arch.z, y - arch.y), archRadius - 0.03, archRadius + 0.02);
        if (push > 0 && Math.abs(x) > arch.inner) {
          x = Math.sign(x) * (Math.abs(x) + (arch.inner - Math.abs(x)) * push);
          well = Math.max(well, push);
        }
      }
      positions.push(x, y, z);
      const shade = 1 - 0.92 * MathUtils.smoothstep(well, 0.65, 0.95);
      colors.push(shade, shade, shade);
    }
  }
  const index: number[] = [];
  for (let i = 0; i < slices; i++) {
    for (let j = 0; j < around; j++) {
      const a = i * around + j;
      const b = i * around + ((j + 1) % around);
      index.push(a, b, a + around, b, b + around, a + around);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  // Each end pinches to a vertical line, which averages into a muddy normal; face it straight out.
  const normals = geometry.getAttribute('normal');
  for (let j = 0; j < around; j++) {
    normals.setXYZ(j, 0, 0, -1);
    normals.setXYZ(slices * around + j, 0, 0, 1);
  }
  return geometry;
}

/** A light lens: a flattened sphere, meant to be partly buried in the body shell. */
function lens(rx: number, ry: number, rz: number, material: MeshStandardMaterial): Mesh {
  const mesh = new Mesh(new SphereGeometry(1, 32, 12), material);
  mesh.scale.set(rx, ry, rz);
  return mesh;
}

/** Tyre with rounded shoulders, as a lathe around the Y axis. */
function tyreGeometry(radius: number, rimRadius: number, width: number): LatheGeometry {
  const shoulder = 0.05;
  const half = width / 2;
  const points = [new Vector2(rimRadius, -half)];
  for (let k = 0; k <= 6; k++) {
    const a = (k / 6) * (Math.PI / 2);
    points.push(new Vector2(radius - shoulder + Math.sin(a) * shoulder, -half + shoulder - Math.cos(a) * shoulder));
  }
  for (let k = 0; k <= 6; k++) {
    const a = (k / 6) * (Math.PI / 2);
    points.push(new Vector2(radius - shoulder + Math.cos(a) * shoulder, half - shoulder + Math.sin(a) * shoulder));
  }
  points.push(new Vector2(rimRadius, half));
  return new LatheGeometry(points, 40);
}

/**
 * Fastback slope from the end of the roof down to the rear deck, shared by the glass and
 * the lid. It lands where the body's tail starts to round off, so neither overhangs it.
 */
const FASTBACK = new CubicBezierCurve(new Vector2(-0.55, 0.5), new Vector2(-0.95, 0.49), new Vector2(-1.35, 0.2), new Vector2(-1.75, 0.08));
/** Bevel radius of the canopy and lid; also how far it grows their outlines. */
const ROUND = 0.1;

/**
 * Greenhouse as a side profile extruded across the car, so the windscreen and rear
 * window sweep down into the bonnet and rear deck instead of standing up as a box.
 * The bevel rounds the sides and grows the outline by `ROUND`, so the profile is drawn
 * that much inside the visible shape; its foot dips below the body's top to hide the seam.
 */
function cabinGeometry(width: number): BufferGeometry {
  const { v1: c1, v2: c2, v3: end } = FASTBACK;
  const profile = new Shape()
    .moveTo(1.35, 0)
    .lineTo(1.35, 0.07)
    .bezierCurveTo(0.85, 0.1, 0.52, 0.48, 0.25, 0.5)
    .quadraticCurveTo(-0.25, 0.53, FASTBACK.v0.x, FASTBACK.v0.y)
    .bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y)
    .lineTo(end.x, 0)
    .closePath();
  return extrudeAcross(profile, width);
}

/**
 * Painted engine lid over the lower half of the fastback, sitting just proud of the
 * glass so the rear window shows only above it.
 */
function engineLidGeometry(width: number): BufferGeometry {
  const points = FASTBACK.getPoints(24).slice(11);
  const profile = new Shape(points.map((p) => new Vector2(p.x, p.y + 0.012)));
  profile.lineTo(FASTBACK.v3.x, 0);
  profile.lineTo(points[0]!.x, 0);
  profile.closePath();
  return extrudeAcross(profile, width);
}

/** Extrudes a side profile across the car with rounded sides, welded to shade smoothly. */
function extrudeAcross(profile: Shape, width: number): BufferGeometry {
  const depth = width - ROUND * 2;
  const geometry = new ExtrudeGeometry(profile, {
    depth,
    curveSegments: 24,
    bevelThickness: ROUND,
    bevelSize: ROUND,
    bevelSegments: 6,
  });
  // Shape x/y become car z/y; the extrusion runs across the car, centred on it.
  geometry.rotateY(-Math.PI / 2);
  geometry.translate(depth / 2, 0, 0);
  // Weld the caps to the bevel so the whole piece shades as one smooth surface.
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
