import { wheelAngleDeg } from '@drivee/shared/controller';

/** Generic Sensor API GravitySensor (Chrome 91+); not in TypeScript's DOM lib. */
interface GravitySensorLike extends EventTarget {
  readonly x: number | null;
  readonly y: number | null;
  readonly timestamp: number | null;
  start(): void;
  stop(): void;
}
type GravitySensorConstructor = new (options: { frequency: number }) => GravitySensorLike;

export type TiltSource = 'gravity' | 'motion';

/** If the gravity sensor gives nothing within this long, fall back to devicemotion. */
const FIRST_READING_TIMEOUT_MS = 1000;

/**
 * Reports the phone's wheel angle (degrees, clockwise positive) whenever the gravity
 * vector updates. Uses the fused `GravitySensor` when available, which is smooth and
 * unaffected by the phone being shaken; otherwise `devicemotion`'s
 * `accelerationIncludingGravity`, which is noisier but supported everywhere.
 */
export class TiltSensor {
  source: TiltSource | null = null;
  private sensor: GravitySensorLike | null = null;
  private lastTime: number | null = null;

  constructor(private readonly onAngle: (angleDeg: number, dt: number) => void) {}

  async start(): Promise<TiltSource> {
    if (await this.tryGravitySensor()) return (this.source = 'gravity');
    window.addEventListener('devicemotion', this.onMotion);
    return (this.source = 'motion');
  }

  private tryGravitySensor(): Promise<boolean> {
    const Gravity = (window as unknown as { GravitySensor?: GravitySensorConstructor }).GravitySensor;
    if (!Gravity) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const settle = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (!ok) {
          this.sensor?.stop();
          this.sensor = null;
        }
        resolve(ok);
      };
      try {
        const sensor = new Gravity({ frequency: 60 });
        sensor.addEventListener('reading', () => {
          settle(true);
          if (sensor.x !== null && sensor.y !== null) this.emit(sensor.x, sensor.y, sensor.timestamp ?? performance.now());
        });
        sensor.addEventListener('error', () => settle(false));
        this.sensor = sensor;
        sensor.start();
        setTimeout(() => settle(false), FIRST_READING_TIMEOUT_MS);
      } catch {
        settle(false);
      }
    });
  }

  private readonly onMotion = (event: DeviceMotionEvent) => {
    const g = event.accelerationIncludingGravity;
    if (g?.x == null || g.y == null) return;
    this.emit(g.x, g.y, event.timeStamp);
  };

  private emit(gx: number, gy: number, time: number): void {
    const angle = wheelAngleDeg(gx, gy, screenAngle());
    const dt = this.lastTime === null ? 0 : Math.min((time - this.lastTime) / 1000, 0.1);
    this.lastTime = time;
    if (angle !== null) this.onAngle(angle, dt);
  }
}

function screenAngle(): number {
  const angle = screen.orientation?.angle;
  if (typeof angle === 'number') return angle;
  const legacy = (window as unknown as { orientation?: number }).orientation;
  return typeof legacy === 'number' ? (legacy + 360) % 360 : 0;
}
