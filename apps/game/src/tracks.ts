import { parseCarSpec, parseTrackSpec, type CarSpec, type TrackSpec } from '@drivee/shared';

/** Tracks are folders under public/tracks/, listed in public/tracks/index.json. */
export async function loadTrackIndex(): Promise<string[]> {
  const index = (await loadJson('/tracks/index.json', 'track list')) as { tracks?: unknown };
  if (!Array.isArray(index.tracks) || !index.tracks.every((t) => typeof t === 'string')) {
    throw new Error('tracks/index.json must contain { "tracks": ["id", ...] }');
  }
  return index.tracks;
}

export async function loadTrackSpec(id: string): Promise<TrackSpec> {
  return parseTrackSpec(await loadJson(`/tracks/${id}/track.json`, `track "${id}"`));
}

export async function loadCarSpec(id: string): Promise<CarSpec> {
  return parseCarSpec(await loadJson(`/cars/${id}/car.json`, `car "${id}"`));
}

export function bestLapKey(trackId: string): string {
  return `drivee.bestLap.${trackId}`;
}

export function loadBestLap(trackId: string): number | null {
  try {
    const value = Number(localStorage.getItem(bestLapKey(trackId)));
    return value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function saveBestLap(trackId: string, seconds: number): void {
  try {
    localStorage.setItem(bestLapKey(trackId), String(seconds));
  } catch {
    // Private mode: the best lap just isn't remembered.
  }
}

/** Summary numbers for a track, from its control points (no generation needed). */
export function trackStats(spec: TrackSpec): { length: number; elevationRange: number } {
  const points = spec.centreline.points;
  let length = 0;
  let low = Infinity;
  let high = -Infinity;
  points.forEach(({ p }, i) => {
    const q = points[(i + 1) % points.length]!.p;
    length += Math.hypot(q[0] - p[0], q[2] - p[2]);
    low = Math.min(low, p[1]);
    high = Math.max(high, p[1]);
  });
  return { length, elevationRange: high - low };
}

async function loadJson(url: string, what: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${what} (${response.status})`);
  return response.json();
}
