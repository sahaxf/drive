/** What the car felt this frame, as far as the phone's vibration motor cares. */
export interface HapticFrame {
  /** Any wheel is on a kerb. */
  onKerb: boolean;
  /** m/s */
  speed: number;
  /** Largest velocity change in a single physics step since the last frame, m/s. */
  impact: number;
  /** Engine is bouncing off the rev limiter. */
  atLimiter: boolean;
}

/** A velocity change above this in one 120 Hz step (~10 g) is a hit, not driving. */
export const IMPACT_THRESHOLD = 0.8;
const KERB_MIN_SPEED = 4;
const KERB_PERIOD = 0.14;
const LIMITER_PERIOD = 0.15;
/** Quiet time after a hit so its buzz isn't cut short by kerb or limiter pulses. */
const IMPACT_HOLD = 0.3;

/**
 * Turns driving events into vibration patterns: a pulse proportional to impact strength,
 * a rumble while on kerbs, a light buzz at the rev limiter. Patterns are rate-limited
 * because each one is a network message to the phone.
 */
export class HapticsDirector {
  private kerbTimer = 0;
  private limiterTimer = 0;
  private hold = 0;

  update(frame: HapticFrame, dt: number): number[] | null {
    this.kerbTimer = Math.max(this.kerbTimer - dt, 0);
    this.limiterTimer = Math.max(this.limiterTimer - dt, 0);
    this.hold = Math.max(this.hold - dt, 0);

    if (frame.impact > IMPACT_THRESHOLD && this.hold === 0) {
      this.hold = IMPACT_HOLD;
      return [Math.round(Math.min(40 + (frame.impact - IMPACT_THRESHOLD) * 35, 300))];
    }
    if (this.hold > 0) return null;
    if (frame.onKerb && frame.speed > KERB_MIN_SPEED && this.kerbTimer === 0) {
      this.kerbTimer = KERB_PERIOD;
      return [22];
    }
    if (frame.atLimiter && this.limiterTimer === 0) {
      this.limiterTimer = LIMITER_PERIOD;
      return [10];
    }
    return null;
  }
}
