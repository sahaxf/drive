import type { InputState } from '@drivee/shared';

/** One row of a menu: something to do, or a setting to change. */
export interface MenuItem {
  id: string;
  label: string;
  /** Current value of a setting, shown beside the label. */
  value?: () => string;
  /** Chosen (Enter, click, handbrake). A setting without one steps forward instead. */
  activate?: () => void;
  /** Stepped down (−1) or up (+1), for settings. */
  adjust?: (direction: -1 | 1) => void;
  /** Keyboard shortcut (a `KeyboardEvent.code`) that chooses this row from anywhere in the menu. */
  key?: string;
}

/** Which row of a menu is selected, and what choosing or changing it does. No DOM. */
export class MenuModel {
  selected = 0;

  constructor(readonly items: readonly MenuItem[]) {}

  /** Move the selection up (−1) or down (+1), wrapping at the ends. */
  move(direction: -1 | 1): void {
    this.selected = (this.selected + direction + this.items.length) % this.items.length;
  }

  select(index: number): void {
    if (index >= 0 && index < this.items.length) this.selected = index;
  }

  activate(index = this.selected): void {
    const item = this.items[index];
    if (!item) return;
    this.selected = index;
    if (item.activate) item.activate();
    else item.adjust?.(1);
  }

  adjust(direction: -1 | 1): void {
    this.items[this.selected]?.adjust?.(direction);
  }

  /** Choose the row with this shortcut. False if there is none. */
  shortcut(code: string): boolean {
    const index = this.items.findIndex((item) => item.key === code);
    if (index < 0) return false;
    this.activate(index);
    return true;
  }
}

export type MenuAction = 'up' | 'down' | 'left' | 'right' | 'select';

/** An axis counts as pushed past this, and as let go again below the lower one. */
const PRESS = 0.5;
const RELEASE = 0.3;

/**
 * Drives a menu from the driving controls, so it works the same from the keyboard, a
 * gamepad and the phone: throttle is up, brake is down, steering changes a setting and
 * the handbrake chooses. Each push counts once, however long it is held.
 */
export class MenuNav {
  private readonly held = new Set<MenuAction>();

  /** Actions that began with this input. */
  update(input: InputState): MenuAction[] {
    const levels: Record<MenuAction, number> = {
      up: input.throttle,
      down: input.brake,
      left: -input.steer,
      right: input.steer,
      select: input.handbrake ? 1 : 0,
    };
    const actions: MenuAction[] = [];
    for (const action of Object.keys(levels) as MenuAction[]) {
      const level = levels[action];
      if (this.held.has(action)) {
        if (level < RELEASE) this.held.delete(action);
      } else if (level > PRESS) {
        this.held.add(action);
        actions.push(action);
      }
    }
    return actions;
  }

  /** Take the controls as they are now for already held, so opening the menu mid-corner does nothing. */
  prime(input: InputState): void {
    this.held.clear();
    this.update(input);
  }
}
