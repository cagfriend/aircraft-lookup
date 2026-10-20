import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {OVERVIEW_URL, DETAIL_URL} from '../public/offline-map/data/catalog.js';
import {SpatialIndex} from '../public/offline-map/spatial-index.js';

const root = new URL('../public/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('offline-map/data/manifest.json', root)));
for (const [key, url] of Object.entries({overview:OVERVIEW_URL, detail:DETAIL_URL})) {
  const meta = manifest.files[key];
  assert.equal(url, `/offline-map/data/${meta.filename}`);
  const bytes = await readFile(new URL(url.slice(1), root));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), meta.sha256);
  assert.equal(bytes.length, meta.jsonBytes);
  assert(bytes.length < 24_000_000, 'Must fit a Cloudflare static asset');
  const data = JSON.parse(bytes);
  assert(data.countries.features.length >= 250, 'Worldwide land coverage required');
  for (const [layer, count] of Object.entries(meta.featureCounts)) {
    assert.equal(layer === 'cities' ? data[layer].length : data[layer].features.length, count);
  }
  if (key === 'overview') assert(data.cities.some(city=>city.name === '台北'));
  else assert(data.admin.features.length > 4000);
}
// Candidate lookup must work on both sides of the date line and repeated worlds.
const index = new SpatialIndex();
const east={bounds:{west:170,east:179,south:20,north:30}};
const west={bounds:{west:-179,east:-170,south:20,north:30}};
const other={bounds:{west:0,east:5,south:20,north:30}};
[east,west,other].forEach(entry=>index.add(entry));
for (const shift of [-360,0,360]) {
  const found=new Set(index.query({west:165+shift,east:195+shift,south:19,north:31}));
  assert(found.has(east)&&found.has(west)&&!found.has(other));
}
console.log('Natural Earth asset hashes, coverage, size and date-line index passed.');
