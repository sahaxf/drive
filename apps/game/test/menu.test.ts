import { describe, expect, it } from 'vitest';
import { neutralInput } from '@drivee/shared';
import { MenuModel, MenuNav, type MenuItem } from '../src/ui/menu';

function menu() {
  const log: string[] = [];
  let volume = 5;
  const items: MenuItem[] = [
    { id: 'resume', label: 'Resume', activate: () => log.push('resume') },
    { id: 'volume', label: 'Volume', key: 'KeyV', value: () => String(volume), adjust: (d) => (volume += d) },
    { id: 'quit', label: 'Quit', key: 'KeyQ', activate: () => log.push('quit') },
  ];
  return { model: new MenuModel(items), log, volume: () => volume };
}

describe('MenuModel', () => {
  it('moves the selection and wraps at both ends', () => {
    const { model } = menu();
    model.move(-1);
    expect(model.selected).toBe(2);
    model.move(1);
    expect(model.selected).toBe(0);
    model.move(1);
    expect(model.selected).toBe(1);
  });

  it('chooses actions, and steps a setting forward when it is chosen', () => {
    const { model, log, volume } = menu();
    model.activate();
    expect(log).toEqual(['resume']);
    model.move(1);
    model.activate();
    expect(volume()).toBe(6);
  });

  it('steps settings both ways and leaves actions alone', () => {
    const { model, log, volume } = menu();
    model.adjust(1);
    expect(log).toEqual([]);
    model.select(1);
    model.adjust(-1);
    model.adjust(-1);
    expect(volume()).toBe(3);
  });

  it('chooses a row by its shortcut and selects it', () => {
    const { model, log } = menu();
    expect(model.shortcut('KeyQ')).toBe(true);
    expect(log).toEqual(['quit']);
    expect(model.selected).toBe(2);
    expect(model.shortcut('KeyZ')).toBe(false);
  });
});

describe('MenuNav', () => {
  const input = (over: Partial<ReturnType<typeof neutralInput>>) => ({ ...neutralInput(), ...over });

  it('turns the driving controls into one action per push', () => {
    const nav = new MenuNav();
    expect(nav.update(input({ throttle: 0.9 }))).toEqual(['up']);
    // Still held: nothing more.
    expect(nav.update(input({ throttle: 1 }))).toEqual([]);
    expect(nav.update(input({}))).toEqual([]);
    expect(nav.update(input({ brake: 0.8 }))).toEqual(['down']);
    expect(nav.update(input({ steer: -0.7 }))).toEqual(['left']);
    expect(nav.update(input({ steer: 0.7 }))).toEqual(['right']);
    expect(nav.update(input({ handbrake: true }))).toEqual(['select']);
  });

  it('needs the control eased well off before it counts again', () => {
    const nav = new MenuNav();
    expect(nav.update(input({ steer: 0.6 }))).toEqual(['right']);
    // A phone wobbling around the threshold is one push, not many.
    expect(nav.update(input({ steer: 0.45 }))).toEqual([]);
    expect(nav.update(input({ steer: 0.6 }))).toEqual([]);
    expect(nav.update(input({ steer: 0.1 }))).toEqual([]);
    expect(nav.update(input({ steer: 0.6 }))).toEqual(['right']);
  });

  it('ignores whatever is held as the menu opens', () => {
    const nav = new MenuNav();
    nav.prime(input({ throttle: 1, steer: 0.8 }));
    expect(nav.update(input({ throttle: 1, steer: 0.8 }))).toEqual([]);
    expect(nav.update(input({}))).toEqual([]);
    expect(nav.update(input({ throttle: 1 }))).toEqual(['up']);
  });
});
