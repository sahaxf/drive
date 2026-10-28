// Builds public/tracks/spa-replica/track.json from real data (see ../lib.mjs).
// Downloads are cached in .cache/spa/ (git-ignored). Usage: node tools/tracks/spa/build.mjs
import {
  chainLoop,
  densify,
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

const CACHE = `${ROOT}.cache/spa/`;
const OUT = `${ROOT}public/tracks/spa-replica/track.json`;

const BBOX = '50.420,5.950,50.450,5.995';
/** Raceway ways that aren't part of the Grand Prix loop. */
const NOT_GP = /^(Kart|Pit Lane|Support Pit Lane|Moto layout)$/;
/** Control point spacing along the track, m. Dense enough to keep the La Source hairpin. */
const SPACING = 12;
/** Smoothing of the layout (removes kinks at OSM nodes) and of the elevation (SRTM noise), m. */
const LAYOUT_SIGMA = 10;
const ELEVATION_SIGMA = 28;
/** Steepest gradient allowed after smoothing (Raidillon is about 17-18%). */
const MAX_GRADIENT = 0.2;
/** The lowest point of the track sits this high in game coordinates, m. */
const BASE_HEIGHT = 20;
/**
 * Control points are thinned until the curve the game draws through them strays at most
 * this far (3D, m) from the full-detail curve: dense in corners, sparse on straights.
 */
const MAX_SIMPLIFY_ERROR = 0.3;
/** Start/finish line: on the straight before La Source, this far before its turn-in, m. */
const START_BEFORE_LA_SOURCE = 230;

const osm = await fetchRaceways(CACHE, BBOX);
const { loop, sections } = chainLoop(osm, 'La Source', NOT_GP);
const projected = project(loop);
const { length, cumulative } = projected;
if (length < 6900 || length > 7100) throw new Error(`Unexpected loop length ${length.toFixed(0)} m`);

const { samples, step } = resample(projected, SPACING);
const xs = smoothLoop(samples.map((s) => s.x), LAYOUT_SIGMA, step);
const zs = smoothLoop(samples.map((s) => s.z), LAYOUT_SIGMA, step);
const elevations = await fetchElevations(CACHE, samples);
const heights = shapeHeights(elevations, { sigma: ELEVATION_SIGMA, maxGradient: MAX_GRADIENT, baseHeight: BASE_HEIGHT }, step);

const round = (v) => Math.round(v * 10) / 10;
const full = xs.map((x, k) => [round(x), round(heights[k]), round(zs[k])]);
const { kept, maxError } = simplify(full, MAX_SIMPLIFY_ERROR);
const points = kept.map((i) => ({ p: full[i] }));
const startDistance = Math.round(densify(points.map((c) => c.p)).length - START_BEFORE_LA_SOURCE);

writeTrack(OUT, {
  meta: {
    id: 'spa-replica',
    name: 'Spa-Francorchamps (Replica)',
    author: 'Drivee track builder',
    version: 1,
    credits: 'Layout © OpenStreetMap contributors (ODbL) · Elevation SRTM via OpenTopoData',
  },
  centreline: { width: 12, points },
  roadside: { vergeWidth: 6, barrierHeight: 0.75, kerbRadius: 160, kerbWidth: 1.2 },
  race: { startDistance },
  terrain: {
    seed: 1924,
    resolution: 5,
    margin: 450,
    corridorInner: 3,
    corridorOuter: 70,
    roadDrop: 0.25,
    hillHeight: 30,
    hillScale: 600,
    mountains: { startOffset: 200, outerRadius: 9000, peakHeight: 450 },
  },
  forest: { seed: 77, density: 120, clearance: 6, meadowAmount: 0.85, broadleaf: 0.3 },
  environment: { fogNear: 350, fogFar: 6000 },
});

report({ length, points, full, maxError, startDistance, heights, elevations, step, sections, cumulative, out: OUT });
