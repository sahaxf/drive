import type { CarSpec } from '@drivee/shared';

type EngineSpec = CarSpec['engine'];
type GearboxSpec = CarSpec['gearbox'];

const RAD_PER_SEC_TO_RPM = 60 / (2 * Math.PI);

/** Linear interpolation over the [rpm, torque] table, clamped at both ends. */
export function sampleTorqueCurve(curve: EngineSpec['torqueCurve'], rpm: number): number {
  const first = curve[0]!;
  if (rpm <= first[0]) return first[1];
  for (let k = 1; k < curve.length; k++) {
    const [r1, t1] = curve[k]!;
    if (rpm <= r1) {
      const [r0, t0] = curve[k - 1]!;
      return t0 + ((t1 - t0) * (rpm - r0)) / (r1 - r0);
    }
  }
  return curve[curve.length - 1]![1];
}

export interface DrivetrainState {
  /** -1 = reverse, 1..n = forward gears. */
  gear: number;
  rpm: number;
  shiftTimer: number;
  /** Time spent holding the pedal that requests a direction change. */
  directionTimer: number;
  limiterCut: boolean;
  /** Throttle the engine is actually delivering: follows the pedal with a short lag. */
  engineThrottle: number;
}

export function createDrivetrainState(spec: CarSpec): DrivetrainState {
  return { gear: 1, rpm: spec.engine.idleRpm, shiftTimer: 0, directionTimer: 0, limiterCut: false, engineThrottle: 0 };
}

export interface DrivetrainInput {
  throttle: number;
  brake: number;
  /** Car velocity along its heading, m/s. */
  forwardSpeed: number;
  /** Mean angular velocity of the driven wheels, rad/s (+ = rolling forward). */
  drivenWheelOmega: number;
}

export interface DrivetrainOutput {
  /** Total torque at the driven wheels, N·m (+ pushes the car forward). */
  wheelTorque: number;
  /** Pedals after reverse remapping (in reverse, the brake pedal drives). */
  throttle: number;
  brake: number;
  /** How hard the engine is working, 0..1: delivered throttle, 0 while a shift cuts drive. */
  load: number;
}

export function gearRatio(gearbox: GearboxSpec, gear: number): number {
  const ratio = gear < 0 ? gearbox.reverse : gearbox.ratios[gear - 1]!;
  return ratio * gearbox.finalDrive;
}

/** Highest wheel speed (rad/s) the engine can reach in this gear. */
export function maxWheelOmega(spec: CarSpec, gear: number): number {
  return spec.engine.redlineRpm / RAD_PER_SEC_TO_RPM / gearRatio(spec.gearbox, gear);
}

/**
 * Automatic gearbox, clutch and engine. Mutates `state`.
 * Holding brake at a standstill selects reverse; holding throttle while in reverse
 * selects first again.
 */
export function updateDrivetrain(
  spec: CarSpec,
  state: DrivetrainState,
  input: DrivetrainInput,
  dt: number,
): DrivetrainOutput {
  const { engine, gearbox } = spec;
  updateDirection(state, input, dt);

  const reversing = state.gear < 0;
  const throttle = reversing ? input.brake : input.throttle;
  const brake = reversing ? input.throttle : input.brake;

  const ratio = gearRatio(gearbox, state.gear);
  const wheelRpm = Math.abs(input.drivenWheelOmega) * ratio * RAD_PER_SEC_TO_RPM;

  if (!reversing) autoShift(spec, state, wheelRpm);
  if (state.shiftTimer > 0) state.shiftTimer = Math.max(0, state.shiftTimer - dt);

  // Torque builds over `throttleResponse` instead of snapping on; it drops twice as fast.
  const response = engine.throttleResponse;
  if (response > 0) {
    const change = throttle - state.engineThrottle;
    const limit = (dt / response) * (change > 0 ? 1 : 2);
    state.engineThrottle += Math.max(-limit, Math.min(limit, change));
  } else {
    state.engineThrottle = throttle;
  }
  const delivered = state.engineThrottle;

  // Below launch rpm the clutch slips, letting the engine rev up while the wheels catch up.
  const clutchRpm = engine.idleRpm + delivered * (engine.launchRpm - engine.idleRpm);
  state.rpm = Math.min(Math.max(wheelRpm, clutchRpm), engine.redlineRpm * 1.02);

  if (state.rpm >= engine.redlineRpm) state.limiterCut = true;
  else if (state.rpm < engine.redlineRpm - 250) state.limiterCut = false;

  let engineTorque = 0;
  if (state.shiftTimer === 0) {
    if (delivered > 0.02 && !state.limiterCut) {
      engineTorque = sampleTorqueCurve(engine.torqueCurve, state.rpm) * delivered;
    } else if (delivered <= 0.02 && wheelRpm > engine.idleRpm) {
      engineTorque = -engine.engineBraking * (state.rpm / engine.redlineRpm);
    }
  }

  const direction = reversing ? -1 : 1;
  const wheelTorque = engineTorque * ratio * gearbox.efficiency * direction;
  return { wheelTorque, throttle, brake, load: state.shiftTimer > 0 ? 0 : delivered };
}

function updateDirection(state: DrivetrainState, input: DrivetrainInput, dt: number): void {
  const nearlyStopped = Math.abs(input.forwardSpeed) < 0.6;
  const wantsReverse = state.gear > 0 && input.brake > 0.3 && input.throttle < 0.05;
  const wantsForward = state.gear < 0 && input.throttle > 0.3 && input.brake < 0.05;

  if (nearlyStopped && (wantsReverse || wantsForward)) {
    state.directionTimer += dt;
    if (state.directionTimer > 0.35) {
      state.gear = wantsReverse ? -1 : 1;
      state.directionTimer = 0;
      state.shiftTimer = 0;
    }
  } else {
    state.directionTimer = 0;
  }
}

function autoShift(spec: CarSpec, state: DrivetrainState, wheelRpm: number): void {
  if (state.shiftTimer > 0) return;
  const { gearbox, engine } = spec;
  const upAt = gearbox.upshiftAt * engine.redlineRpm;
  const downAt = gearbox.downshiftAt * engine.redlineRpm;
  const top = gearbox.ratios.length;

  if (wheelRpm > upAt && state.gear < top) {
    state.gear += 1;
    state.shiftTimer = gearbox.shiftTime;
  } else if (wheelRpm < downAt && state.gear > 1) {
    // Only drop a gear if it won't immediately want to shift back up.
    const lower = state.gear - 1;
    const rpmAfter = (wheelRpm * gearRatio(gearbox, lower)) / gearRatio(gearbox, state.gear);
    if (rpmAfter < upAt * 0.95) {
      state.gear = lower;
      state.shiftTimer = gearbox.shiftTime * 0.6;
    }
  }
}
