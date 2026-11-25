/** Slower than this the car may be turning round or parking, m/s. */
const MIN_SPEED = 5;
/** Travelling against the track for this long before the warning shows, s. */
const DELAY = 1.5;

/**
 * Notices the car being driven the wrong way round the track: moving against the racing
 * direction for long enough that it isn't just a spin.
 */
export class WrongWayDetector {
  active = false;
  private timer = 0;

  /**
   * `alignment` is the car's heading along the track's direction (1 = with it, −1 =
   * against it), `forwardSpeed` its speed along its own heading (negative in reverse).
   */
  update(alignment: number, forwardSpeed: number, dt: number): boolean {
    // Reversing while facing the right way is going backwards too.
    const against = alignment * Math.sign(forwardSpeed) < -0.2 && Math.abs(forwardSpeed) > MIN_SPEED;
    this.timer = against ? this.timer + dt : 0;
    this.active = this.timer >= DELAY;
    return this.active;
  }

  reset(): void {
    this.timer = 0;
    this.active = false;
  }
}
