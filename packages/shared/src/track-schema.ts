import { z } from 'zod';

/**
 * Schema for public/tracks/<id>/track.json. A track is data, not code: the engine
 * builds road, terrain, forest and mountains from this file alone.
 * Units: metres and degrees. World axes: +Y up.
 */

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const positive = z.number().positive();
const nonNegative = z.number().nonnegative();

const controlPoint = z.object({
  /** Position of the road centre, [x, y, z]. */
  p: vec3,
  /** Road width at this point (defaults to centreline.width). */
  width: positive.optional(),
  /** Road roll in degrees; positive raises the left edge (banks a right-hander). */
  banking: z.number().min(-30).max(30).optional(),
});

export const trackSpecSchema = z.object({
  meta: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    author: z.string().default('unknown'),
    version: z.number().int().positive().default(1),
  }),
  centreline: z.object({
    /** Default road width, m. */
    width: positive.default(11),
    /** Closed loop of control points, in driving order. */
    points: z.array(controlPoint).min(4),
  }),
  roadside: z
    .object({
      /** Grass run-off between road edge and barrier, m. */
      vergeWidth: nonNegative.default(5),
      barrierHeight: positive.default(0.75),
      /** Kerbs are laid on the inside of corners tighter than this radius, m. */
      kerbRadius: positive.default(180),
      kerbWidth: positive.default(1.2),
    })
    .default({ vergeWidth: 5, barrierHeight: 0.75, kerbRadius: 180, kerbWidth: 1.2 }),
  race: z.object({
    /** Start/finish line, metres along the loop from the first control point. */
    startDistance: nonNegative.default(0),
  }),
  terrain: z.object({
    seed: z.number().int(),
    /** Grid spacing of the near terrain, m. */
    resolution: positive.default(4),
    /** Margin of near terrain around the track's bounding box, m. */
    margin: positive.default(400),
    /** Distance from the road edge where terrain starts blending away from road height, m. */
    corridorInner: nonNegative.default(4),
    /** Distance from the road edge where terrain is fully natural, m. */
    corridorOuter: positive.default(70),
    /** How far below the road surface the carved corridor sits, m. */
    roadDrop: nonNegative.default(0.25),
    /** Amplitude of the rolling hills, m. */
    hillHeight: nonNegative.default(40),
    hillScale: positive.default(600),
    mountains: z.object({
      /** Mountains start rising this far beyond the near terrain edge, m. */
      startOffset: nonNegative.default(200),
      /** Outer radius of the mountain ring, m. */
      outerRadius: positive.default(9000),
      peakHeight: positive.default(650),
    }),
  }),
  forest: z.object({
    seed: z.number().int(),
    /** Average trees per hectare in wooded areas. */
    density: positive.default(220),
    /** Tree-free distance beyond the barrier, m. */
    clearance: nonNegative.default(6),
    /** 0 = unbroken forest, 1 = mostly meadows. */
    meadowAmount: z.number().min(0).max(1).default(0.25),
    /** Fraction of broadleaf trees (the rest are spruce). */
    broadleaf: z.number().min(0).max(1).default(0.2),
  }),
  environment: z
    .object({
      fogNear: positive.default(500),
      fogFar: positive.default(7500),
    })
    .default({ fogNear: 500, fogFar: 7500 }),
});

export type TrackSpec = z.infer<typeof trackSpecSchema>;

export function parseTrackSpec(json: unknown): TrackSpec {
  return trackSpecSchema.parse(json);
}
