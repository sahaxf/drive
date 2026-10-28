// Builds public/tracks/nordschleife/track.json from real data (see ../lib.mjs).
// Downloads are cached in .cache/nordschleife/ (git-ignored).
// Usage: node tools/tracks/nordschleife/build.mjs
import {
  chainLoop,
  fetchElevations,
  fetchRaceways,
  project,
  report,
  resample,
  ROOT,
  shapeHeights,
  simplify,
  smoothLoop,
  writeTrack,
} from '../lib.mjs';

const CACHE = `${ROOT}.cache/nordschleife/`;
const OUT = `${ROOT}public/tracks/nordschleife/track.json`;

const BBOX = '50.31,6.90,50.40,7.02';
/** Raceway ways that aren't part of the 20.8 km Nordschleife lap (GP circuit, pits, links). */
const NOT_NORDSCHLEIFE = /Boxengasse|Sprintstrecke|Anbindung|GP Kurs|Müllenbach|Variante|Rallycross/;
/** Lap times are taken at T13: the loop starts with that section, the line this far into it, m. */
const FIRST_SECTION = 'T13';
const START_INTO_FIRST_SECTION = 100;
const SPACING = 12;
const LAYOUT_SIGMA = 10;
/** Wider than Spa's: much of the track runs through forest, which shows up as SRTM noise. */
const ELEVATION_SIGMA = 35;
/** Steepest gradient allowed after smoothing (the real maximum is about 17%). */
const MAX_GRADIENT = 0.2;
const BASE_HEIGHT = 20;
const MAX_SIMPLIFY_ERROR = 0.3;
/** The Karussell's concrete bowl, approximated as a banked section. */
const KARUSSELL_BANKING = 15;
const BANKING_RAMP = 25;

const osm = await fetchRaceways(CACHE, BBOX);
const { loop, sections } = chainLoop(osm, FIRST_SECTION, NOT_NORDSCHLEIFE);
const projected = project(loop);
const { length, cumulative } = projected;
if (length < 20_600 || length > 21_000) throw new Error(`Unexpected loop length ${length.toFixed(0)} m`);

const { samples, step } = resample(projected, SPACING);
const xs = smoothLoop(samples.map((s) => s.x), LAYOUT_SIGMA, step);
const zs = smoothLoop(samples.map((s) => s.z), LAYOUT_SIGMA, step);
const elevations = await fetchElevations(CACHE, samples);
const heights = shapeHeights(elevations, { sigma: ELEVATION_SIGMA, maxGradient: MAX_GRADIENT, baseHeight: BASE_HEIGHT }, step);

// Karussell banking: full over the section, ramped in and out, tilted into the turn.
const karussell = sections.findIndex((s) => s.name === 'Karussell');
if (karussell < 0) throw new Error('Karussell not found');
const bankFrom = Math.round(cumulative[sections[karussell].from] / step);
const bankTo = Math.round(cumulative[sections[karussell + 1].from] / step);
const ramp = Math.round(BANKING_RAMP / step);
// Signed turn: with x = east and z = south, a right-hander turns the heading clockwise
// (negative y of the cross product); positive banking suits a right-hander.
let turn = 0;
for (let k = bankFrom; k < bankTo; k++) {
  const ax = xs[k + 1] - xs[k];
  const az = zs[k + 1] - zs[k];
  const bx = xs[k + 2] - xs[k + 1];
  const bz = zs[k + 2] - zs[k + 1];
  turn += Math.atan2(az * bx - ax * bz, ax * bx + az * bz);
}
const bankSign = turn < 0 ? 1 : -1;
const bankingAt = (k) => {
  const into = Math.min(k - (bankFrom - ramp), bankTo + ramp - k);
  return bankSign * KARUSSELL_BANKING * Math.min(Math.max(into / ramp, 0), 1);
};

const round = (v) => Math.round(v * 10) / 10;
const full = xs.map((x, k) => [round(x), round(heights[k]), round(zs[k])]);
// Keep the banking ramp's corners so simplification can't stretch the ramp.
const { kept, maxError } = simplify(full, MAX_SIMPLIFY_ERROR, [bankFrom - ramp, bankFrom, bankTo, bankTo + ramp]);
const points = kept.map((i) => {
  const banking = Math.round(bankingAt(i) * 10) / 10;
  return banking === 0 ? { p: full[i] } : { p: full[i], banking };
});
const startDistance = START_INTO_FIRST_SECTION;

writeTrack(OUT, {
  meta: {
    id: 'nordschleife',
    name: 'Nürburgring Nordschleife',
    author: 'Drivee track builder',
    version: 1,
    credits: 'Layout © OpenStreetMap contributors (ODbL) · Elevation SRTM via OpenTopoData',
  },
  // The real track is 7-12 m wide; a little extra width is kinder to phone steering.
  centreline: { width: 10, points },
  roadside: { vergeWidth: 5, barrierHeight: 0.75, kerbRadius: 160, kerbWidth: 1.2 },
  race: { startDistance },
  terrain: {
    seed: 1927,
    // Coarser than Spa's 5 m: the track's bounding box is about ten times larger.
    resolution: 8,
    margin: 350,
    corridorInner: 4,
    corridorOuter: 70,
    roadDrop: 0.25,
    hillHeight: 30,
    hillScale: 700,
    mountains: { startOffset: 200, outerRadius: 9000, peakHeight: 500 },
  },
  forest: { seed: 21, density: 28, clearance: 6, meadowAmount: 0.9, broadleaf: 0.35 },
  environment: { fogNear: 400, fogFar: 6500 },
});

report({ length, points, full, maxError, startDistance, heights, elevations, step, sections, cumulative, out: OUT });
console.log(`Karussell banking ${bankSign * KARUSSELL_BANKING}° from ${Math.round(bankFrom * step)} to ${Math.round(bankTo * step)} m`);
