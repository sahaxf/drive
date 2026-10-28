// Shared steps for building real circuits from open data:
//   layout    — OpenStreetMap raceway ways (© OpenStreetMap contributors, ODbL)
//   elevation — SRTM 30 m via the OpenTopoData public API
// Each circuit's build.mjs holds its own settings and calls these in order.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const USER_AGENT = 'drivee-track-builder/0.1 (personal racing game; one-off build)';
const M_PER_DEG_LAT = 111_320;

/** Read `name` from the cache folder, or fetch and store it. */
export async function cached(dir, name, fetcher) {
  mkdirSync(dir, { recursive: true });
  const path = dir + name;
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  const data = await fetcher();
  writeFileSync(path, JSON.stringify(data));
  return data;
}

// --- Layout ---------------------------------------------------------------------------------

/** All `highway=raceway` ways in a bounding box ("south,west,north,east"), with geometry. */
export function fetchRaceways(cacheDir, bbox) {
  return cached(cacheDir, 'osm.json', async () => {
    const query = `[out:json][timeout:60];(way["highway"="raceway"](${bbox}););out geom tags;`;
    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
    });
    if (!response.ok) throw new Error(`Overpass: ${response.status}`);
    return response.json();
  });
}

/**
 * Chain one-way raceway ways into a closed loop, starting with the way named `firstName`.
 * At each junction the first unused way starting there is taken; `exclude` (matched on the
 * way name) drops pit lanes and other layouts. Returns the loop's nodes (not closed) and
 * where each way starts in it.
 */
export function chainLoop(osm, firstName, exclude) {
  const ways = osm.elements.filter((w) => w.tags.oneway === 'yes' && !exclude.test(w.tags.name ?? ''));
  const nodeKey = (p) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;
  const byStart = new Map();
  for (const w of ways) {
    const key = nodeKey(w.geometry[0]);
    if (!byStart.has(key)) byStart.set(key, []);
    byStart.get(key).push(w);
  }

  const first = ways.find((w) => w.tags.name === firstName);
  if (!first) throw new Error(`${firstName} not found in OSM data`);
  const loop = [];
  const sections = [];
  const used = new Set();
  for (let way = first; ; ) {
    used.add(way.id);
    sections.push({ name: way.tags.name ?? null, from: loop.length });
    // Skip each way's first node after the first way: it repeats the previous way's last node.
    loop.push(...(loop.length === 0 ? way.geometry : way.geometry.slice(1)));
    const next = byStart.get(nodeKey(way.geometry[way.geometry.length - 1])) ?? [];
    const candidate = next.find((w) => !used.has(w.id)) ?? next.find((w) => w.id === first.id);
    if (!candidate) throw new Error(`Loop broken after way ${way.id}`);
    if (candidate.id === first.id) break;
    way = candidate;
  }
  loop.pop(); // last node == first node
  return { loop, sections };
}

/**
 * Project to local metres around the centroid (x = east, z = south: a rotation, not a
 * mirror) and measure the loop. `cumulative[i]` is the distance to node i; the last entry
 * is the full length.
 */
export function project(loop) {
  const lat0 = loop.reduce((s, p) => s + p.lat, 0) / loop.length;
  const lon0 = loop.reduce((s, p) => s + p.lon, 0) / loop.length;
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  const raw = loop.map((p) => ({ x: (p.lon - lon0) * mPerDegLon, z: -(p.lat - lat0) * M_PER_DEG_LAT, lat: p.lat, lon: p.lon }));
  const cumulative = [0];
  for (let i = 1; i <= raw.length; i++) {
    const a = raw[i - 1];
    const b = raw[i % raw.length];
    cumulative.push(cumulative[i - 1] + Math.hypot(b.x - a.x, b.z - a.z));
  }
  return { raw, cumulative, length: cumulative[raw.length] };
}

