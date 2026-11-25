import type { CarSpec } from '@drivee/shared';
import { gearRatio, sampleTorqueCurve } from './vehicle/drivetrain';

const AIR_DENSITY = 1.225;
const RPM_TO_RAD_PER_SEC = (2 * Math.PI) / 60;

export interface CarStats {
  /** Peak engine power, metric horsepower. */
  powerHp: number;
  /** kg */
  mass: number;
  /** Which wheels are driven. */
  layout: CarSpec['drivetrain']['layout'];
  /** Estimated top speed, km/h. */
  topSpeedKmh: number;
}

/** Headline numbers for the car selection screen, worked out from the car's physics data. */
export function carStats(spec: CarSpec): CarStats {
  const { engine, gearbox, aero, wheels } = spec;
  // Torque is given at a few points; power can peak between them.
  let power = 0;
  for (let rpm = engine.idleRpm; rpm <= engine.redlineRpm; rpm += 50) {
    power = Math.max(power, sampleTorqueCurve(engine.torqueCurve, rpm) * rpm * RPM_TO_RAD_PER_SEC);
  }

  // Top speed is where the engine runs out of revs in top gear, or of power against the air.
  const geared = ((engine.redlineRpm * RPM_TO_RAD_PER_SEC) / gearRatio(gearbox, gearbox.ratios.length)) * wheels.radius;
  const dragLimited =
    aero.dragArea > 0 ? Math.cbrt((2 * power * gearbox.efficiency) / (AIR_DENSITY * aero.dragArea)) : Infinity;

  return {
    powerHp: Math.round(power / 735.5),
    mass: spec.chassis.mass,
    layout: spec.drivetrain.layout,
    topSpeedKmh: Math.round(Math.min(geared, dragLimited) * 3.6),
  };
}
