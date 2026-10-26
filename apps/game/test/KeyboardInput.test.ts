import { describe, expect, it } from 'vitest';
import { Button } from '@drivee/shared';
import { KeyboardInput } from '../src/input/KeyboardInput';

function fakeWindow() {
  const handlers = new Map<string, (e: unknown) => void>();
  const target = {
    addEventListener: (type: string, fn: (e: unknown) => void) => handlers.set(type, fn),
  } as unknown as Window;
  const key = (type: 'keydown' | 'keyup', code: string) => handlers.get(type)?.({ code, preventDefault() {} });
  return { target, key };
}

describe('KeyboardInput', () => {
  it('ramps steering instead of snapping', () => {
    const { target, key } = fakeWindow();
    const kb = new KeyboardInput(target);
    key('keydown', 'KeyD');
    const first = kb.poll(1 / 60)!.steer;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(0.2);
    for (let k = 0; k < 60; k++) kb.poll(1 / 60);
    expect(kb.poll(1 / 60)!.steer).toBe(1);
  });

  it('registers a tap that starts and ends between two polls', () => {
    const { target, key } = fakeWindow();
    const kb = new KeyboardInput(target);
    key('keydown', 'KeyC');
    key('keyup', 'KeyC');
    expect(kb.poll(1 / 60)!.buttons & Button.Camera).toBeTruthy();
    expect(kb.poll(1 / 60)!.buttons & Button.Camera).toBeFalsy();
  });
});
