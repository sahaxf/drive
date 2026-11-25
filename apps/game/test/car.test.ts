import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Box3, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { Button, decodeInput, encodeInput, neutralInput, parseCarSpec, type CarSpec } from '@drivee/shared';
import { impactLevel, kerbTone, squealTone, tyreSlide, windTone, type SlideWheel } from '../src/audio/DrivingSounds';
import { cameraMounts, CameraRig } from '../src/camera/CameraRig';
import { carStats } from '../src/carStats';
import { buildCabin, steeringWheelAngle } from '../src/render/cabin';
import { createDrivetrainState, updateDrivetrain } from '../src/vehicle/drivetrain';

const DT = 1 / 120;
const RPM_PER_RAD_PER_SEC = 60 / (2 * Math.PI);

const load = (id: string) =>
  parseCarSpec(JSON.parse(readFileSync(fileURLToPath(new URL(`../../../public/cars/${id}/car.json`, import.meta.url)), 'utf8')));
let gt: CarSpec;
let formula: CarSpec;
beforeAll(() => {
  gt = load('strada-gt');
  formula = load('formula');
});

describe('manual gears', () => {
  /** Driven-wheel speed that puts the engine at `rpm` in `gear`. */
  const omegaAt = (spec: CarSpec, gear: number, rpm: number) =>
    rpm / RPM_PER_RAD_PER_SEC / (spec.gearbox.ratios[gear - 1]! * spec.gearbox.finalDrive);
  const step = (spec: CarSpec, state: ReturnType<typeof createDrivetrainState>, omega: number, shift = 0, manual = true) =>
    updateDrivetrain(spec, state, { throttle: 1, brake: 0, forwardSpeed: omega * spec.wheels.radius, drivenWheelOmega: omega, manual, shift }, DT);

  it('holds a gear to the redline instead of changing up by itself', () => {
    const state = createDrivetrainState(gt);
    const omega = omegaAt(gt, 1, gt.engine.redlineRpm * 0.99);
    for (let i = 0; i < 60; i++) step(gt, state, omega);
    expect(state.gear).toBe(1);
    // The automatic gearbox would have changed up long before.
    const auto = createDrivetrainState(gt);
    for (let i = 0; i < 60; i++) step(gt, auto, omega, 0, false);
    expect(auto.gear).toBeGreaterThan(1);
  });

  it('changes up and down on request, cutting drive while it does', () => {
    const state = createDrivetrainState(gt);
    const omega = omegaAt(gt, 2, 4000);
    const out = step(gt, state, omega, 1);
    expect(state.gear).toBe(2);
    expect(out.wheelTorque).toBe(0);
    // A request during the change is ignored.
    step(gt, state, omega, 1);
    expect(state.gear).toBe(2);
    for (let t = 0; t < gt.gearbox.shiftTime + 0.05; t += DT) step(gt, state, omega);
    expect(step(gt, state, omega).wheelTorque).toBeGreaterThan(0);
    step(gt, state, omega, -1);
    expect(state.gear).toBe(1);
  });

  it('stops at the top gear and refuses a downshift that would over-rev', () => {
    const top = gt.gearbox.ratios.length;
    const state = { ...createDrivetrainState(gt), gear: top };
    step(gt, state, omegaAt(gt, top, 5000), 1);
    expect(state.gear).toBe(top);

    const fast = { ...createDrivetrainState(gt), gear: 3 };
    // Near the redline in third: second would be far past it.
    step(gt, fast, omegaAt(gt, 3, gt.engine.redlineRpm * 0.95), -1);
    expect(fast.gear).toBe(3);
  });

  it('carries the shift buttons in the phone packet', () => {
    const packet = encodeInput({ ...neutralInput(), buttons: Button.ShiftUp | Button.ShiftDown | Button.Pause }, 7);
    const decoded = decodeInput(packet)!.input;
    expect(decoded.buttons).toBe(Button.ShiftUp | Button.ShiftDown | Button.Pause);
    expect(decoded.handbrake).toBe(false);
  });
});

