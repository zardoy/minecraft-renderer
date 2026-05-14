'use strict';
// Micro-bench: split parseChunkDump118FullColumnAll into pieces to see where the time goes.
// Compare against parseChunkDump118FullColumn (no light) on the same fixture set.

const fs = require('fs');
const path = require('path');
const wasm = require('../wasm-mesher/pkg/wasm_mesher.js');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const ITERS = 200;
const WARMUP = 20;

function maskFlatten(maskHL) {
  const out = new Uint32Array(maskHL.length * 2);
  for (let i = 0; i < maskHL.length; i++) {
    const [h, l] = maskHL[i];
    out[i * 2] = l >>> 0;
    out[i * 2 + 1] = h >>> 0;
  }
  return out;
}
function concatBuffers(arr) {
  const total = arr.reduce((s, b) => s + b.length, 0);
  const out = Buffer.alloc(total);
  let off = 0;
  for (const b of arr) { b.copy(out, off); off += b.length; }
  return out;
}
function timeit(fn) {
  for (let i = 0; i < WARMUP; i++) fn();
  const ts = [];
  for (let i = 0; i < ITERS; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    const t1 = process.hrtime.bigint();
    ts.push(Number(t1 - t0) / 1e6);
  }
  ts.sort((a, b) => a - b);
  return ts[Math.floor(ts.length / 2)];
}
function fmt(ms) { return `${ms.toFixed(3)}ms`; }

const files = ['real_paper_spawn.json', 'real_paper_far_x.json', 'real_paper_diagonal.json', 'light_multi_sections.json', 'mixed_biomes.json'];
console.log(`micro-bench, ITERS=${ITERS}\n`);
console.log(
  'fixture'.padEnd(30) +
  'no_light'.padEnd(13) +
  'with_light'.padEnd(13) +
  'light_overhead'.padEnd(17) +
  'no_marshal'.padEnd(13)
);
console.log('-'.repeat(86));

for (const file of files) {
  const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8'));
  const dump = Buffer.from(fx.dump_b64, 'base64');
  const numSections = fx.meta.numSections;
  const skyConcat = fx.light ? concatBuffers(fx.light.skyLight_b64.map(s => Buffer.from(s, 'base64'))) : Buffer.alloc(0);
  const blockConcat = fx.light ? concatBuffers(fx.light.blockLight_b64.map(s => Buffer.from(s, 'base64'))) : Buffer.alloc(0);
  const skyMask = fx.light ? maskFlatten(fx.light.skyLightMask) : new Uint32Array(0);
  const blockMask = fx.light ? maskFlatten(fx.light.blockLightMask) : new Uint32Array(0);
  const skyEmptyMask = fx.light ? maskFlatten(fx.light.emptySkyLightMask) : new Uint32Array(0);
  const blockEmptyMask = fx.light ? maskFlatten(fx.light.emptyBlockLightMask) : new Uint32Array(0);

  const tNoLight = timeit(() => wasm.parseChunkDump118FullColumn(dump, numSections, fx.meta.maxBitsPerBlock, fx.meta.maxBitsPerBiome));
  const tWithLight = timeit(() => wasm.parseChunkDump118FullColumnAll(dump, skyConcat, blockConcat, skyMask, blockMask, skyEmptyMask, blockEmptyMask, numSections, fx.meta.maxBitsPerBlock, fx.meta.maxBitsPerBiome));
  const tNoMarshal = timeit(() => wasm.parseChunkDump118NoMarshal(dump, numSections, fx.meta.maxBitsPerBlock, fx.meta.maxBitsPerBiome));

  console.log(
    file.replace('.json', '').padEnd(30) +
    fmt(tNoLight).padEnd(13) +
    fmt(tWithLight).padEnd(13) +
    fmt(tWithLight - tNoLight).padEnd(17) +
    fmt(tNoMarshal).padEnd(13)
  );
}

console.log('\nLegend:');
console.log('  no_light   = parseChunkDump118FullColumn (blocks+biomes, no light)');
console.log('  with_light = parseChunkDump118FullColumnAll (full)');
console.log('  light_overhead = with_light - no_light (cost of light assembly + 2 extra Uint8Array marshalling)');
console.log('  no_marshal = parseChunkDump118NoMarshal (just checksum, no Uint16Array/Uint8Array returns)');
