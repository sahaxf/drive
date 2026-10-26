import { z } from 'zod';

/**
 * Schema for public/cars/<id>/car.json.
 * Units: metres, kilograms, seconds, newtons, radians (angles in the file are degrees
 * where the field name says so). Car-local axes: +Y up, +Z forward, +X left.
 */

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const positive = z.number().positive();
const nonNegative = z.number().nonnegative();

const axleSuspension = z.object({
  /** Suspension length at zero load. */
  restLength: positive,
  /** Spring rate, N/m per wheel. */
  stiffness: positive,
  /** Damping while compressing, N·s/m. */
  bumpDamping: nonNegative,
  /** Damping while extending, N·s/m. */
  reboundDamping: nonNegative,
  /** Anti-roll bar rate, N/m of left/right compression difference. */
  antiRoll: nonNegative,
});

const tyre = z.object({
  /** Peak friction coefficient at nominal load. */
  grip: positive,
  /** Pacejka-style lateral curve: stiffness (B), shape (C), curvature (E). */
  lateralB: positive,
  lateralC: positive,
  lateralE: z.number().max(1),
  /** Grip lost per unit of load above nominal (0 = none). */
  loadSensitivity: z.number().min(0).max(1),
  /** Grip multiplier for a sliding (spinning or locked) tyre. */
  slidingGrip: z.number().min(0).max(1),
  rollingResistance: nonNegative,
});

export const carSpecSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Model file and node mapping; the placeholder car has no model. */
  visual: z
    .object({
      model: z.string().optional(),
      paintColor: z.string().default('#d01c1f'),
    })
    .default({ paintColor: '#d01c1f' }),
  chassis: z.object({
    mass: positive,
    /** Collision box half-extents. */
    halfExtents: vec3,
    /** Centre of mass relative to the collision box centre. */
    centerOfMass: vec3,
    /** Multiplier on box-derived inertia (x = pitch, y = yaw, z = roll). */
    inertiaScale: vec3.default([1, 1, 1]),
  }),
  wheels: z.object({
    radius: positive,
    width: positive,
    /** Effective rotational inertia per wheel, kg·m². */
    inertia: positive,
    /** Z position of the front and rear axle relative to the box centre. */
    frontAxleZ: z.number(),
    rearAxleZ: z.number(),
    trackFront: positive,
    trackRear: positive,
    /** Y of the suspension top mount relative to the box centre. */
    mountY: z.number(),
    /**
     * How much tyre forces act at the contact patch (1) versus at centre-of-mass
     * height (0). Lower values reduce body roll and rollovers.
     */
    rollInfluence: z.number().min(0).max(1),
  }),
  suspension: z.object({ front: axleSuspension, rear: axleSuspension }),
  tyres: z.object({ front: tyre, rear: tyre }),
  steering: z.object({
    maxAngleDeg: positive,
    /** Speed (m/s) at which steering lock is reduced to minLockFactor. */
    highSpeed: positive,
    minLockFactor: z.number().min(0).max(1),
  }),
  engine: z.object({
    idleRpm: positive,
    redlineRpm: positive,
    /** RPM the engine holds while the clutch slips during a launch. */
    launchRpm: positive,
    /** [rpm, torque N·m] pairs, ascending by rpm. */
    torqueCurve: z.array(z.tuple([nonNegative, nonNegative])).min(2),
    /** Engine braking torque at redline with the throttle closed, N·m. */
    engineBraking: nonNegative,
  }),
  gearbox: z.object({
    /** Forward gear ratios, first gear first. */
    ratios: z.array(positive).min(1),
    reverse: positive,
    finalDrive: positive,
    efficiency: z.number().min(0).max(1),
    shiftTime: nonNegative,
    /** Auto-shift points as a fraction of redline. */
    upshiftAt: z.number().min(0).max(1),
    downshiftAt: z.number().min(0).max(1),
  }),
  drivetrain: z.object({
    layout: z.enum(['FWD', 'RWD', 'AWD']),
    /** Fraction of drive torque sent to the front axle (AWD only). */
    frontTorqueSplit: z.number().min(0).max(1).default(0.4),
  }),
  brakes: z.object({
    /** Total brake torque across all wheels, N·m. */
    maxTorque: positive,
    /** Fraction of brake torque on the front axle. */
    frontBias: z.number().min(0).max(1),
    handbrakeTorque: positive,
  }),
  aero: z.object({
    /** Drag coefficient × frontal area, m². */
    dragArea: nonNegative,
    /** Downforce coefficient × area, m². */
    downforceArea: nonNegative,
  }),
  assists: z.object({
    tractionControl: z.boolean(),
    abs: z.boolean(),
    /** Countersteers into slides and damps yaw the steering didn't ask for (like ESC). */
    stability: z.boolean().default(true),
  }),
});

export type CarSpec = z.infer<typeof carSpecSchema>;
export type TyreSpec = CarSpec['tyres']['front'];
export type AxleSuspensionSpec = CarSpec['suspension']['front'];

export function parseCarSpec(json: unknown): CarSpec {
  return carSpecSchema.parse(json);
}
