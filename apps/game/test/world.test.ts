import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { neutralInput, parseCarSpec, parseTrackSpec, type CarSpec } from '@drivee/shared';
import { createWorld, initPhysics, PHYSICS_DT } from '../src/physics/PhysicsWorld';
import { addTrackPhysics, generateTrack, type GeneratedTrack } from '../src/track/generateTrack';
import { TREE_STRIDE } from '../src/track/forest';
import { Vehicle } from '../src/vehicle/Vehicle';

const read = (rel: string) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'));

const trackIds: string[] = read('../../../public/tracks/index.json').tracks;
let car: CarSpec;

beforeAll(async () => {
  await initPhysics();
  car = parseCarSpec(read('../../../public/cars/strada-gt/car.json'));
});

// Every registered track has to generate cleanly and be drivable.
describe.each(trackIds)('%s', (trackId) => {
  let track: GeneratedTrack;
  let generationMs = 0;

  beforeAll(async () => {
    const t0 = performance.now();
    track = await generateTrack(parseTrackSpec(read(`../../../public/tracks/${trackId}/track.json`)));
    generationMs = performance.now() - t0;
  }, 60_000);

  describe('generated world', () => {
    it('generates quickly enough to do at load time', () => {
      console.log(`generation ${generationMs.toFixed(0)} ms, ${track.forest.count} trees, terrain ${track.terrain.nx}x${track.terrain.nz}`);
      expect(generationMs).toBeLessThan(8000);
    });

    it('tucks the terrain just under the road surface', () => {
      const { spline, terrain, spec } = track;
      for (let k = 0; k < spline.count; k += 37) {
        const x = spline.positions[k * 3]!;
        const y = spline.positions[k * 3 + 1]!;
        const z = spline.positions[k * 3 + 2]!;
        const below = y - terrain.heightAt(x, z);
        expect(below).toBeGreaterThan(0.05);
        expect(below).toBeLessThan(spec.terrain.roadDrop + 0.6);
      }
    });

    it('rings the circuit with mountains', () => {
      const { field } = track;
      const basin = field.natural((field.bounds.minX + field.bounds.maxX) / 2, (field.bounds.minZ + field.bounds.maxZ) / 2);
      let peak = -Infinity;
      for (let a = 0; a < Math.PI * 2; a += 0.1) peak = Math.max(peak, field.natural(Math.cos(a) * 6000, Math.sin(a) * 6000));
      expect(peak - basin).toBeGreaterThan(300);
    });

    it('keeps trees off the road, verges and barriers', () => {
      const { forest, spline, spec } = track;
      // Mostly open land with forest patches; the ceiling guards the frame rate.
      expect(forest.count).toBeGreaterThan(5_000);
      expect(forest.count).toBeLessThan(60_000);
      const keepOut = spec.centreline.width / 2 + spec.roadside.vergeWidth + spec.forest.clearance - 1;
      for (const trees of forest.trees) {
        for (let i = 0; i < trees.length; i += TREE_STRIDE * 13) {
          const hit = spline.nearest(trees[i]!, trees[i + 2]!, keepOut);
          expect(hit, `tree at ${trees[i]}, ${trees[i + 2]}`).toBeNull();
        }
      }
    });

    it('seats distant trees on the far landscape, outside the near terrain', () => {
      const { far, terrain } = track;
      const trees = track.forest.farTrees;
      expect(trees.length / TREE_STRIDE).toBeGreaterThan(1_500);
      const maxX = terrain.originX + (terrain.nx - 1) * terrain.resolution;
      const maxZ = terrain.originZ + (terrain.nz - 1) * terrain.resolution;
      for (let i = 0; i < trees.length; i += TREE_STRIDE * 17) {
        const [x, y, z] = [trees[i]!, trees[i + 1]!, trees[i + 2]!];
        expect(x > terrain.originX && x < maxX && z > terrain.originZ && z < maxZ).toBe(false);
        expect(Math.abs(far.surfaceHeight(x, z)! - y - 0.8)).toBeLessThan(1e-3);
      }
    });
  });

  describe('autopilot lap', () => {
    it('drives a full lap on the real colliders without falling through, flipping or leaving the road', () => {
      const { spline, spec, terrain } = track;
      const world = createWorld();
      const vehicle = new Vehicle(world, car, new Vector3());
      vehicle.surfaceGrip = addTrackPhysics(world, track);

      const start = spline.frameAt(spec.race.startDistance);
      vehicle.reset(start.position.clone().addScaledVector(start.up, 0.7), Math.atan2(start.tangent.x, start.tangent.z));

      const pos = new Vector3();
      const rot = new Quaternion();
      const forward = new Vector3();
      const right = new Vector3();
      const toTarget = new Vector3();
      let lastDistance = spec.race.startDistance;
      let progress = 0;
      let time = 0;
      let worstOffset = 0;
      let worstUp = 1;
      let lowestAboveGround = Infinity;

      while (progress < spline.length && time < spline.length / 10) {
        const t = vehicle.body.translation();
        const r = vehicle.body.rotation();
        pos.set(t.x, t.y, t.z);
        rot.set(r.x, r.y, r.z, r.w);
        const near = spline.nearest(pos.x, pos.z)!;
        let delta = near.distance - lastDistance;
        if (delta < -spline.length / 2) delta += spline.length;
        if (delta > spline.length / 2) delta -= spline.length;
        progress += delta;
        lastDistance = near.distance;

        worstOffset = Math.max(worstOffset, near.offset);
        worstUp = Math.min(worstUp, new Vector3(0, 1, 0).applyQuaternion(rot).y);
        lowestAboveGround = Math.min(lowestAboveGround, pos.y - terrain.heightAt(pos.x, pos.z));

        // Pure pursuit on the centreline, speed limited by the curvature ahead.
        const speed = vehicle.telemetry.speed;
        const target = spline.frameAt(near.distance + 8 + speed * 0.8).position;
        forward.set(0, 0, 1).applyQuaternion(rot);
        right.set(-1, 0, 0).applyQuaternion(rot);
        toTarget.subVectors(target, pos);
        const steer = Math.max(-1, Math.min(1, Math.atan2(toTarget.dot(right), toTarget.dot(forward)) * 2.5));

        let maxCurvature = 1e-4;
        const horizon = 25 + (speed * speed) / 10;
        for (let d = 0; d < horizon; d += 4) {
          const i = spline.wrap(Math.round((near.distance + d) / spline.step));
          maxCurvature = Math.max(maxCurvature, Math.abs(spline.curvature[i]!));
        }
        const vmax = Math.min(Math.sqrt((0.85 * 9.81) / maxCurvature), 75);
        const input = { ...neutralInput(), steer };
        if (speed < vmax * 0.95) input.throttle = 1;
        else if (speed > vmax * 1.05) input.brake = Math.min(1, (speed - vmax) / 6);
        else input.throttle = 0.3;

        for (let s = 0; s < 4; s++) {
          vehicle.step(input, PHYSICS_DT);
          world.step();
          time += PHYSICS_DT;
        }
      }

      console.log(
        `${trackId}: lap ${time.toFixed(1)} s, worst offset ${worstOffset.toFixed(1)} m, min up ${worstUp.toFixed(3)}, min clearance ${lowestAboveGround.toFixed(2)} m`,
      );
      expect(progress).toBeGreaterThanOrEqual(spline.length);
      // Average 54-144 km/h: neither impossibly fast nor crawling.
      expect(time).toBeGreaterThan(spline.length / 40);
      expect(time).toBeLessThan(spline.length / 15);
      expect(worstUp).toBeGreaterThan(0.85);
      expect(lowestAboveGround).toBeGreaterThan(0.2);
      expect(worstOffset).toBeLessThan(spec.centreline.width / 2 + spec.roadside.vergeWidth);
    }, 400_000); // The Nordschleife lap is three times Spa's.
  });
});
