import { MathUtils, Quaternion, Vector3, type PerspectiveCamera } from 'three';
import type { CarSpec } from '@drivee/shared';

export type CameraMode = 'chase' | 'hood' | 'windshield' | 'bumper';
/** Cameras fixed to the car. */
export type OnboardMode = Exclude<CameraMode, 'chase'>;
const MODES: CameraMode[] = ['chase', 'hood', 'windshield', 'bumper'];

/** Position of each onboard camera, car-local. */
export type CameraMounts = Record<OnboardMode, readonly [number, number, number]>;

/** How far ahead an onboard camera looks, and how far below its own height, m. */
const ONBOARD_LOOK = { ahead: 19, drop: 0.28 };
/** The same from the driver's seat: nearly level, so the road fills the windscreen, not the dashboard. */
const CABIN_LOOK = { ahead: 19, drop: 0.06 };

/**
 * A car's onboard camera positions: those its car.json gives, the rest placed from the
 * collision box (half-height `hy`, half-length `hz`) so any car gets a usable set.
 */
export function cameraMounts(spec: Pick<CarSpec, 'chassis' | 'cameras'>): CameraMounts {
  const [, hy, hz] = spec.chassis.halfExtents;
  return {
    hood: spec.cameras.hood ?? [0, hy + 0.46, hz * 0.5],
    windshield: spec.cameras.windshield ?? [-0.3, hy + 0.1, hz * 0.05],
    bumper: spec.cameras.bumper ?? [0, 0.05, hz + 0.15],
  };
}

/** Mounts of the car the chase camera was tuned for, used when none are given. */
const REFERENCE_MOUNTS: CameraMounts = { hood: [0, 0.78, 1.1], windshield: [0, 0.94, 0.4], bumper: [0, 0.05, 2.35] };

const CHASE = { distance: 4.6, height: 1.35, lookAhead: 4, lookHeight: 1.0, yawRate: 4.5, heightRate: 9 };
/** Half the length of the car `CHASE.distance` was tuned for; longer cars sit further back. */
const REFERENCE_HALF_LENGTH = 2.2;
/**
 * Pull-away stretch: the camera drops back as the car gets going, up to `max` metres,
 * then holds that distance at any speed. `speed` (m/s) sets how quickly it saturates:
 * ~60% of `max` by that speed, ~95% by three times it.
 */
const LAG = { max: 1.2, speed: 8, rate: 3 };
const BASE_FOV = 62;
const SPEED_FOV = 14;
const FOV_FULL_SPEED = 80;

export class CameraRig {
  mode: CameraMode = 'chase';
  private yaw = 0;
  private lag = 0;
  private readonly position = new Vector3();
  private readonly target = new Vector3();
  private readonly tmp = new Vector3();
  private initialised = false;

  /** Extra chase distance so a longer car is framed like the reference one. */
  private readonly extraDistance: number;

  constructor(
    private readonly camera: PerspectiveCamera,
    carHalfLength = REFERENCE_HALF_LENGTH,
    private readonly mounts: CameraMounts = REFERENCE_MOUNTS,
  ) {
    this.extraDistance = Math.max(0, carHalfLength - REFERENCE_HALF_LENGTH);
  }

  cycle(): void {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]!;
    this.initialised = false;
  }

  /** Jump straight to the resting position (after a reset or teleport). */
  snap(): void {
    this.initialised = false;
  }

  update(dt: number, carPosition: Vector3, carRotation: Quaternion, speed: number): void {
    if (this.mode === 'chase') this.updateChase(dt, carPosition, carRotation, speed);
    else this.updateOnboard(this.mounts[this.mode], this.mode === 'windshield' ? CABIN_LOOK : ONBOARD_LOOK, carPosition, carRotation);

    const fov = BASE_FOV + SPEED_FOV * Math.min(speed / FOV_FULL_SPEED, 1);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = MathUtils.damp(this.camera.fov, fov, 3, dt);
      this.camera.updateProjectionMatrix();
    }
  }

  private updateChase(dt: number, carPosition: Vector3, carRotation: Quaternion, speed: number): void {
    const forward = this.tmp.set(0, 0, 1).applyQuaternion(carRotation);
    const carYaw = Math.atan2(forward.x, forward.z);

    if (!this.initialised) {
      this.yaw = carYaw;
      this.lag = 0;
    } else {
      // Ease the orbit angle toward the car's heading so the camera swings through corners.
      const diff = Math.atan2(Math.sin(carYaw - this.yaw), Math.cos(carYaw - this.yaw));
      this.yaw += diff * (1 - Math.exp(-CHASE.yawRate * dt));
    }

    // Horizontal position is locked to the car: smoothing it would make the camera trail
    // further behind the faster the car goes. Distance only grows by the capped pull-away
    // lag; height is eased to soak up bumps and crests.
    const targetLag = LAG.max * (1 - Math.exp(-speed / LAG.speed));
    this.lag = MathUtils.damp(this.lag, targetLag, LAG.rate, dt);
    const distance = CHASE.distance + this.extraDistance + this.lag;
    const desiredY = carPosition.y + CHASE.height;
    this.position.set(
      carPosition.x - Math.sin(this.yaw) * distance,
      this.initialised ? MathUtils.damp(this.position.y, desiredY, CHASE.heightRate, dt) : desiredY,
      carPosition.z - Math.cos(this.yaw) * distance,
    );

    this.target
      .set(Math.sin(this.yaw), 0, Math.cos(this.yaw))
      .multiplyScalar(CHASE.lookAhead)
      .add(carPosition);
    this.target.y += CHASE.lookHeight;

    this.camera.position.copy(this.position);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.target);
    this.initialised = true;
  }

  /** Fixed to the car at `mount`, rolling and pitching with it, looking straight ahead. */
  private updateOnboard(
    mount: readonly [number, number, number],
    look: { ahead: number; drop: number },
    carPosition: Vector3,
    carRotation: Quaternion,
  ): void {
    const [x, y, z] = mount;
    this.camera.position.copy(this.tmp.set(x, y, z).applyQuaternion(carRotation).add(carPosition));
    this.target.set(x, y - look.drop, z + look.ahead).applyQuaternion(carRotation).add(carPosition);
    this.camera.up.set(0, 1, 0).applyQuaternion(carRotation);
    this.camera.lookAt(this.target);
  }
}
