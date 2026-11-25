import { describe, expect, it } from 'vitest';
import { loadSettings, nextShadowQuality, saveSettings, SHADOW_MAP_SIZE, stepVolume } from '../src/settings';

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

describe('settings', () => {
  it('defaults to medium shadows when nothing or garbage is stored', () => {
    expect(loadSettings(memoryStorage()).shadows).toBe('medium');
    const broken = memoryStorage();
    broken.setItem('drivee.settings', '{not json');
    expect(loadSettings(broken).shadows).toBe('medium');
    broken.setItem('drivee.settings', '{"shadows":"ultra"}');
    expect(loadSettings(broken).shadows).toBe('medium');
  });

  it('round-trips through storage', () => {
    const storage = memoryStorage();
    saveSettings({ shadows: 'none', volume: 0.4, manualGears: true, motionBlur: false }, storage);
    expect(loadSettings(storage)).toEqual({ shadows: 'none', volume: 0.4, manualGears: true, motionBlur: false });
  });

  it('is at full volume with automatic gears unless set otherwise', () => {
    expect(loadSettings(memoryStorage())).toMatchObject({ volume: 1, manualGears: false });
    const storage = memoryStorage();
    storage.setItem('drivee.settings', '{"shadows":"low","volume":"loud","manualGears":1}');
    expect(loadSettings(storage)).toMatchObject({ volume: 1, manualGears: false });
    storage.setItem('drivee.settings', '{"volume":7}');
    expect(loadSettings(storage).volume).toBe(1);
  });

  it('has motion blur on unless turned off', () => {
    expect(loadSettings(memoryStorage()).motionBlur).toBe(true);
    const storage = memoryStorage();
    storage.setItem('drivee.settings', '{"motionBlur":"no"}');
    expect(loadSettings(storage).motionBlur).toBe(true);
  });

  it('turns the old sound switch into a volume', () => {
    const storage = memoryStorage();
    storage.setItem('drivee.settings', '{"shadows":"low","sound":false}');
    expect(loadSettings(storage).volume).toBe(0);
    storage.setItem('drivee.settings', '{"shadows":"low","sound":true}');
    expect(loadSettings(storage).volume).toBe(1);
  });

  it('steps the volume in tenths between 0 and 1', () => {
    expect(stepVolume(0.3, 1)).toBe(0.4);
    expect(stepVolume(0.1, -1)).toBe(0);
    expect(stepVolume(0, -1)).toBe(0);
    expect(stepVolume(1, 1)).toBe(1);
  });

  it('cycles none → low → medium → high → none', () => {
    expect(nextShadowQuality('none')).toBe('low');
    expect(nextShadowQuality('low')).toBe('medium');
    expect(nextShadowQuality('medium')).toBe('high');
    expect(nextShadowQuality('high')).toBe('none');
  });

  it('maps levels to shadow map sizes, none meaning off', () => {
    expect(SHADOW_MAP_SIZE).toEqual({ none: 0, low: 1024, medium: 2048, high: 4096 });
  });
});
