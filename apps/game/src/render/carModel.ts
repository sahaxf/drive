import { Box3, BufferGeometry, Float32BufferAttribute, Group, type Material, Mesh, type Object3D, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import type { CarSpec, ModelMaterial } from '@drivee/shared';
import type { WheelId } from '../vehicle/Vehicle';

/** A car's model, fitted to its spec: the body in car space, and wheels centred on their hubs. */
export interface CarModel {
  body: Group;
  wheels: Record<WheelId, Group>;
  /** Where each wheel's centre sits across the car in the model, to line up with its arch. */
  wheelX: Record<WheelId, number>;
}

/** Fetches and parses the car's OBJ or glTF model, or resolves to null for a car without one. */
export async function loadCarModel(spec: CarSpec): Promise<Group | null> {
  if (!spec.visual.model) return null;
  const folder = `/cars/${spec.id}/`;
  const url = folder + spec.visual.model;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load the model for car "${spec.id}" (${url}: ${response.status})`);
  if (/\.(glb|gltf)$/i.test(spec.visual.model)) {
    return (await new GLTFLoader().parseAsync(await response.arrayBuffer(), folder)).scene;
  }
  return new OBJLoader().parse(await response.text());
}

type WheelCut = NonNullable<CarSpec['visual']['wheelCuts']>['front'];

/** The triangles of one axle's wheels, both sides together, and the axle's centre. */
interface Axle {
  pieces: Mesh[];
  centre: Vector3;
}

/**
 * Scales and places a parsed model so its axles line up with the spec's, with the wheels
 * touching the ground when the car is at rest at `hubY`. Each axle's wheels, whether a
 * mesh of their own or cut out of the body, are split into left and right groups centred
 * on their own hub, so they can steer and spin.
 */
export function fitCarModel(
  spec: CarSpec,
  source: Group,
  hubY: number,
  materials: Record<ModelMaterial, Material>,
): CarModel {
  const { wheelNodes, wheelCuts, hiddenNodes } = spec.visual;
  let parts = bake(source, (spec.visual.modelYawDeg * Math.PI) / 180).filter((m) => !hiddenNodes.includes(m.name));
  for (const mesh of parts) {
    const own = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const looks = own.map((m) => {
      const look = spec.visual.materials[m.name] ?? spec.visual.defaultMaterial;
      return look === 'model' ? m : materials[look];
    });
    mesh.material = Array.isArray(mesh.material) ? looks : looks[0]!;
  }

  let front: Axle;
  let rear: Axle;
  if (wheelNodes) {
    const take = (name: string): Axle => {
      const mesh = parts.find((m) => m.name === name);
      if (!mesh) throw new Error(`Car model has no mesh named "${name}"`);
      parts = parts.filter((m) => m !== mesh);
      return { pieces: [mesh], centre: new Box3().setFromObject(mesh).getCenter(new Vector3()) };
    };
    front = take(wheelNodes.front);
    rear = take(wheelNodes.rear);
  } else if (wheelCuts) {
    const cut = (c: WheelCut): Axle => {
      const pieces: Mesh[] = [];
      parts = parts.map((mesh) => {
        const [wheel, rest] = partition(mesh.geometry, (x, y, z) => Math.abs(x) >= c.innerX && Math.hypot(z - c.z, y - c.y) <= c.radius);
        if (wheel.getAttribute('position').count > 0) pieces.push(new Mesh(wheel, mesh.material));
        return Object.assign(new Mesh(rest, mesh.material), { name: mesh.name });
      });
      return { pieces, centre: new Vector3(0, c.y, c.z) };
    };
    front = cut(wheelCuts.front);
    rear = cut(wheelCuts.rear);
  } else {
    throw new Error(`Car "${spec.id}" has a model but neither visual.wheelNodes nor visual.wheelCuts`);
  }

  const scale = (spec.wheels.frontAxleZ - spec.wheels.rearAxleZ) / (front.centre.z - rear.centre.z);
  const wheelY = (front.centre.y + rear.centre.y) / 2;
  const offset = new Vector3(0, hubY - wheelY * scale, spec.wheels.frontAxleZ - front.centre.z * scale);

  const wheels = {} as Record<WheelId, Group>;
  const wheelX = {} as Record<WheelId, number>;
  for (const [letter, axle] of [['F', front], ['R', rear]] as const) {
    for (const [side, left] of [['L', true], ['R', false]] as const) {
      const id = `${letter}${side}` as WheelId;
      const meshes = axle.pieces
        .map((piece) => new Mesh(partition(piece.geometry, (x) => (x >= 0) === left)[0], piece.material))
        .filter((mesh) => mesh.geometry.getAttribute('position').count > 0);
      const bounds = new Box3();
      for (const mesh of meshes) bounds.expandByObject(mesh);
      // Centre the wheel on its hub: across the car where the model has it, and on the
      // axle's line and height so both wheels of an axle turn about the same point.
      const centre = new Vector3(bounds.getCenter(new Vector3()).x, axle.centre.y, axle.centre.z);
      const wheel = new Group();
      for (const mesh of meshes) {
        mesh.geometry.translate(-centre.x, -centre.y, -centre.z).scale(scale, scale, scale);
        wheel.add(shadowed(mesh));
      }
      wheels[id] = wheel;
      wheelX[id] = centre.x * scale;
    }
  }

  const body = new Group();
  for (const mesh of parts) body.add(shadowed(mesh));
  body.scale.setScalar(scale);
  body.position.copy(offset);
  return { body, wheels, wheelX };
}

/**
 * Flattens a parsed model into meshes whose geometry is in model space, turned by `yaw`
 * about +Y, and non-indexed so it can be cut up by triangle.
 */
function bake(source: Group, yaw: number): Mesh[] {
  source.rotation.y = yaw;
  source.updateMatrixWorld(true);
  const found: Mesh[] = [];
  source.traverse((o: Object3D) => {
    if (!(o instanceof Mesh)) return;
    const geometry = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone()).applyMatrix4(o.matrixWorld);
    found.push(Object.assign(new Mesh(geometry, o.material), { name: o.name }));
  });
  return found;
}

function shadowed(mesh: Mesh): Mesh {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Splits a non-indexed geometry into the triangles whose centroid passes `test` and the
 * rest, keeping its material groups.
 */
function partition(geometry: BufferGeometry, test: (x: number, y: number, z: number) => boolean): [BufferGeometry, BufferGeometry] {
  const names = Object.keys(geometry.attributes);
  const sides = [0, 1].map(() => ({ data: names.map(() => [] as number[]), vertices: 0, geometry: new BufferGeometry() }));
  const position = geometry.getAttribute('position');
  const groups = geometry.groups.length > 0 ? geometry.groups : [{ start: 0, count: position.count, materialIndex: 0 }];
  for (const group of groups) {
    const starts = sides.map((s) => s.vertices);
    for (let v = group.start; v < group.start + group.count; v += 3) {
      const x = (position.getX(v) + position.getX(v + 1) + position.getX(v + 2)) / 3;
      const y = (position.getY(v) + position.getY(v + 1) + position.getY(v + 2)) / 3;
      const z = (position.getZ(v) + position.getZ(v + 1) + position.getZ(v + 2)) / 3;
      const side = sides[test(x, y, z) ? 0 : 1]!;
      names.forEach((name, n) => {
        const attribute = geometry.getAttribute(name);
        for (let k = v; k < v + 3; k++) {
          for (let c = 0; c < attribute.itemSize; c++) side.data[n]!.push(attribute.getComponent(k, c));
        }
      });
      side.vertices += 3;
    }
    sides.forEach((s, i) => {
      const count = s.vertices - starts[i]!;
      if (count > 0) s.geometry.addGroup(starts[i]!, count, group.materialIndex ?? 0);
    });
  }
  for (const side of sides) {
    names.forEach((name, n) => side.geometry.setAttribute(name, new Float32BufferAttribute(side.data[n]!, geometry.getAttribute(name).itemSize)));
  }
  return [sides[0]!.geometry, sides[1]!.geometry];
}
