import { MathUtils, Quaternion, Vector3, type PerspectiveCamera } from 'three';

export type CameraMode = 'chase' | 'hood';
const MODES: CameraMode[] = ['chase', 'hood'];

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
    if (this.mode === 'hood') this.updateHood(carPosition, carRotation);
    else this.updateChase(dt, carPosition, carRotation, speed);

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

  private updateHood(carPosition: Vector3, carRotation: Quaternion): void {
    this.camera.position.copy(this.tmp.set(0, 0.78, 1.1).applyQuaternion(carRotation).add(carPosition));
    this.target.set(0, 0.5, 20).applyQuaternion(carRotation).add(carPosition);
    this.camera.up.set(0, 1, 0).applyQuaternion(carRotation);
    this.camera.lookAt(this.target);
  }
}
