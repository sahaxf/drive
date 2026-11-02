import RAPIER, { type RigidBody, type World } from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import type { AxleSuspensionSpec, CarSpec, InputState, TyreSpec } from '@drivee/shared';
import {
  createDrivetrainState,
  maxWheelOmega,
  updateDrivetrain,
  type DrivetrainState,
} from './drivetrain';
import { computeTyreForce } from './tyre';

const GRAVITY = 9.81;
const AIR_DENSITY = 1.225;
const UP = new Vector3(0, 1, 0);

// Stability assist tuning.
/** Below this the car can't really slide and the assist stays out of the way, m/s. */
const STABILITY_MIN_SPEED = 4;
/** Fraction of the body's sideslip angle added to the front wheels as countersteer. */
const COUNTERSTEER_GAIN = 0.8;
/** Yaw rate beyond the steering's request that is left alone, rad/s (~3°/s). */
const YAW_TOLERANCE = 0.05;
/** How fast unrequested yaw is removed, 1/s (excess decays to a third in ~0.2 s). */
const YAW_DAMPING = 6;
/** Strongest corrective yaw acceleration, rad/s². */
const MAX_YAW_CORRECTION = 3;

export type WheelId = 'FL' | 'FR' | 'RL' | 'RR';

export interface WheelState {
  id: WheelId;
  front: boolean;
  left: boolean;
  driven: boolean;
  /** Top of the suspension in car-local space. */
  mount: Vector3;
  suspension: AxleSuspensionSpec;
  tyre: TyreSpec;
  /** Current suspension length (mount to wheel centre). */
  length: number;
  compression: number;
  grounded: boolean;
  /** Normal load, N. */
  load: number;
  steerAngle: number;
  /** Angular velocity, rad/s, and accumulated spin angle for rendering. */
  omega: number;
  spinAngle: number;
  /** Extra spin above rolling speed from wheelspin. */
  spinExcess: number;
  locked: boolean;
  spinning: boolean;
  contactPoint: Vector3;
  contactNormal: Vector3;
  /** Grip multiplier of the surface under this wheel. */
  surfaceGrip: number;
}

export interface VehicleTelemetry {
  speed: number;
  forwardSpeed: number;
  rpm: number;
  gear: number;
  throttle: number;
  brake: number;
  /** Engine load 0..1: delivered throttle, 0 during a shift. */
  load: number;
  wheelspin: boolean;
  lockup: boolean;
}

/**
 * Raycast vehicle: one rigid body for the chassis, four suspension rays, and a
 * force-based tyre model per wheel. Car-local axes: +Y up, +Z forward, +X left.
 */
export class Vehicle {
  readonly body: RigidBody;
  readonly wheels: WheelState[];
  readonly telemetry: VehicleTelemetry;
  tractionControl: boolean;
  abs: boolean;
  stability: boolean;
  /** Maps the collider under a wheel to a grip multiplier; the track installs its own. */
  surfaceGrip: (colliderHandle: number) => number = () => 1;

  private readonly drivetrain: DrivetrainState;
  private readonly nominalLoad: number;
  private readonly yawInertia: number;
  private readonly wheelbase: number;

  // Scratch vectors, reused every step to avoid garbage.
  private readonly pos = new Vector3();
  private readonly rot = new Quaternion();
  private readonly up = new Vector3();
  private readonly forward = new Vector3();
  private readonly com = new Vector3();
  private readonly v = new Vector3();
  private readonly tmp = new Vector3();
  private readonly wheelForward = new Vector3();
  private readonly wheelLateral = new Vector3();
  private readonly impulse = new Vector3();
  /**
   * Rapier applies impulses to velocity immediately, so applying them wheel by wheel
   * would let each wheel see velocity already changed by the previous one. Queue them
   * and apply all at the end of the step instead.
   */
  private readonly queued = Array.from({ length: 12 }, () => ({ impulse: new Vector3(), point: new Vector3() }));
  private queuedCount = 0;
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

