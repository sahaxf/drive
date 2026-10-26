import { MathUtils, Quaternion, Vector3, type PerspectiveCamera } from 'three';

export type CameraMode = 'chase' | 'hood';
const MODES: CameraMode[] = ['chase', 'hood'];

const CHASE = { distance: 6.2, height: 2.0, lookAhead: 3, lookHeight: 0.9, yawRate: 4.5, posRate: 9 };
const BASE_FOV = 62;
const SPEED_FOV = 14;
const FOV_FULL_SPEED = 80;

export class CameraRig {
  mode: CameraMode = 'chase';
  private yaw = 0;
  private readonly position = new Vector3();
  private readonly target = new Vector3();
  private readonly tmp = new Vector3();
  private initialised = false;

  constructor(private readonly camera: PerspectiveCamera) {}

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
    else this.updateChase(dt, carPosition, carRotation);

    const fov = BASE_FOV + SPEED_FOV * Math.min(speed / FOV_FULL_SPEED, 1);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = MathUtils.damp(this.camera.fov, fov, 3, dt);
      this.camera.updateProjectionMatrix();
    }
  }

  private updateChase(dt: number, carPosition: Vector3, carRotation: Quaternion): void {
    const forward = this.tmp.set(0, 0, 1).applyQuaternion(carRotation);
    const carYaw = Math.atan2(forward.x, forward.z);

    if (!this.initialised) {
      this.yaw = carYaw;
    } else {
      // Ease the orbit angle toward the car's heading so the camera swings through corners.
      const diff = Math.atan2(Math.sin(carYaw - this.yaw), Math.cos(carYaw - this.yaw));
      this.yaw += diff * (1 - Math.exp(-CHASE.yawRate * dt));
    }

    const behind = this.tmp.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const desired = behind.multiplyScalar(CHASE.distance).add(carPosition);
    desired.y = carPosition.y + CHASE.height;

    if (!this.initialised) this.position.copy(desired);
    else this.position.lerp(desired, 1 - Math.exp(-CHASE.posRate * dt));
    this.position.y = Math.max(this.position.y, 0.4);

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
