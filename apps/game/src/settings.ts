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
  /** Master volume, 0 (muted) to 1. */
  volume: number;
  /** Shift gears by hand instead of leaving it to the automatic gearbox. */
  manualGears: boolean;
}

const KEY = 'drivee.settings';
const DEFAULTS: Settings = { shadows: 'medium', volume: 1, manualGears: false };
const VOLUME_STEP = 0.1;

export function loadSettings(storage: Pick<Storage, 'getItem'> | null = safeStorage()): Settings {
  try {
    // `sound` is the on/off switch older versions saved instead of a volume.
    const saved = JSON.parse(storage?.getItem(KEY) ?? 'null') as (Partial<Settings> & { sound?: unknown }) | null;
    const shadows = SHADOW_QUALITIES.includes(saved?.shadows as ShadowQuality) ? saved!.shadows! : DEFAULTS.shadows;
    const volume =
      typeof saved?.volume === 'number' && Number.isFinite(saved.volume)
        ? Math.min(Math.max(saved.volume, 0), 1)
        : saved?.sound === false
          ? 0
          : DEFAULTS.volume;
    const manualGears = typeof saved?.manualGears === 'boolean' ? saved.manualGears : DEFAULTS.manualGears;
    return { shadows, volume, manualGears };
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

/** One step up or down the volume slider, kept to 0..1 and free of rounding drift. */
export function stepVolume(volume: number, direction: -1 | 1): number {
  return Math.min(Math.max(Math.round((volume + direction * VOLUME_STEP) * 10) / 10, 0), 1);
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