  constructor(
    private readonly world: World,
    readonly spec: CarSpec,
    position: Vector3,
    yaw = 0,
  ) {
    const { chassis } = spec;
    const [hx, hy, hz] = chassis.halfExtents;
    const [sx, sy, sz] = chassis.inertiaScale;
    const m = chassis.mass;
    const inertia = {
      x: ((m / 3) * (hy * hy + hz * hz)) * sx,
      y: ((m / 3) * (hx * hx + hz * hz)) * sy,
      z: ((m / 3) * (hx * hx + hy * hy)) * sz,
    };
    const [cx, cy, cz] = chassis.centerOfMass;

    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setAdditionalMassProperties(m, { x: cx, y: cy, z: cz }, inertia, { x: 0, y: 0, z: 0, w: 1 })
      .setCanSleep(false)
      .setCcdEnabled(true)
      .setLinearDamping(0.01)
      .setAngularDamping(0.05);
    this.body = world.createRigidBody(desc);
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz).setDensity(0).setFriction(0.3).setRestitution(0.1),
      this.body,
    );

    this.nominalLoad = (m * GRAVITY) / 4;
    this.wheels = this.createWheels();
    this.drivetrain = createDrivetrainState(spec);
    this.tractionControl = spec.assists.tractionControl;
    this.abs = spec.assists.abs;
    this.stability = spec.assists.stability;
    this.yawInertia = inertia.y;
    this.wheelbase = spec.wheels.frontAxleZ - spec.wheels.rearAxleZ;
    this.telemetry = {
      speed: 0,
      forwardSpeed: 0,
      rpm: spec.engine.idleRpm,
      gear: 1,
      throttle: 0,
      brake: 0,
      load: 0,
      wheelspin: false,
      lockup: false,
    };
    this.reset(position, yaw);
  }

  /** Teleport upright at `position` facing `yaw` (radians about +Y), at rest. */
  reset(position: Vector3, yaw: number): void {
    const q = new Quaternion().setFromAxisAngle(UP, yaw);
    this.body.setTranslation(position, true);
    this.body.setRotation(q, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    Object.assign(this.drivetrain, createDrivetrainState(this.spec));
    for (const w of this.wheels) {
      w.compression = 0;
      w.length = w.suspension.restLength;
      w.omega = 0;
      w.spinExcess = 0;
    }
  }

  /** Advance one fixed physics step. Call before `world.step()`. */
  step(input: InputState, dt: number): void {
    this.readPose();
    const linvel = this.body.linvel();
    const forwardSpeed = linvel.x * this.forward.x + linvel.y * this.forward.y + linvel.z * this.forward.z;
    const speed = Math.hypot(linvel.x, linvel.y, linvel.z);

    this.castSuspension(dt);
    this.applySuspension(dt);

    const driven = this.wheels.filter((w) => w.driven);
    const drivenOmega = driven.reduce((sum, w) => sum + w.omega, 0) / driven.length;
    const out = updateDrivetrain(
      this.spec,
      this.drivetrain,
      { throttle: input.throttle, brake: input.brake, forwardSpeed, drivenWheelOmega: drivenOmega },
      dt,
    );

    const driverAngle = this.steerAngle(input.steer, Math.abs(forwardSpeed));
    const steerAngle = this.stability ? this.countersteer(driverAngle, linvel, forwardSpeed) : driverAngle;
    let wheelspin = false;
    let lockup = false;
    for (const w of this.wheels) {
      w.steerAngle = w.front ? steerAngle : 0;
      const result = this.applyTyre(w, out.wheelTorque, out.brake, input.handbrake, dt);
      wheelspin ||= result.spinning;
      lockup ||= result.locked;
    }

    this.applyAero(speed, forwardSpeed, dt);
    this.flushImpulses();
    if (this.stability && !input.handbrake) this.dampYaw(driverAngle, forwardSpeed, dt);

    Object.assign(this.telemetry, {
      speed,
      forwardSpeed,
      rpm: this.drivetrain.rpm,
      gear: this.drivetrain.gear,
      throttle: out.throttle,
      brake: out.brake,
      load: out.load,
      wheelspin,
      lockup,
    });
  }

  private createWheels(): WheelState[] {
    const { wheels: geo, suspension, tyres, drivetrain } = this.spec;
    const layout: Array<[WheelId, boolean, boolean]> = [
      ['FL', true, true],
      ['FR', true, false],
      ['RL', false, true],
      ['RR', false, false],
    ];
    return layout.map(([id, front, left]) => {
      const track = front ? geo.trackFront : geo.trackRear;
      const susp = front ? suspension.front : suspension.rear;
      return {
        id,
        front,
        left,
        driven:
          drivetrain.layout === 'AWD' ||
          (drivetrain.layout === 'FWD' && front) ||
          (drivetrain.layout === 'RWD' && !front),
        mount: new Vector3((left ? 1 : -1) * (track / 2), geo.mountY, front ? geo.frontAxleZ : geo.rearAxleZ),
        suspension: susp,
        tyre: front ? tyres.front : tyres.rear,
        length: susp.restLength,
        compression: 0,
        grounded: false,
        load: 0,
        steerAngle: 0,
        omega: 0,
        spinAngle: 0,
        spinExcess: 0,
        locked: false,
        spinning: false,
        contactPoint: new Vector3(),
        contactNormal: new Vector3(0, 1, 0),
        surfaceGrip: 1,
      };
    });
  }

  private readPose(): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.pos.set(t.x, t.y, t.z);
    this.rot.set(r.x, r.y, r.z, r.w);
    this.up.set(0, 1, 0).applyQuaternion(this.rot);
    this.forward.set(0, 0, 1).applyQuaternion(this.rot);
    const c = this.body.worldCom();
    this.com.set(c.x, c.y, c.z);
  }

  private castSuspension(dt: number): void {
    const radius = this.spec.wheels.radius;
    for (const w of this.wheels) {
      const origin = this.tmp.copy(w.mount).applyQuaternion(this.rot).add(this.pos);
      this.ray.origin = { x: origin.x, y: origin.y, z: origin.z };
      this.ray.dir = { x: -this.up.x, y: -this.up.y, z: -this.up.z };
      const maxReach = w.suspension.restLength + radius;
      const hit = this.world.castRayAndGetNormal(
        this.ray,
        maxReach,
        true,
        undefined,
        undefined,
        undefined,
        this.body,
      );

      const previous = w.compression;
      if (hit) {
        w.grounded = true;
        w.surfaceGrip = this.surfaceGrip(hit.collider.handle);
        // May exceed restLength when the wheel is pushed into the ground (bump stop).
        w.compression = w.suspension.restLength - (hit.timeOfImpact - radius);
        w.length = Math.max(0, hit.timeOfImpact - radius);
        w.contactPoint.copy(this.up).multiplyScalar(-hit.timeOfImpact).add(origin);
        w.contactNormal.set(hit.normal.x, hit.normal.y, hit.normal.z);
      } else {
        w.grounded = false;
        w.compression = 0;
        w.length = w.suspension.restLength;
      }
      const velocity = (w.compression - previous) / dt;
      w.load = w.grounded ? this.springForce(w, velocity) : 0;
    }

    // Anti-roll bars move load from the lighter side to the more compressed side.
    for (const [l, r] of [
      [0, 1],
      [2, 3],
    ] as const) {
      const left = this.wheels[l]!;
      const right = this.wheels[r]!;
      if (!left.grounded || !right.grounded) continue;
      const transfer = left.suspension.antiRoll * (left.compression - right.compression);
      left.load = Math.max(0, left.load + transfer);
      right.load = Math.max(0, right.load - transfer);
    }
  }

  private springForce(w: WheelState, compressionVelocity: number): number {
    const s = w.suspension;
    const damping = compressionVelocity > 0 ? s.bumpDamping : s.reboundDamping;
    let force = s.stiffness * w.compression + damping * compressionVelocity;
    const bottomOut = w.compression - s.restLength;
    if (bottomOut > 0) force += s.stiffness * 6 * bottomOut;
    return Math.max(0, force);
  }

  private applySuspension(dt: number): void {
    for (const w of this.wheels) {
      if (!w.grounded || w.load <= 0) continue;
      this.impulse.copy(w.contactNormal).multiplyScalar(w.load * dt);
      this.queueImpulse(this.impulse, w.contactPoint);
    }
  }

  /**
   * Stability assist, part 1: turn the front wheels partly toward where the car is
   * actually travelling. In a slide this is the countersteer a driver would apply; with
   * the steering centred, it lets the rear tyres pull the car straight again.
   */
  private countersteer(driverAngle: number, linvel: { x: number; y: number; z: number }, forwardSpeed: number): number {
    if (Math.abs(forwardSpeed) < STABILITY_MIN_SPEED) return driverAngle;
    // Car-local +X is left; positive steer angles also point the wheels left.
    this.tmp.set(1, 0, 0).applyQuaternion(this.rot);
    const lateral = linvel.x * this.tmp.x + linvel.y * this.tmp.y + linvel.z * this.tmp.z;
    const sideslip = Math.atan2(lateral, Math.abs(forwardSpeed));
    const max = (this.spec.steering.maxAngleDeg * Math.PI) / 180;
    return Math.max(-max, Math.min(max, driverAngle + sideslip * COUNTERSTEER_GAIN));
  }

  /**
   * Stability assist, part 2: compare the yaw rate with what the steering asks for (a
   * bicycle model, capped at what the tyres can sustain) and remove the excess with a
   * yaw torque, as ESC does with individual-wheel braking.
   */
  private dampYaw(driverAngle: number, forwardSpeed: number, dt: number): void {
    const speed = Math.abs(forwardSpeed);
    if (speed < STABILITY_MIN_SPEED) return;
    const w = this.body.angvel();
    const yawRate = w.x * this.up.x + w.y * this.up.y + w.z * this.up.z;
    // Downforce adds grip at speed, so the car may legitimately corner harder than 1 g × grip.
    const downforce = 0.5 * AIR_DENSITY * this.spec.aero.downforceArea * speed * speed;
    const aeroGain = 1 + downforce / (this.spec.chassis.mass * GRAVITY);
    const gripLimit = (this.spec.tyres.front.grip * aeroGain * GRAVITY) / speed;
    const target = Math.max(-gripLimit, Math.min(gripLimit, (forwardSpeed * Math.tan(driverAngle)) / this.wheelbase));
    const excess = yawRate - target;
    // Only the part of the excess outside the tolerance is corrected, so normal driving is untouched.
    const over = Math.sign(excess) * Math.max(Math.abs(excess) - YAW_TOLERANCE, 0);
    if (over === 0) return;
    const correction = Math.min(Math.abs(over) * YAW_DAMPING, MAX_YAW_CORRECTION) * Math.sign(over);
    const impulse = -correction * this.yawInertia * dt;
    this.body.applyTorqueImpulse({ x: this.up.x * impulse, y: this.up.y * impulse, z: this.up.z * impulse }, true);
  }

  private steerAngle(steer: number, speed: number): number {
    const { maxAngleDeg, highSpeed, minLockFactor } = this.spec.steering;
    const t = Math.min(speed / highSpeed, 1);
    const lock = 1 + (minLockFactor - 1) * t;
    // Positive steer = right, which is a negative rotation about +Y.
    return -steer * lock * ((maxAngleDeg * Math.PI) / 180);
  }

  private applyTyre(
    w: WheelState,
    wheelTorque: number,
    brake: number,
    handbrake: boolean,
    dt: number,
  ) {
    const radius = this.spec.wheels.radius;
    const brakes = this.spec.brakes;
    const drivenCount = this.wheels.filter((x) => x.driven).length;
    const axleShare = this.driveShare(w, drivenCount);
    const driveForce = w.driven ? (wheelTorque * axleShare) / radius : 0;
    const bias = w.front ? brakes.frontBias : 1 - brakes.frontBias;
    let brakeTorque = (brake * brakes.maxTorque * bias) / 2;
    const handbraking = handbrake && !w.front;
    if (handbraking) brakeTorque += brakes.handbrakeTorque / 2;

    if (!w.grounded || w.load <= 0) {
      this.spinFree(w, driveForce, dt);
      w.locked = false;
      w.spinning = false;
      return { spinning: false, locked: false };
    }

    // Wheel heading projected onto the contact plane.
    const n = w.contactNormal;
    this.wheelForward.set(Math.sin(w.steerAngle), 0, Math.cos(w.steerAngle)).applyQuaternion(this.rot);
    this.wheelForward.addScaledVector(n, -this.wheelForward.dot(n)).normalize();
    this.wheelLateral.crossVectors(n, this.wheelForward).normalize();

    const pv = this.body.velocityAtPoint(w.contactPoint);
    this.v.set(pv.x, pv.y, pv.z);
    const vLong = this.v.dot(this.wheelForward);
    const vLat = this.v.dot(this.wheelLateral);

    const result = computeTyreForce({
      tyre: w.tyre,
      load: w.load,
      nominalLoad: this.nominalLoad,
      vLong,
      vLat,
      driveForce,
      brakeForce: brakeTorque / radius,
      massShare: w.load / GRAVITY,
      dt,
      tractionControl: this.tractionControl,
      abs: this.abs,
      handbrake: handbraking,
      gripScale: w.surfaceGrip,
    });

    this.updateWheelSpin(w, vLong, result.unusedDrive, result.locked, dt);
    w.locked = result.locked;
    w.spinning = result.spinning;

    this.impulse
      .copy(this.wheelForward)
      .multiplyScalar(result.fx)
      .addScaledVector(this.wheelLateral, result.fy)
      .multiplyScalar(dt);

    // Raise the application point toward the centre of mass to tame body roll.
    const rollInfluence = this.spec.wheels.rollInfluence;
    const heightToCom = this.tmp.copy(this.com).sub(w.contactPoint).dot(n);
    const point = this.tmp.copy(w.contactPoint).addScaledVector(n, heightToCom * (1 - rollInfluence));
    this.queueImpulse(this.impulse, point);

    return result;
  }

  private driveShare(w: WheelState, drivenCount: number): number {
    if (this.spec.drivetrain.layout !== 'AWD') return 1 / drivenCount;
    const split = this.spec.drivetrain.frontTorqueSplit;
    return (w.front ? split : 1 - split) / 2;
  }

  private updateWheelSpin(w: WheelState, vLong: number, unusedDrive: number, locked: boolean, dt: number): void {
    const radius = this.spec.wheels.radius;
    const rolling = vLong / radius;
    if (locked) {
      w.spinExcess = -rolling;
    } else if (unusedDrive !== 0) {
      w.spinExcess += ((unusedDrive * radius) / this.spec.wheels.inertia) * dt;
    } else {
      w.spinExcess *= Math.exp(-12 * dt);
    }
    w.omega = rolling + w.spinExcess;
    if (w.driven) {
      const limit = maxWheelOmega(this.spec, this.drivetrain.gear) * 1.02;
      w.omega = Math.max(-limit, Math.min(limit, w.omega));
      w.spinExcess = w.omega - rolling;
    }
    w.spinAngle = (w.spinAngle + w.omega * dt) % (Math.PI * 2);
  }

  /** Airborne wheel: drive spins it up freely, otherwise it slowly coasts down. */
  private spinFree(w: WheelState, driveForce: number, dt: number): void {
    const radius = this.spec.wheels.radius;
    w.omega += ((driveForce * radius) / this.spec.wheels.inertia) * dt * 0.1;
    w.omega *= Math.exp(-0.5 * dt);
    if (w.driven) {
      const limit = maxWheelOmega(this.spec, this.drivetrain.gear) * 1.02;
      w.omega = Math.max(-limit, Math.min(limit, w.omega));
    }
    w.spinExcess = 0;
    w.spinAngle = (w.spinAngle + w.omega * dt) % (Math.PI * 2);
  }

  private queueImpulse(impulse: Vector3, point: Vector3): void {
    const slot = this.queued[this.queuedCount++]!;
    slot.impulse.copy(impulse);
    slot.point.copy(point);
  }

  private flushImpulses(): void {
    for (let k = 0; k < this.queuedCount; k++) {
      const { impulse, point } = this.queued[k]!;
      this.body.applyImpulseAtPoint(impulse, point, true);
    }
    this.queuedCount = 0;
  }

  private applyAero(speed: number, forwardSpeed: number, dt: number): void {
    const { dragArea, downforceArea } = this.spec.aero;
    const lv = this.body.linvel();
    const drag = 0.5 * AIR_DENSITY * dragArea * speed;
    this.impulse.set(-lv.x * drag, -lv.y * drag, -lv.z * drag);
    const downforce = 0.5 * AIR_DENSITY * downforceArea * forwardSpeed * forwardSpeed;
    this.impulse.addScaledVector(this.up, -downforce).multiplyScalar(dt);
    this.queueImpulse(this.impulse, this.com);
  }
}
