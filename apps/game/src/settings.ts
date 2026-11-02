/** Player settings, kept in the browser. */

export const SHADOW_QUALITIES = ['none', 'low', 'medium', 'high'] as const;
export type ShadowQuality = (typeof SHADOW_QUALITIES)[number];

/**
 * Shadow map size per level (0 = shadows off). The map covers ~90 m around the car:
 * 2048 is ~4 cm per texel; 4096 cost 2-3x the frame rate on an Intel Iris Xe.
 */
export const SHADOW_MAP_SIZE: Record<ShadowQuality, number> = {
  none: 0,
  low: 1024,
  medium: 2048,
  high: 4096,
};

export interface Settings {
  shadows: ShadowQuality;
  sound: boolean;
}

const KEY = 'drivee.settings';
const DEFAULTS: Settings = { shadows: 'medium', sound: true };

export function loadSettings(storage: Pick<Storage, 'getItem'> | null = safeStorage()): Settings {
  try {
    const saved = JSON.parse(storage?.getItem(KEY) ?? 'null') as Partial<Settings> | null;
    const shadows = SHADOW_QUALITIES.includes(saved?.shadows as ShadowQuality) ? saved!.shadows! : DEFAULTS.shadows;
    const sound = typeof saved?.sound === 'boolean' ? saved.sound : DEFAULTS.sound;
    return { shadows, sound };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: Settings, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Private mode: settings just don't persist.
  }
}

export function nextShadowQuality(current: ShadowQuality): ShadowQuality {
  return SHADOW_QUALITIES[(SHADOW_QUALITIES.indexOf(current) + 1) % SHADOW_QUALITIES.length]!;
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
