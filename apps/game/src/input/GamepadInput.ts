import { Button, type InputState } from '@drivee/shared';
import type { InputSource } from './InputSystem';

// Standard Gamepad API mapping (Xbox / PlayStation layouts).
const AXIS_LEFT_X = 0;
const BTN_A = 0;
const BTN_B = 1;
const BTN_Y = 3;
const BTN_LT = 6;
const BTN_RT = 7;
const BTN_START = 9;
const BTN_DPAD_LEFT = 14;
const BTN_DPAD_RIGHT = 15;

const STICK_DEADZONE = 0.08;

export class GamepadInput implements InputSource {
  readonly name = 'gamepad';

  poll(): InputState | null {
    const pad = navigator.getGamepads?.().find((p) => p?.connected && p.mapping === 'standard');
    if (!pad) return null;

    const value = (i: number) => pad.buttons[i]?.value ?? 0;
    const pressed = (i: number) => pad.buttons[i]?.pressed ?? false;
    const rawX = pad.axes[AXIS_LEFT_X] ?? 0;
    const steer =
      Math.abs(rawX) < STICK_DEADZONE ? 0 : Math.sign(rawX) * ((Math.abs(rawX) - STICK_DEADZONE) / (1 - STICK_DEADZONE));

    let buttons = 0;
    if (pressed(BTN_Y)) buttons |= Button.Camera;
    if (pressed(BTN_B)) buttons |= Button.Reset;
    if (pressed(BTN_START)) buttons |= Button.Pause;
    if (pressed(BTN_DPAD_LEFT)) buttons |= Button.ToggleTractionControl;
    if (pressed(BTN_DPAD_RIGHT)) buttons |= Button.ToggleAbs;

    return {
      steer,
      throttle: value(BTN_RT),
      brake: value(BTN_LT),
      handbrake: pressed(BTN_A),
      buttons,
    };
  }
}
