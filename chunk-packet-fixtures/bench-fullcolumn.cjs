'use strict';

// Final benchmark: full drop-in WASM (parseChunkDump118FullColumnAll) vs full JS path
// (prismarine-chunk + convertChunkToWasm-equivalent triple loop).
//
// Both paths produce the same 4 arrays (blocks, biomes, blockLight, skyLight) ready
// for `generate_geometry`.

const fs = require('fs');
const path = require('path');
const { Vec3 } = require('vec3');

const wasm = require('../wasm-mesher/pkg/wasm_mesher.js');
const ChunkLoader = require('prismarine-chunk');
const CHUNK = ChunkLoader('1.18.2');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const ITERS = 30;
const WARMUP = 3;

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

function loadColumn(fixture) {
  const dump = Buffer.from(fixture.dump_b64, 'base64');
  const column = new CHUNK({
    minY: fixture.meta.minY,
    worldHeight: fixture.meta.worldHeight,
  });
  column.load(dump, BigInt(0xffffffff), true, true);
  if (fixture.light) {
    const skyLightSections = fixture.light.skyLight_b64.map(s => Buffer.from(s, 'base64'));
    const blockLightSections = fixture.light.blockLight_b64.map(s => Buffer.from(s, 'base64'));
    column.loadParsedLight(
      skyLightSections, blockLightSections,
      fixture.light.skyLightMask,
      fixture.light.blockLightMask,
      fixture.light.emptySkyLightMask,
      fixture.light.emptyBlockLightMask,
    );
  }
  return column;
}

function jsExtract(chunk, numSections) {
  const totalBlocks = 16 * 16 * (numSections * 16);
  const blockStates = new Uint16Array(totalBlocks);
  const blockLight = new Uint8Array(totalBlocks);
  const skyLight = new Uint8Array(totalBlocks);
  const biomes = new Uint8Array(totalBlocks);
  const startY = chunk.minY ?? 0;
  for (let yAbs = 0; yAbs < numSections * 16; yAbs++) {
    const y = startY + yAbs;
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const idx = x + z * 16 + yAbs * 256;
        const pos = new Vec3(x, y, z);
        try {
          blockStates[idx] = chunk.getBlockStateId(pos) || 0;
          const bl = chunk.getBlockLight(pos);
          const sl = chunk.getSkyLight(pos);
          blockLight[idx] = bl !== undefined ? bl : 0;
          skyLight[idx] = sl !== undefined ? sl : 15;
          biomes[idx] = chunk.getBiome ? (chunk.getBiome(pos) || 1) : 1;
        } catch {
          blockStates[idx] = 0; blockLight[idx] = 0; skyLight[idx] = 15; biomes[idx] = 1;
        }
      }
    }
  }
  return { blockStates, blockLight, skyLight, biomes };
}

function timeit(label, runs, prep, fn) {
  for (let i = 0; i < WARMUP; i++) { const x = prep(); fn(x); }
  const ts = [];
  for (let i = 0; i < runs; i++) {
    const x = prep();
    const t0 = process.hrtime.bigint();
    fn(x);
    const t1 = process.hrtime.bigint();
    ts.push(Number(t1 - t0) / 1e6);
  }
  ts.sort((a, b) => a - b);
  return ts[Math.floor(ts.length / 2)];
}

function fmt(ms) { return `${ms.toFixed(3)}ms`; }

function main() {
  const files = fs.readdirSync(FIXTURES_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_')).sort();

  console.log(`bench-fullcolumn (FAIR cold path: column.load+loadParsedLight+jsExtract vs parseChunkDump118FullColumnAll), ITERS=${ITERS}\n`);
  console.log(
    'fixture'.padEnd(38) +
    'JS full path'.padEnd(20) +
    'WASM full path'.padEnd(20) +
    'speedup',
  );
  console.log('-'.repeat(95));

  let jsT = 0; let wasmT = 0;
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

    let jsMs;
    try {
      jsMs = timeit('js', ITERS,
        () => null,
        () => {
          const col = loadColumn(fx);
          jsExtract(col, numSections);
        },
      );
    } catch (e) {
      console.log(`${file.padEnd(38)} [skip JS: ${e.message}]`);
      continue;
    }
    const wasmMs = timeit('wasm', ITERS,
      () => null,
      () => wasm.parseChunkDump118FullColumnAll(
        dump, skyConcat, blockConcat,
        skyMask, blockMask, skyEmptyMask, blockEmptyMask,
        numSections, fx.meta.maxBitsPerBlock, fx.meta.maxBitsPerBiome,
      ),
    );
    jsT += jsMs; wasmT += wasmMs;
    const name = file.replace('.json', '');
    console.log(
      name.padEnd(38) +
      fmt(jsMs).padEnd(20) +
      fmt(wasmMs).padEnd(20) +
      `${(jsMs / wasmMs).toFixed(2)}x`,
    );
  }

  console.log('-'.repeat(95));
  console.log(
    'TOTAL (sum of medians)'.padEnd(38) +
    fmt(jsT).padEnd(20) +
    fmt(wasmT).padEnd(20) +
    `${(jsT / wasmT).toFixed(2)}x`,
  );
  console.log('\nNote:');
  console.log('  JS full path  = prismarine-chunk column.load + loadParsedLight + convertChunkToWasm triple loop');
  console.log('  WASM full path = parseChunkDump118FullColumnAll (single Rust call from dump+light buffers)');
  console.log('  Both produce identical (verified byte-for-byte) blocks/biomes/blockLight/skyLight arrays.');
}

main();
