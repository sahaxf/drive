import { Button, type InputState } from '@drivee/shared';
import type { InputSource } from './InputSystem';

const BINDINGS = {
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  handbrake: ['Space'],
  camera: ['KeyC'],
  reset: ['KeyR'],
  pause: ['Escape', 'KeyP'],
  tc: ['KeyT'],
  abs: ['KeyB'],
} as const;

/** Keys are digital, so axes ramp toward their target to feel like a pedal and wheel. */
const RATES = {
  steerIn: 3.2,
  steerOut: 6,
  pedalIn: 6,
  pedalOut: 10,
};

export class KeyboardInput implements InputSource {
  readonly name = 'keyboard';
  private readonly down = new Set<string>();
  /** Keys pressed since the last poll, so a tap shorter than one frame still counts. */
  private readonly tapped = new Set<string>();
  private steer = 0;
  private throttle = 0;
  private brake = 0;

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => {
      if (isBound(e.code)) e.preventDefault();
      this.down.add(e.code);
      this.tapped.add(e.code);
    });
    target.addEventListener('keyup', (e) => this.down.delete(e.code));
    // Releasing keys while the window is unfocused never fires keyup.
    target.addEventListener('blur', () => this.down.clear());
  }

  poll(dt: number): InputState | null {
    const held = (keys: readonly string[]) => keys.some((k) => this.down.has(k) || this.tapped.has(k));
    const state = this.read(held, dt);
    this.tapped.clear();
    return state;
  }

  private read(held: (keys: readonly string[]) => boolean, dt: number): InputState {
    const steerTarget = (held(BINDINGS.right) ? 1 : 0) - (held(BINDINGS.left) ? 1 : 0);
    // Steering back through centre uses the faster return rate.
    const returning = steerTarget === 0 || Math.sign(steerTarget) !== Math.sign(this.steer);
    this.steer = approach(this.steer, steerTarget, (returning ? RATES.steerOut : RATES.steerIn) * dt);
    this.throttle = ramp(this.throttle, held(BINDINGS.throttle), dt);
    this.brake = ramp(this.brake, held(BINDINGS.brake), dt);

    let buttons = 0;
    if (held(BINDINGS.camera)) buttons |= Button.Camera;
    if (held(BINDINGS.reset)) buttons |= Button.Reset;
    if (held(BINDINGS.pause)) buttons |= Button.Pause;
    if (held(BINDINGS.tc)) buttons |= Button.ToggleTractionControl;
    if (held(BINDINGS.abs)) buttons |= Button.ToggleAbs;

    return {
      steer: this.steer,
      throttle: this.throttle,
      brake: this.brake,
      handbrake: held(BINDINGS.handbrake),
      buttons,
    };
  }
}

function isBound(code: string): boolean {
  return Object.values(BINDINGS).some((keys) => (keys as readonly string[]).includes(code));
}

function ramp(value: number, pressed: boolean, dt: number): number {
  return approach(value, pressed ? 1 : 0, (pressed ? RATES.pedalIn : RATES.pedalOut) * dt);
}

function approach(value: number, target: number, maxDelta: number): number {
  if (value < target) return Math.min(value + maxDelta, target);
  return Math.max(value - maxDelta, target);
}
