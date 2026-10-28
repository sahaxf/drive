import { describe, expect, it } from 'vitest';
import { loadSettings, nextShadowQuality, saveSettings, SHADOW_MAP_SIZE } from '../src/settings';

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
    saveSettings({ shadows: 'none' }, storage);
    expect(loadSettings(storage).shadows).toBe('none');
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
