export interface GameLoopHandlers {
  /** Called once per frame before any simulation steps (e.g. to sample input). */
  beginFrame?(frameDt: number): void;
  /** Fixed-rate simulation step. */
  step(dt: number): void;
  /**
   * Called once per frame. `alpha` (0..1) is how far we are between the last two
   * simulation steps, used to interpolate rendered poses.
   */
  render(alpha: number, frameDt: number): void;
}

/**
 * Fixed-timestep loop with an accumulator: the simulation always advances in
 * exact `fixedDt` slices regardless of display refresh rate.
 */
export class GameLoop {
  private accumulator = 0;
  private lastTime: number | null = null;
  private frame = 0;
  private running = false;

  constructor(
    private readonly handlers: GameLoopHandlers,
    readonly fixedDt: number,
    /** Longest frame we try to catch up on; longer stalls (tab switch) are dropped. */
    private readonly maxFrameDt = 0.25,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = null;
    const loop = (ms: number) => {
      if (!this.running) return;
      this.tick(ms / 1000);
      this.frame = requestAnimationFrame(loop);
    };
    this.frame = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frame);
  }

  /** Advance to `now` (seconds). Returns the number of simulation steps taken. */
  tick(now: number): number {
    const frameDt = this.lastTime === null ? 0 : Math.min(now - this.lastTime, this.maxFrameDt);
    this.lastTime = now;
    this.accumulator += frameDt;
    this.handlers.beginFrame?.(frameDt);

    let steps = 0;
    while (this.accumulator >= this.fixedDt) {
      this.handlers.step(this.fixedDt);
      this.accumulator -= this.fixedDt;
      steps++;
    }
    this.handlers.render(this.accumulator / this.fixedDt, frameDt);
    return steps;
  }
}