/** Evenly spaced samples around the loop, about `spacing` apart. */
export function resample({ raw, cumulative, length }, spacing) {
  const count = Math.round(length / spacing);
  const step = length / count;
  const pointAt = (d) => {
    let i = 0;
    while (cumulative[i + 1] < d) i++;
    const a = raw[i];
    const b = raw[(i + 1) % raw.length];
    const t = (d - cumulative[i]) / (cumulative[i + 1] - cumulative[i] || 1);
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
  };
  return { samples: Array.from({ length: count }, (_, k) => pointAt(k * step)), step };
}

/** Gaussian smoothing around a closed loop of evenly spaced values. */
export function smoothLoop(values, sigma, step) {
  const radius = Math.ceil((sigma * 2.5) / step);
  const weights = Array.from({ length: radius * 2 + 1 }, (_, j) => Math.exp(-(((j - radius) * step) ** 2) / (2 * sigma * sigma)));
  const total = weights.reduce((a, b) => a + b, 0);
  return values.map((_, k) => {
    let sum = 0;
    for (let j = -radius; j <= radius; j++) sum += values[(k + j + values.length) % values.length] * weights[j + radius];
    return sum / total;
  });
}

// --- Elevation ------------------------------------------------------------------------------

/** SRTM elevation at each sample, 100 per request at the public API's 1 request per second. */
export async function fetchElevations(cacheDir, samples) {
  const elevations = await cached(cacheDir, 'elevation.json', async () => {
    const out = [];
    for (let i = 0; i < samples.length; i += 100) {
      const batch = samples.slice(i, i + 100);
      const locations = batch.map((s) => `${s.lat.toFixed(6)},${s.lon.toFixed(6)}`).join('|');
      const response = await fetch(`https://api.opentopodata.org/v1/srtm30m?locations=${locations}`, {
        headers: { 'User-Agent': USER_AGENT },
      });
      if (!response.ok) throw new Error(`OpenTopoData: ${response.status}`);
      const data = await response.json();
      out.push(...data.results.map((r) => r.elevation));
      process.stdout.write(`elevation ${out.length}/${samples.length}\r`);
      await new Promise((r) => setTimeout(r, 1100));
    }
    console.log();
    return out;
  });
  if (elevations.length !== samples.length) throw new Error(`Elevation cache does not match the samples; delete ${cacheDir}elevation.json`);
  return elevations;
}

/**
 * Smooth the raw elevations, cap the gradient (forwards then backwards so the correction is
 * symmetric) and shift so the lowest point sits at `baseHeight`.
 */
export function shapeHeights(elevations, { sigma, maxGradient, baseHeight }, step) {
  let heights = smoothLoop(elevations, sigma, step);
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 1; k <= heights.length; k++) {
      const i = (pass === 0 ? k : heights.length - k) % heights.length;
      const j = (pass === 0 ? i - 1 + heights.length : i + 1) % heights.length;
      const limit = maxGradient * step;
      heights[i] = Math.min(Math.max(heights[i], heights[j] - limit), heights[j] + limit);
    }
  }
  const lowest = Math.min(...heights);
  return heights.map((h) => h - lowest + baseHeight);
}

// --- Output ---------------------------------------------------------------------------------

/** Write the track with one control point per line: compact, readable and diff-friendly. */
export function writeTrack(path, track) {
  mkdirSync(dirname(path), { recursive: true });
  const json = JSON.stringify(track, null, 2).replace(
    /\{\s*"p": \[\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\]((?:,\s*"\w+": -?[\d.]+)*)\s*\}/g,
    (_, x, y, z, rest) => `{ "p": [${x}, ${y}, ${z}]${rest.replace(/\s+/g, ' ')} }`,
  );
  writeFileSync(path, `${json}\n`);
}

