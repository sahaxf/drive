import { parseCarSpec, parseTrackSpec, type CarSpec, type TrackSpec } from '@drivee/shared';

/** Tracks are folders under public/tracks/, listed in public/tracks/index.json. */
export async function loadTrackIndex(): Promise<string[]> {
  return loadIndex('tracks');
}

/** Cars are folders under public/cars/, listed in public/cars/index.json. */
export async function loadCarIndex(): Promise<string[]> {
  return loadIndex('cars');
}

async function loadIndex(kind: 'tracks' | 'cars'): Promise<string[]> {
  const index = (await loadJson(`/${kind}/index.json`, `${kind.slice(0, -1)} list`)) as Record<string, unknown>;
  const ids = index[kind];
  if (!Array.isArray(ids) || !ids.every((t) => typeof t === 'string')) {
    throw new Error(`${kind}/index.json must contain { "${kind}": ["id", ...] }`);
  }
  return ids;
}

export async function loadTrackSpec(id: string): Promise<TrackSpec> {
  return parseTrackSpec(await loadJson(`/tracks/${id}/track.json`, `track "${id}"`));
}

export async function loadCarSpec(id: string): Promise<CarSpec> {
  return parseCarSpec(await loadJson(`/cars/${id}/car.json`, `car "${id}"`));
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
