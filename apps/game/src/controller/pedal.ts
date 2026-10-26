/** Touching anywhere in a pedal zone gives at least this much. */
export const PEDAL_MIN = 0.25;
/** Height in the zone (0 = bottom, 1 = top) from which the pedal is fully pressed. */
const PEDAL_FULL_AT = 0.65;
/** Bottom strip that maps to {@link PEDAL_MIN}, so a resting thumb is predictable. */
const PEDAL_FLOOR = 0.1;

/**
 * Analog pedal from finger height: thumb low = gentle, slide up = harder. `yNorm` is the
 * touch position within the zone, 0 = top edge, 1 = bottom edge (as screens measure it).
 */
export function pedalValue(yNorm: number): number {
  const height = 1 - Math.min(Math.max(yNorm, 0), 1);
  const t = (height - PEDAL_FLOOR) / (PEDAL_FULL_AT - PEDAL_FLOOR);
  return PEDAL_MIN + (1 - PEDAL_MIN) * Math.min(Math.max(t, 0), 1);
}
