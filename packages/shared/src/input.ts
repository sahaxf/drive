/**
 * The single input shape every source (keyboard, gamepad, phone) produces.
 * The game never needs to know which device a value came from.
 */
export interface InputState {
  /** -1 = full left, +1 = full right. */
  steer: number;
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  handbrake: boolean;
  /** Bitmask of {@link Button} values currently held. */
  buttons: number;
}

export const Button = {
  Camera: 1 << 0,
  Reset: 1 << 1,
  Pause: 1 << 2,
  ToggleTractionControl: 1 << 3,
  ToggleAbs: 1 << 4,
} as const;
export type Button = (typeof Button)[keyof typeof Button];

export function neutralInput(): InputState {
  return { steer: 0, throttle: 0, brake: 0, handbrake: false, buttons: 0 };
}

export function isHeld(input: InputState, button: Button): boolean {
  return (input.buttons & button) !== 0;
}
