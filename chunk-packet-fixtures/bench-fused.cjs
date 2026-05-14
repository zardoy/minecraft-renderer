'use strict';
// Variant 3 bench: parse+mesh in one Rust call vs current 2-step path.
//
// Path A (current PoC drop-in): wasm.parseChunkDump118FullColumnAll → JS marshals to
//   Uint16/8 arrays → wasm.generate_geometry (which copies them back into Rust).
// Path B (variant 3, no JS hop): wasm.generateGeometryFromDump118 (parse+light+mesh
//   in one Rust call, only final geometry crosses JS<->WASM).
//
// Block-state lists (invisible/transparent/occluding) are computed once from
// minecraft-data 1.18.2 — used by BOTH paths so any output diff is a real bug.

const fs = require('fs');
const path = require('path');
const wasm = require('../wasm-mesher/pkg/wasm_mesher.js');
const MinecraftData = require('minecraft-data');

const VERSION = '1.18.2';
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const ITERS = 30;
const WARMUP = 3;

const mcData = MinecraftData(VERSION);

function blockToIds(b) {
  const ids = [];
  for (let s = b.minStateId; s <= b.maxStateId; s++) ids.push(s);
  return ids;
}
const transparentBlocks = new Uint16Array(mcData.blocksArray.filter(x => x.transparent).flatMap(blockToIds));
const invisibleBlocks = new Uint16Array(mcData.blocksArray.filter(x => x.boundingBox === 'empty').flatMap(blockToIds));
const noAoBlocks = new Uint16Array(0);
const cullIdenticalBlocks = new Uint16Array(mcData.blocksArray.filter(x => x.name.includes('glass') || x.name.includes('ice')).flatMap(blockToIds));
const occludingBlocks = new Uint16Array(mcData.blocksArray.filter(x => !x.transparent && x.boundingBox === 'block').flatMap(blockToIds));

console.log(`bench-fused (parse+mesh in one Rust call vs 2-step path), ITERS=${ITERS}`);
console.log(`block lists: invisible=${invisibleBlocks.length}, transparent=${transparentBlocks.length}, occluding=${occludingBlocks.length}\n`);

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

function pathA(fx, ctx) {
  const parsed = wasm.parseChunkDump118FullColumnAll(
    ctx.dump, ctx.skyConcat, ctx.blockConcat,
    ctx.skyMask, ctx.blockMask, ctx.skyEmpty, ctx.blockEmpty,
    fx.meta.numSections, fx.meta.maxBitsPerBlock, fx.meta.maxBitsPerBiome,
  );
  return wasm.generate_geometry(
    0, fx.meta.minY, 0,
    fx.meta.numSections * 16,
    fx.meta.minY, fx.meta.minY + fx.meta.numSections * 16,
    fx.meta.minY,
    parsed.blockStates, parsed.blockLight, parsed.skyLight, parsed.biomes,
    invisibleBlocks, transparentBlocks, noAoBlocks, cullIdenticalBlocks, occludingBlocks,
    true, false, 15,
  );
}

function pathB(fx, ctx) {
  return wasm.generateGeometryFromDump118(
    0, fx.meta.minY, 0,
    fx.meta.numSections * 16,
    fx.meta.minY, fx.meta.minY + fx.meta.numSections * 16,
    fx.meta.minY,
    ctx.dump, ctx.skyConcat, ctx.blockConcat,
    ctx.skyMask, ctx.blockMask, ctx.skyEmpty, ctx.blockEmpty,
    fx.meta.numSections, fx.meta.maxBitsPerBlock, fx.meta.maxBitsPerBiome,
    invisibleBlocks, transparentBlocks, noAoBlocks, cullIdenticalBlocks, occludingBlocks,
    true, false, 15,
  );
}

function geomSig(g) {
  // a coarse signature: total triangle count + first few vertex coordinates
  const indices = g.indices || g.indexBuffer || [];
  const positions = g.positions || g.positionBuffer || [];
  return `idx=${indices.length} pos=${positions.length}`;
}

const files = fs.readdirSync(FIXTURES_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_')).sort();

console.log('fixture'.padEnd(38) + 'pathA(2-step)'.padEnd(16) + 'pathB(1-step)'.padEnd(16) + 'speedup'.padEnd(10) + 'geom match');
console.log('-'.repeat(95));

let sumA = 0, sumB = 0;
for (const file of files) {
  const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8'));
  const ctx = {
    dump: Buffer.from(fx.dump_b64, 'base64'),
    skyConcat: fx.light ? concatBuffers(fx.light.skyLight_b64.map(s => Buffer.from(s, 'base64'))) : Buffer.alloc(0),
    blockConcat: fx.light ? concatBuffers(fx.light.blockLight_b64.map(s => Buffer.from(s, 'base64'))) : Buffer.alloc(0),
    skyMask: fx.light ? maskFlatten(fx.light.skyLightMask) : new Uint32Array(0),
    blockMask: fx.light ? maskFlatten(fx.light.blockLightMask) : new Uint32Array(0),
    skyEmpty: fx.light ? maskFlatten(fx.light.emptySkyLightMask) : new Uint32Array(0),
    blockEmpty: fx.light ? maskFlatten(fx.light.emptyBlockLightMask) : new Uint32Array(0),
  };

  let gA, gB;
  try { gA = pathA(fx, ctx); } catch (e) { console.log(`${file.padEnd(38)} pathA error: ${e.message}`); continue; }
  try { gB = pathB(fx, ctx); } catch (e) { console.log(`${file.padEnd(38)} pathB error: ${e.message}`); continue; }
  const sigA = geomSig(gA), sigB = geomSig(gB);
  const match = sigA === sigB ? '✓' : `✗ A=${sigA} vs B=${sigB}`;

  const tA = timeit(() => pathA(fx, ctx));
  const tB = timeit(() => pathB(fx, ctx));
  sumA += tA; sumB += tB;
  console.log(
    file.replace('.json', '').padEnd(38) +
    fmt(tA).padEnd(16) +
    fmt(tB).padEnd(16) +
    `${(tA / tB).toFixed(2)}x`.padEnd(10) +
    match,
  );
}

console.log('-'.repeat(95));
console.log(
  'TOTAL (sum of medians)'.padEnd(38) +
  fmt(sumA).padEnd(16) +
  fmt(sumB).padEnd(16) +
  `${(sumA / sumB).toFixed(2)}x`,
);
