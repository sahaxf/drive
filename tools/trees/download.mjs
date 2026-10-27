// Downloads the Poly Haven tree scans the bake uses into .cache/polyhaven/ (git-ignored).
// Usage: node tools/trees/download.mjs
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { TREES } from './trees.config.mjs';

const ROOT = new URL('../../.cache/polyhaven/', import.meta.url);
const RESOLUTION = '2k';

const assets = [...new Set(TREES.map((t) => t.asset))];
for (const asset of assets) {
  const files = await (await fetch(`https://api.polyhaven.com/files/${asset}`)).json();
  const gltf = files.gltf[RESOLUTION].gltf;
  const all = [[`${asset}.gltf`, gltf.url, gltf.size], ...Object.entries(gltf.include).map(([path, f]) => [path, f.url, f.size])];
  for (const [path, url, size] of all) {
    const target = new URL(path, ROOT);
    if (existsSync(target) && statSync(target).size === size) continue;
    mkdirSync(dirname(target.pathname.replace(/^\/([A-Za-z]:)/, '$1')), { recursive: true });
    process.stdout.write(`${asset}: ${path} (${(size / 1e6).toFixed(1)} MB)… `);
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error(`${url}: ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
    console.log('done');
  }
}
console.log(`All scans in ${join(ROOT.pathname)}`);