describe('car stats', () => {
  it('works out power, weight, layout and top speed from the physics data', () => {
    const stats = carStats(gt);
    expect(stats.mass).toBe(gt.chassis.mass);
    expect(stats.layout).toBe(gt.drivetrain.layout);
    // Peak power is at least torque × speed at every point of the curve.
    for (const [rpm, torque] of gt.engine.torqueCurve) {
      expect(stats.powerHp).toBeGreaterThanOrEqual(Math.floor((torque * rpm) / RPM_PER_RAD_PER_SEC / 735.5));
    }
    expect(stats.powerHp).toBeGreaterThan(100);
    expect(stats.topSpeedKmh).toBeGreaterThan(150);
    expect(stats.topSpeedKmh).toBeLessThan(500);
  });

  it('caps top speed at what the gearing allows', () => {
    const short = structuredClone(gt);
    short.aero.dragArea = 0;
    const geared =
      (short.engine.redlineRpm / RPM_PER_RAD_PER_SEC / (short.gearbox.ratios.at(-1)! * short.gearbox.finalDrive)) * short.wheels.radius * 3.6;
    expect(carStats(short).topSpeedKmh).toBe(Math.round(geared));
    expect(carStats(gt).topSpeedKmh).toBeLessThanOrEqual(Math.round(geared));
  });
});

describe('onboard cameras', () => {
  it('places a camera from the chassis size unless the car gives its own', () => {
    const bare = structuredClone(gt);
    bare.cameras = {};
    const [, hy, hz] = bare.chassis.halfExtents;
    const mounts = cameraMounts(bare);
    // Bumper: at the nose, low. Windshield: in the cabin, behind the hood camera.
    expect(mounts.bumper[2]).toBeGreaterThan(hz);
    expect(mounts.bumper[1]).toBeLessThan(hy);
    expect(mounts.windshield[2]).toBeLessThan(mounts.hood[2]);

    bare.cameras = { bumper: [0, 0.2, 3] };
    expect(cameraMounts(bare).bumper).toEqual([0, 0.2, 3]);
    expect(cameraMounts(bare).hood).toEqual(mounts.hood);
  });

  it('gives each car mounts inside its own length', () => {
    for (const spec of [gt, formula]) {
      const hz = spec.chassis.halfExtents[2];
      const mounts = cameraMounts(spec);
      expect(Math.abs(mounts.hood[2])).toBeLessThan(hz);
      expect(Math.abs(mounts.windshield[2])).toBeLessThan(hz);
    }
  });

  it('cycles chase → hood → windshield → bumper and rides with the car', () => {
    const camera = new PerspectiveCamera();
    const mounts = cameraMounts(gt);
    const rig = new CameraRig(camera, gt.chassis.halfExtents[2], mounts);
    const seen: string[] = [rig.mode];
    for (let i = 0; i < 4; i++) {
      rig.cycle();
      seen.push(rig.mode);
    }
    expect(seen).toEqual(['chase', 'hood', 'windshield', 'bumper', 'chase']);

    // Car at (10, 2, 30), turned a quarter left: its +Z now points along world +X.
    while (rig.mode !== 'bumper') rig.cycle();
    const position = new Vector3(10, 2, 30);
    const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    rig.update(1 / 60, position, rotation, 20);
    const [x, y, z] = mounts.bumper;
    expect(camera.position.x).toBeCloseTo(10 + z, 5);
    expect(camera.position.y).toBeCloseTo(2 + y, 5);
    expect(camera.position.z).toBeCloseTo(30 - x, 5);
    // Looking where the car points.
    const forward = new Vector3();
    camera.getWorldDirection(forward);
    expect(forward.x).toBeGreaterThan(0.99);
  });
});

