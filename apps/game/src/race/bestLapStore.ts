import type { ReferenceLap } from './LapTimer';

/**
 * The player's best lap in each car on each track, kept in the browser with the time at
 * every point round the loop, so later laps can show how far ahead or behind they are.
 */

function key(trackId: string, carId: string): string {
  return `drivee.bestLap.${trackId}.${carId}`;
}

export function loadBestLap(
  trackId: string,
  carId: string,
  storage: Pick<Storage, 'getItem'> | null = safeStorage(),
): ReferenceLap | null {
  try {
    const saved = JSON.parse(storage?.getItem(key(trackId, carId)) ?? 'null') as Partial<ReferenceLap> | null;
    if (!saved || typeof saved.time !== 'number' || !isTimes(saved.sectors) || !isTimes(saved.times)) return null;
    return { time: saved.time, sectors: saved.sectors, times: saved.times };
  } catch {
    return null;
  }
}

export function saveBestLap(
  trackId: string,
  carId: string,
  lap: ReferenceLap,
  storage: Pick<Storage, 'setItem'> | null = safeStorage(),
): void {
  // Milliseconds are all a lap time shows, and they keep a long track's table small.
  const round = (t: number) => Math.round(t * 1000) / 1000;
  try {
    storage?.setItem(
      key(trackId, carId),
      JSON.stringify({ time: lap.time, sectors: lap.sectors.map(round), times: lap.times.map(round) }),
    );
  } catch {
    // Private mode or full storage: the lap just isn't remembered.
  }
}

function isTimes(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((t) => typeof t === 'number' && Number.isFinite(t));
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
