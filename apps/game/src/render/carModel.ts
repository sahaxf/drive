import { Box3, BufferGeometry, Float32BufferAttribute, Group, type Material, Mesh, type Object3D, Vector3 } from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import type { CarSpec, ModelMaterial } from '@drivee/shared';
import type { WheelId } from '../vehicle/Vehicle';

/** A car's model, fitted to its spec: the body in car space, and wheels centred on their hubs. */
export interface CarModel {
  body: Group;
  wheels: Record<WheelId, Mesh>;
  /** Where each wheel's centre sits across the car in the model, to line up with its arch. */
  wheelX: Record<WheelId, number>;
}

/** Fetches and parses the car's OBJ, or resolves to null for a car without one. */
export async function loadCarModel(spec: CarSpec): Promise<Group | null> {
  if (!spec.visual.model) return null;
  const url = `/cars/${spec.id}/${spec.visual.model}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load the model for car "${spec.id}" (${url}: ${response.status})`);
  return new OBJLoader().parse(await response.text());
}

/**
 * Scales and places a parsed model so its axles line up with the spec's, with the wheels
 * touching the ground when the car is at rest at `hubY`. Each axle's wheel pair is split
 * into left and right meshes centred on their own hub, so they can steer and spin.
 */
export function fitCarModel(
  spec: CarSpec,
  source: Group,
  hubY: number,
  materials: Record<ModelMaterial, Material>,
): CarModel {
  const { wheelNodes, hiddenNodes } = spec.visual;
  if (!wheelNodes) throw new Error(`Car "${spec.id}" has a model but no visual.wheelNodes`);
  const front = findMesh(source, wheelNodes.front);
  const rear = findMesh(source, wheelNodes.rear);
  const frontCentre = new Box3().setFromObject(front).getCenter(new Vector3());
  const rearCentre = new Box3().setFromObject(rear).getCenter(new Vector3());

  const scale = (spec.wheels.frontAxleZ - spec.wheels.rearAxleZ) / (frontCentre.z - rearCentre.z);
  const wheelY = (frontCentre.y + rearCentre.y) / 2;
  const offset = new Vector3(0, hubY - wheelY * scale, spec.wheels.frontAxleZ - frontCentre.z * scale);

  for (const mesh of meshes(source)) {
    const named = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const looks = named.map((m) => materials[spec.visual.materials[m.name] ?? 'trim']);
    mesh.material = Array.isArray(mesh.material) ? looks : looks[0]!;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  }

  const wheels = {} as Record<WheelId, Mesh>;
  const wheelX = {} as Record<WheelId, number>;
  for (const [axle, mesh] of [['F', front], ['R', rear]] as const) {
    const [left, right] = splitAcrossX(mesh.geometry);
    for (const [side, geometry] of [['L', left], ['R', right]] as const) {
      // The hub sits at the wheel's centre; the spec's axle line and the hub height
      // place it, so only its position across the car comes from the model.
      geometry.scale(scale, scale, scale);
      const centre = new Box3().setFromBufferAttribute(geometry.getAttribute('position') as Float32BufferAttribute).getCenter(new Vector3());
      geometry.translate(-centre.x, -centre.y, -centre.z);
      const id = `${axle}${side}` as WheelId;
      wheels[id] = Object.assign(new Mesh(geometry, mesh.material), { castShadow: true, receiveShadow: true });
      wheelX[id] = centre.x;
    }
  }

  const body = new Group();
  for (const child of [...source.children]) {
    if (child === front || child === rear || hiddenNodes.includes(child.name)) continue;
    body.add(child);
  }
  body.scale.setScalar(scale);
  body.position.copy(offset);
  return { body, wheels, wheelX };
}

function findMesh(root: Object3D, name: string): Mesh {
  const found = root.getObjectByName(name);
  if (!(found instanceof Mesh)) throw new Error(`Car model has no mesh named "${name}"`);
  return found;
}

function meshes(root: Object3D): Mesh[] {
  const found: Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof Mesh) found.push(o);
  });
  return found;
}

/**
 * Splits a non-indexed geometry into the triangles left (+X) and right of the centre
 * line, keeping its material groups.
 */
function splitAcrossX(geometry: BufferGeometry): [BufferGeometry, BufferGeometry] {
  const names = Object.keys(geometry.attributes);
  const sides = [0, 1].map(() => ({ data: names.map(() => [] as number[]), vertices: 0, geometry: new BufferGeometry() }));
  const position = geometry.getAttribute('position');
  const groups = geometry.groups.length > 0 ? geometry.groups : [{ start: 0, count: position.count, materialIndex: 0 }];
  for (const group of groups) {
    const starts = sides.map((s) => s.vertices);
    for (let v = group.start; v < group.start + group.count; v += 3) {
      const x = position.getX(v) + position.getX(v + 1) + position.getX(v + 2);
      const side = sides[x >= 0 ? 0 : 1]!;
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