describe('cabin', () => {
  it('builds a dashboard across the cabin with the steering wheel in front of the driver', () => {
    const spec = gt.cameras.cabin!;
    const driverX = cameraMounts(gt).windshield[0];
    const { root, steeringWheel } = buildCabin(spec, driverX);
    const box = new Box3().setFromObject(root);
    // Nothing stands above the binnacle, so the windscreen stays clear.
    expect(box.max.y).toBeLessThan(spec.dashTop + 0.15);
    expect(box.max.x - box.min.x).toBeCloseTo(spec.width, 1);
    const wheel = steeringWheel.getWorldPosition(new Vector3());
    expect(wheel.x).toBeCloseTo(driverX);
    // Between the driver's eye and the dashboard, below the eye line.
    expect(wheel.z).toBeGreaterThan(cameraMounts(gt).windshield[2]);
    expect(wheel.z).toBeLessThan(spec.dashRear);
    expect(wheel.y).toBeLessThan(cameraMounts(gt).windshield[1]);
  });

  it('turns the steering wheel with the front wheels, up to its lock', () => {
    expect(steeringWheelAngle(0)).toBe(0);
    expect(steeringWheelAngle(0.1)).toBeGreaterThan(0.5);
    expect(steeringWheelAngle(-0.1)).toBe(-steeringWheelAngle(0.1));
    expect(steeringWheelAngle(2)).toBe(steeringWheelAngle(1));
  });

  it('is only for cars that say they have one', () => {
    expect(formula.cameras.cabin).toBeUndefined();
  });
});

describe('driving sounds', () => {
  const wheel = (over: Partial<SlideWheel> = {}): SlideWheel => ({
    grounded: true,
    locked: false,
    spinning: false,
    slipAngle: 0,
    surfaceGrip: 1,
    load: 3000,
    ...over,
  });
  const four = (over: Partial<SlideWheel> = {}) => [wheel(over), wheel(), wheel(), wheel()];

  it('is silent while the tyres grip, and howls in a slide', () => {
    expect(tyreSlide(four(), 30, 3000)).toBe(0);
    expect(tyreSlide(four({ slipAngle: 0.04 }), 30, 3000)).toBe(0);
    const mild = tyreSlide(four({ slipAngle: 0.12 }), 30, 3000);
    const full = tyreSlide(four({ slipAngle: -0.4 }), 30, 3000);
    expect(mild).toBeGreaterThan(0);
    expect(mild).toBeLessThan(full);
    expect(full).toBe(1);
  });

  it('squeals for wheelspin from rest and lock-ups at speed', () => {
    expect(tyreSlide(four({ spinning: true }), 0, 3000)).toBe(1);
    expect(tyreSlide(four({ locked: true }), 30, 3000)).toBe(1);
    // A locked wheel on a stationary car makes no noise.
    expect(tyreSlide(four({ locked: true }), 0, 3000)).toBe(0);
  });

  it('does not squeal on grass, in the air or on an unloaded wheel', () => {
    expect(tyreSlide(four({ slipAngle: 0.4, surfaceGrip: 0.55 }), 30, 3000)).toBe(0);
    expect(tyreSlide(four({ slipAngle: 0.4, grounded: false }), 30, 3000)).toBe(0);
    expect(tyreSlide(four({ slipAngle: 0.4, load: 300 }), 30, 3000)).toBeCloseTo(0.1);
  });

  it('gets louder and higher with slide and speed', () => {
    expect(squealTone(0, 30).level).toBe(0);
    expect(squealTone(1, 30).level).toBe(1);
    expect(squealTone(0.5, 60).frequency).toBeGreaterThan(squealTone(0.5, 10).frequency);
  });

  it('adds wind with speed, none at rest', () => {
    expect(windTone(0).level).toBe(0);
    expect(windTone(30).level).toBeGreaterThan(0);
    expect(windTone(80).level).toBeGreaterThan(windTone(30).level * 4);
    expect(windTone(200).level).toBe(1);
    expect(windTone(80).frequency).toBeGreaterThan(windTone(30).frequency);
  });

  it('rumbles on kerbs at the rate the stripes pass', () => {
    expect(kerbTone(false, 40).level).toBe(0);
    expect(kerbTone(true, 0).level).toBe(0);
    expect(kerbTone(true, 40).level).toBe(1);
    expect(kerbTone(true, 40).frequency).toBe(40);
    expect(kerbTone(true, 300).frequency).toBe(90);
  });

  it('thumps for hits only, harder ones louder', () => {
    expect(impactLevel(0.3)).toBe(0);
    expect(impactLevel(0.8)).toBe(0);
    expect(impactLevel(1.5)).toBeGreaterThan(0);
    expect(impactLevel(4)).toBeGreaterThan(impactLevel(1.5));
    expect(impactLevel(50)).toBe(1);
  });
});
