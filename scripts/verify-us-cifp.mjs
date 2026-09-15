// 验证生成的 FAA CIFP 索引包含代表性美国航路、SID、STAR 和终端航路点。
import fs from 'node:fs';
import vm from 'node:vm';

const context = { window: {} };
vm.runInNewContext(fs.readFileSync('public/data/us-cifp.data.js', 'utf8'), context);
const data = context.window.AIRCRAFT_US_CIFP;
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

assert(data?.cycle, '缺少 AIRAC 周期');
assert(data.airways?.J17?.includes('PNH') && data.airways.J17.includes('ABI'), 'J17 航路未包含 PNH/ABI');
assert(
  data.procedures?.KDEN?.SLEEK2?.D?.['5']?.join(',') === 'STAKR,AZARO,SLEEK',
  'KDEN SLEEK2 SID 公共航段不正确',
);
assert(
  data.procedures?.KAUS?.LAIKS4?.E?.['4DILLO']?.join(',') === 'DILLO,KTANA,LAIKS',
  'KAUS LAIKS4 STAR 的 DILLO 转换段不正确',
);
assert(data.fixes?.KIDNG && data.fixes?.KTANA && data.fixes?.BOYZZ, '终端航路点坐标缺失');

console.log(`FAA CIFP AIRAC ${data.cycle} validation passed.`);
