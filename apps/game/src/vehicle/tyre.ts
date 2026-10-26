import type { TyreSpec } from '@drivee/shared';

/**
 * Pacejka "magic formula", normalised so the peak is ~1.
 * Rises roughly linearly with slip, peaks, then falls off: the fall-off is what
 * makes a slide feel like a slide rather than a wall.
 */
export function magicFormula(slip: number, b: number, c: number, e: number): number {
  const bx = b * slip;
  return Math.sin(c * Math.atan(bx - e * (bx - Math.atan(bx))));
}

/** Peak friction coefficient after load sensitivity (heavier load -> slightly less grip per newton). */
export function effectiveGrip(tyre: TyreSpec, load: number, nominalLoad: number): number {
  const factor = 1 - tyre.loadSensitivity * (load / nominalLoad - 1);
  return tyre.grip * Math.min(Math.max(factor, 0.6), 1.3);
}

/**
 * Slip angle in radians. A minimum reference speed keeps it from exploding near
 * standstill, where tiny lateral velocities would otherwise read as huge angles.
 */
export function slipAngle(lateralVelocity: number, longitudinalVelocity: number): number {
  return Math.atan(lateralVelocity / Math.max(Math.abs(longitudinalVelocity), 1.5));
}

export interface TyreForceInput {
  tyre: TyreSpec;
  /** Normal load, N. */
  load: number;
  nominalLoad: number;
  /** Contact patch velocity along the wheel's heading / sideways (left +), m/s. */
  vLong: number;
  vLat: number;
  /** Drive force requested by the engine, N (+ = forward). */
  driveForce: number;
  /** Brake force magnitude requested, N (always >= 0). */
  brakeForce: number;
  /** Mass this wheel is responsible for stopping, kg (load / g). */
  massShare: number;
  dt: number;
  tractionControl: boolean;
  abs: boolean;
  /** Handbrake locks the wheel regardless of ABS. */
  handbrake: boolean;
  /** Surface grip multiplier (asphalt 1, grass less). */
  gripScale?: number;
}

export interface TyreForceOutput {
  /** Force along the wheel heading, N. */
  fx: number;
  /** Force sideways (left +), N. */
  fy: number;
  /** Drive force the tyre could not transmit (wheelspin), N. */
  unusedDrive: number;
  locked: boolean;
  spinning: boolean;
}

/**
 * Force-based tyre model. Longitudinal force comes straight from drive/brake torque
 * rather than from an integrated wheel-spin state: that ODE is stiff at 120 Hz and
 * blows up at low speed, while this stays stable and still gives wheelspin, lock-ups
 * and the friction circle (braking or accelerating hard costs cornering grip).
 */
export function computeTyreForce(i: TyreForceInput): TyreForceOutput {
  const maxForce = effectiveGrip(i.tyre, i.load, i.nominalLoad) * (i.gripScale ?? 1) * i.load;
  const slidingForce = maxForce * i.tyre.slidingGrip;

  // Largest force that would just cancel this wheel's share of velocity in one step.
  // Capping at this stops forces overshooting and jittering at low speed.
  const stopLong = (i.massShare * Math.abs(i.vLong)) / i.dt;
  const stopLat = (i.massShare * Math.abs(i.vLat)) / i.dt;

  const lateralDesired =
    -magicFormula(slipAngle(i.vLat, i.vLong), i.tyre.lateralB, i.tyre.lateralC, i.tyre.lateralE) *
    maxForce;
  let fy = clampAbs(lateralDesired, stopLat);

  const resistance = Math.min(i.brakeForce + i.tyre.rollingResistance * i.load, stopLong);
  const braking = -Math.sign(i.vLong) * resistance;

  let drive = i.driveForce;
  if (i.tractionControl && drive !== 0) {
    // Only spend the grip left over after cornering, but never cut drive to nothing.
    const available = Math.sqrt(Math.max(0, maxForce * maxForce - fy * fy));
    drive = clampAbs(drive, Math.max(available, maxForce * 0.25));
  }

  const requested = drive + braking;
  const brakeDominant = Math.abs(braking) > Math.abs(drive);

  if (Math.abs(requested) <= maxForce) {
    const lateralLimit = Math.sqrt(maxForce * maxForce - requested * requested);
    fy = clampAbs(fy, lateralLimit);
    // Drive trimmed by traction control was never delivered, so it does not spin the wheel.
    return { fx: requested, fy, unusedDrive: 0, locked: false, spinning: false };
  }

  if (brakeDominant && i.abs && !i.handbrake) {
    // ABS holds the tyre just under peak slip, so some steering survives.
    const fx = Math.sign(requested) * maxForce * 0.95;
    fy = clampAbs(fy, Math.sqrt(maxForce * maxForce - fx * fx));
    return { fx, fy, unusedDrive: 0, locked: false, spinning: false };
  }

  if (brakeDominant) {
    // Locked wheel: the sliding force opposes the contact patch velocity.
    const speed = Math.hypot(i.vLong, i.vLat);
    if (speed < 1e-3) return { fx: 0, fy: 0, unusedDrive: 0, locked: true, spinning: false };
    return {
      fx: clampAbs((-slidingForce * i.vLong) / speed, stopLong),
      fy: clampAbs((-slidingForce * i.vLat) / speed, stopLat),
      unusedDrive: 0,
      locked: true,
      spinning: false,
    };
  }

  // Wheelspin: most of the sliding grip goes into forward drive, little is left for cornering.
  const fx = Math.sign(requested) * slidingForce * 0.92;
  fy = clampAbs(fy, Math.sqrt(slidingForce * slidingForce - fx * fx));
  return { fx, fy, unusedDrive: requested - fx, locked: false, spinning: true };
}

function clampAbs(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value));
}
