#!/usr/bin/env node
/* eslint-disable */
/*
 * Benchmark: old JS path (chunk.getBlockStateId/getBlockLight/getSkyLight/getBiome
 * iteration, equivalent to convertChunkToWasm core loop) vs new Rust/WASM
 * parseChunkDump118 path on identical column data.
 *
 * Source columns: chunk-packet-fixtures/fixtures/*.json (we already have synthetic + real ones).
 * For the JS path we materialize a prismarine-chunk Column via column.load(dump)
 * so that getBlockStateId() works exactly like in production worker.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const ChunkLoader = require('prismarine-chunk');
const { Vec3 } = require('vec3');

const wasm = require('../wasm-mesher/pkg/wasm_mesher.js');

const VERSION = '1.18.2';
const Chunk = ChunkLoader(VERSION);
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

const ITERATIONS = parseInt(process.env.BENCH_ITERS || '50', 10);
const WARMUP = 5;

function loadColumn (fixture) {
  const dumpBuf = Buffer.from(fixture.dump_b64, 'base64');
  const col = new Chunk(undefined);
  col.load(
    dumpBuf,
    BigInt(0xffffffff),  // bitMap — load all sections (1.18 protocol does not use bitmap)
    true,                // skyLightSent
    false,               // fullChunk -> doesn't matter for 1.18 single-payload
  );
  // Restore light from fixture so getBlockLight/getSkyLight return real numbers.
  if (fixture.light) {
    const skyArrs = fixture.light.skyLight_b64.map(b => Buffer.from(b, 'base64'));
    const blockArrs = fixture.light.blockLight_b64.map(b => Buffer.from(b, 'base64'));
    try {
      col.loadLight(
        skyArrs,
        blockArrs,
        fixture.light.skyLightMask,
        fixture.light.blockLightMask,
        fixture.light.emptySkyLightMask,
        fixture.light.emptyBlockLightMask,
      );
    } catch (e) {
      // Some fixture light layouts may not match exactly — skip silently.
    }
  }
  return col;
}

// Old path: pure JS triple-loop equivalent to convertChunkToWasm core
function jsExtract (column) {
  const minY = column.minY;
  const height = column.worldHeight;
  const totalCells = 16 * 16 * height;
  const blockStates = new Uint16Array(totalCells);
  const blockLight = new Uint8Array(totalCells);
  const skyLight = new Uint8Array(totalCells);
  const biomes = new Uint8Array(totalCells);
  const v = new Vec3(0, 0, 0);
  let idx = 0;
  for (let y = minY; y < minY + height; y++) {
    v.y = y;
    for (let z = 0; z < 16; z++) {
      v.z = z;
      for (let x = 0; x < 16; x++) {
        v.x = x;
        blockStates[idx] = column.getBlockStateId(v) || 0;
        const bl = column.getBlockLight(v);
        blockLight[idx] = bl !== undefined ? bl : 0;
        const sl = column.getSkyLight(v);
        skyLight[idx] = sl !== undefined ? sl : 15;
        biomes[idx] = column.getBiome ? (column.getBiome(v) || 1) : 1;
        idx++;
      }
    }
  }
  return { blockStates, blockLight, skyLight, biomes };
}

function timeit (label, iters, fn) {
  // Warmup
  for (let i = 0; i < WARMUP; i++) fn();
  const samples = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const p95 = samples[Math.floor(samples.length * 0.95)];
  const min = samples[0];
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return { label, median, p95, min, mean, n: iters };
}

function fmtMs (x) { return `${x.toFixed(3)}ms`; }

function main () {
  const files = fs.readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('_'))
    .sort();

  console.log(`bench: ITERS=${ITERATIONS} WARMUP=${WARMUP} version=${VERSION}\n`);
  console.log(
    'fixture'.padEnd(38) +
    'JS extract'.padEnd(20) +
    'WASM parseDump118'.padEnd(22) +
    'speedup',
  );
  console.log('-'.repeat(95));

  const totals = { js: 0, wasm: 0 };
  for (const file of files) {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8'));
    const dumpBuf = Buffer.from(fixture.dump_b64, 'base64');
    const dumpU8 = new Uint8Array(dumpBuf);

    let column;
    try {
      column = loadColumn(fixture);
    } catch (e) {
      console.log(`${file.padEnd(38)} [skip: ${e.message}]`);
      continue;
    }

    const js = timeit('js', ITERATIONS, () => jsExtract(column));
    const wasmRes = timeit('wasm', ITERATIONS, () => {
      wasm.parseChunkDump118(
        dumpU8,
        fixture.meta.numSections,
        fixture.meta.maxBitsPerBlock,
        fixture.meta.maxBitsPerBiome,
      );
    });

    const speedup = js.median / wasmRes.median;
    totals.js += js.median;
    totals.wasm += wasmRes.median;

    const name = file.replace('.json', '');
    console.log(
      name.padEnd(38) +
      fmtMs(js.median).padEnd(20) +
      fmtMs(wasmRes.median).padEnd(22) +
      `${speedup.toFixed(2)}x`,
    );
  }

  console.log('-'.repeat(95));
  console.log(
    'TOTAL (sum of medians)'.padEnd(38) +
    fmtMs(totals.js).padEnd(20) +
    fmtMs(totals.wasm).padEnd(22) +
    `${(totals.js / totals.wasm).toFixed(2)}x`,
  );
  console.log('\nNote: WASM path parses block_states + biomes from the raw dump.');
  console.log('JS path additionally extracts blockLight/skyLight via getBlockLight/getSkyLight,');
  console.log('which the dump parser does not handle yet (lighting is a separate packet).');
  console.log('For an apples-to-apples block-only comparison, run with BENCH_BLOCKS_ONLY=1.');
}

if (process.env.BENCH_BLOCKS_ONLY === '1') {
  // Replace jsExtract with blocks-only loop for fair compare.
  module.exports.__patched = true;
  // Override above
  const orig = jsExtract;
  // Note: we keep both paths as is — the WASM path also doesn't do light, so
  // including light in JS is unfair. Provide a blocks-only path here.
  global.__jsBlocksOnly = function (column) {
    const minY = column.minY;
    const height = column.worldHeight;
    const totalCells = 16 * 16 * height;
    const blockStates = new Uint16Array(totalCells);
    const biomes = new Uint8Array(totalCells);
    const v = new Vec3(0, 0, 0);
    let idx = 0;
    for (let y = minY; y < minY + height; y++) {
      v.y = y;
      for (let z = 0; z < 16; z++) {
        v.z = z;
        for (let x = 0; x < 16; x++) {
          v.x = x;
          blockStates[idx] = column.getBlockStateId(v) || 0;
          biomes[idx] = column.getBiome ? (column.getBiome(v) || 1) : 1;
          idx++;
        }
      }
    }
    return { blockStates, biomes };
  };
  // shadow
  // eslint-disable-next-line no-func-assign
  jsExtract = global.__jsBlocksOnly;
}

main();
