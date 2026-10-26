import { Button, neutralInput, type InputState } from '@drivee/shared';

/** Anything that can produce an InputState: keyboard, gamepad, and (M2) the phone. */
export interface InputSource {
  readonly name: string;
  /** Latest state, or null when the device is not connected / idle. */
  poll(dt: number): InputState | null;
}

/**
 * Merges every source into one InputState and tracks button edges, so the game
 * can ask "was Camera pressed this frame?" without caring which device did it.
 */
export class InputSystem {
  private state: InputState = neutralInput();
  private previousButtons = 0;
  activeSource = 'none';

  constructor(private readonly sources: InputSource[]) {}

  update(dt: number): InputState {
    const merged = neutralInput();
    let strongest = 0;
    this.activeSource = 'none';
    for (const source of this.sources) {
      const s = source.poll(dt);
      if (!s) continue;
      // Analog axes: the source pushing hardest wins, so devices don't fight.
      const magnitude = Math.abs(s.steer) + s.throttle + s.brake;
      if (magnitude > strongest) {
        strongest = magnitude;
        merged.steer = s.steer;
        merged.throttle = s.throttle;
        merged.brake = s.brake;
        this.activeSource = source.name;
      }
      merged.handbrake ||= s.handbrake;
      merged.buttons |= s.buttons;
    }
    this.previousButtons = this.state.buttons;
    this.state = merged;
    return merged;
  }

  get current(): InputState {
    return this.state;
  }

  /** True only on the frame the button went down. */
  pressed(button: Button): boolean {
    return (this.state.buttons & button) !== 0 && (this.previousButtons & button) === 0;
  }
}

export { Button };
