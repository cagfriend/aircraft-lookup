// 从 FAA CIFP（ARINC 424）生成浏览器使用的美国航路索引。
// 用法：node scripts/build-us-cifp.mjs <FAACIFP18 文件路径> [AIRAC 周期]
// 例如：node scripts/build-us-cifp.mjs C:\temp\FAACIFP18 2609
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = process.argv[2];
const cycle = process.argv[3] || 'unknown';
if (!source || !fs.existsSync(source)) {
  console.error('请提供已解压的 FAA FAACIFP18 文件路径。');
  process.exit(1);
}

function parseLat(value) {
  if (!/^[NS]\d{8}$/.test(value)) return null;
  const sign = value[0] === 'S' ? -1 : 1;
  return sign * (
    Number(value.slice(1, 3))
    + Number(value.slice(3, 5)) / 60
    + Number(value.slice(5, 7)) / 3600
    + Number(value.slice(7, 9)) / 360000
  );
}

function parseLon(value) {
  if (!/^[EW]\d{9}$/.test(value)) return null;
  const sign = value[0] === 'W' ? -1 : 1;
  return sign * (
    Number(value.slice(1, 4))
    + Number(value.slice(4, 6)) / 60
    + Number(value.slice(6, 8)) / 3600
    + Number(value.slice(8, 10)) / 360000
  );
}

const fixes = {};
const airwayRows = {};
const procedures = {};
const lines = fs.readFileSync(source, 'utf8').split(/\r?\n/);

for (const line of lines) {
  if (line[0] !== 'S') continue;

  const section = line[4];
  const subsection = line[5];
  const ident = line.slice(13, 18).trim();
  const lat = parseLat(line.slice(32, 41));
  const lon = parseLon(line.slice(41, 51));

  // Enroute waypoints, navaids, and airport terminal waypoints.
  if (ident && lat != null && lon != null && (
    (section === 'E' && subsection === 'A')
    || section === 'D'
    || (section === 'P' && line[12] === 'C')
  )) {
    fixes[ident] = [Number(lat.toFixed(5)), Number(lon.toFixed(5))];
  }

  // Enroute airway legs. The sequence number preserves the published order.
  if (section === 'E' && subsection === 'R') {
    const airway = line.slice(13, 18).trim();
    const sequence = Number(line.slice(25, 29));
    const point = line.slice(29, 34).trim();
    if (airway && point && Number.isFinite(sequence)) {
      (airwayRows[airway] ||= []).push([sequence, point]);
    }
  }

  // SIDs (D) and STARs (E). CIFP stores common routes and transitions separately.
  if (section === 'P' && (line[12] === 'D' || line[12] === 'E')) {
    const airport = line.slice(6, 10).trim();
    const kind = line[12];
    const procedure = line.slice(13, 19).trim();
    const transition = line.slice(19, 25).trim() || '_';
    const point = line.slice(29, 34).trim();
    if (airport && procedure && point) {
      const variants = (((procedures[airport] ||= {})[procedure] ||= {})[kind] ||= {});
      (variants[transition] ||= []).push(point);
    }
  }
}

const airways = {};
for (const [name, rows] of Object.entries(airwayRows)) {
  rows.sort((a, b) => a[0] - b[0]);
  airways[name] = rows.map((row) => row[1]).filter((point, i, all) => i === 0 || point !== all[i - 1]);
}

for (const airport of Object.values(procedures)) {
  for (const procedure of Object.values(airport)) {
    for (const variants of Object.values(procedure)) {
      for (const [transition, points] of Object.entries(variants)) {
        variants[transition] = points.filter((point, i) => i === 0 || point !== points[i - 1]);
      }
    }
  }
}

const data = {
  cycle,
  source: 'FAA CIFP (ARINC 424)',
  fixes,
  airways,
  procedures,
};
const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(here, '..', 'public', 'data', 'us-cifp.data.js');
const banner = `// Generated from FAA CIFP AIRAC ${cycle}. Do not edit by hand.\n`;
fs.writeFileSync(output, `${banner}window.AIRCRAFT_US_CIFP=${JSON.stringify(data)};\n`);

console.log(`Generated ${output}`);
console.log(`AIRAC ${cycle}: ${Object.keys(fixes).length} fixes, ${Object.keys(airways).length} airways, ${Object.values(procedures).reduce((n, airport) => n + Object.keys(airport).length, 0)} procedures.`);