/** Section heights, elevation range and steepest gradient, to check against the real circuit. */
export function report({ length, points, full, maxError, startDistance, heights, elevations, step, sections, cumulative, out }) {
  console.log(
    `Loop ${length.toFixed(0)} m, ${points.length} control points (from ${full.length}, max deviation ${maxError.toFixed(2)} m), start/finish at ${startDistance} m`,
  );
  console.log(`Elevation range ${(Math.max(...heights) - Math.min(...heights)).toFixed(0)} m (raw SRTM ${(Math.max(...elevations) - Math.min(...elevations)).toFixed(0)} m)`);
  const heightAt = (d) => heights[Math.round(d / step) % heights.length];
  for (const s of sections.filter((s) => s.name)) {
    const distance = cumulative[s.from];
    console.log(`  ${s.name.padEnd(22)} ${String(Math.round(distance)).padStart(5)} m  height ${heightAt(distance).toFixed(0).padStart(4)} m`);
  }
  let steepest = 0;
  for (let k = 0; k < heights.length; k++) steepest = Math.max(steepest, Math.abs(heights[(k + 1) % heights.length] - heights[k]) / step);
  console.log(`Steepest gradient ${(steepest * 100).toFixed(1)}%`);
  console.log(`Wrote ${out}`);
}

// --- Curve maths (mirrors densify() in apps/game/src/track/TrackSpline.ts) -----------------

export function densify(control) {
  const DENSE_STEPS = 48;
  const n = control.length;
  const segments = [];
  let length = 0;
  let previous = null;
  for (let i = 0; i < n; i++) {
    const p0 = control[(i - 1 + n) % n];
    const p1 = control[i];
    const p2 = control[(i + 1) % n];
    const p3 = control[(i + 2) % n];
    // Centripetal Catmull-Rom.
    const t1 = Math.sqrt(dist(p0, p1));
    const t2 = t1 + Math.sqrt(dist(p1, p2));
    const t3 = t2 + Math.sqrt(dist(p2, p3));
    const samples = [];
    for (let s = 0; s < DENSE_STEPS; s++) {
      const t = t1 + (t2 - t1) * (s / DENSE_STEPS);
      const a1 = mix(p0, p1, 0, t1, t);
      const a2 = mix(p1, p2, t1, t2, t);
      const a3 = mix(p2, p3, t2, t3, t);
      const point = mix(mix(a1, a2, 0, t2, t), mix(a2, a3, t1, t3, t), t1, t2, t);
      if (previous) length += dist(previous, point);
      previous = point;
      samples.push(point);
    }
    segments.push(samples);
  }
  length += dist(previous, segments[0][0]);
  return { segments, length };
}

/**
 * Keep the fewest control points whose curve stays within `tolerance` of the full curve.
 * Starts from every 10th point (plus any in `required`) and repeatedly adds back the
 * original point where the error is worst. Each full-curve sample is only compared with
 * the span of the simplified curve that covers it, which keeps this fast.
 */
export function simplify(points, tolerance, required = []) {
  const reference = densify(points).segments;
  const keep = new Set([...points.map((_, i) => i).filter((i) => i % 10 === 0), ...required]);
  for (;;) {
    const kept = [...keep].sort((a, b) => a - b);
    const curve = densify(kept.map((i) => points[i])).segments;
    let worst = { error: 0, index: -1 };
    kept.forEach((a, k) => {
      const b = k + 1 < kept.length ? kept[k + 1] : kept[0] + points.length;
      // The span from kept point a to the next kept point, including its end point.
      const span = [...curve[k], curve[(k + 1) % curve.length][0]];
      for (let i = a; i < b; i++) {
        for (const sample of reference[i % points.length]) {
          let best = Infinity;
          for (const c of span) best = Math.min(best, dist(sample, c));
          if (best > worst.error) worst = { error: best, index: i % points.length };
        }
      }
    });
    if (worst.error <= tolerance) return { kept, maxError: worst.error };
    let add = worst.index;
    while (keep.has(add)) add = (add + 1) % points.length;
    keep.add(add);
  }
}

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function mix(a, b, ta, tb, t) {
  const span = tb - ta;
  if (span === 0) return a;
  const u = (t - ta) / span;
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}
