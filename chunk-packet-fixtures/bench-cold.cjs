#!/usr/bin/env node
'use strict';
/*
 * Cold-start benchmark: каждый прогон на FRESH колонке (column.load заново).
 * Это честнее отражает «прилетел чанк → надо извлечь данные ОДИН раз».
 */
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const ChunkLoader = require('prismarine-chunk');
const { Vec3 } = require('vec3');
const wasm = require('../wasm-mesher/pkg/wasm_mesher.js');

const VERSION = '1.18.2';
const Chunk = ChunkLoader(VERSION);
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const ITERS = parseInt(process.env.BENCH_ITERS || '30', 10);

function freshColumn (dumpBuf) {
  const col = new Chunk(undefined);
  col.load(dumpBuf, BigInt(0xffffffff), true, false);
  return col;
}

function jsExtract (column) {
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
}

function timeitCold (iters, setupFn, runFn) {
  const samples = [];
  for (let i = 0; i < iters; i++) {
    const ctx = setupFn();
    const t0 = performance.now();
    runFn(ctx);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return {
    median: samples[Math.floor(samples.length / 2)],
    min: samples[0],
    p95: samples[Math.floor(samples.length * 0.95)],
    mean: samples.reduce((a, b) => a + b) / samples.length,
  };
}

const fmt = x => `${x.toFixed(3)}ms`;

function main () {
  const files = fs.readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('_'))
    .sort();

  console.log(`bench (COLD, fresh column each iter): ITERS=${ITERS}\n`);
  console.log(
    'fixture'.padEnd(38) +
    'JS cold (decode+iter)'.padEnd(26) +
    'WASM (parse dump)'.padEnd(22) +
    'WASM no-marshal'.padEnd(20) +
    'parse-only / full',
  );
  console.log('-'.repeat(125));

  let jsT = 0, wasmT = 0, wasmNoT = 0;
  for (const file of files) {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8'));
    const dumpBuf = Buffer.from(fixture.dump_b64, 'base64');
    const dumpU8 = new Uint8Array(dumpBuf);

    let js, wasmRes, wasmNo;
    try {
      js = timeitCold(ITERS, () => freshColumn(dumpBuf), col => jsExtract(col));
    } catch (e) {
      console.log(`${file.padEnd(38)} [skip JS: ${e.message}]`);
      continue;
    }
    wasmRes = timeitCold(
      ITERS,
      () => null,
      () => wasm.parseChunkDump118(dumpU8, fixture.meta.numSections, fixture.meta.maxBitsPerBlock, fixture.meta.maxBitsPerBiome),
    );
    wasmNo = timeitCold(
      ITERS,
      () => null,
      () => wasm.parseChunkDump118NoMarshal(dumpU8, fixture.meta.numSections, fixture.meta.maxBitsPerBlock, fixture.meta.maxBitsPerBiome),
    );

    jsT += js.median;
    wasmT += wasmRes.median;
    wasmNoT += wasmNo.median;
    const name = file.replace('.json', '');
    console.log(
      name.padEnd(38) +
      fmt(js.median).padEnd(26) +
      fmt(wasmRes.median).padEnd(22) +
      fmt(wasmNo.median).padEnd(20) +
      `${(wasmNo.median / wasmRes.median * 100).toFixed(0)}%`,
    );
  }

  console.log('-'.repeat(125));
  console.log(
    'TOTAL (sum of medians)'.padEnd(38) +
    fmt(jsT).padEnd(26) +
    fmt(wasmT).padEnd(22) +
    fmt(wasmNoT).padEnd(20) +
    `${(wasmNoT / wasmT * 100).toFixed(0)}%`,
  );
  console.log('\nLegend:');
  console.log('  WASM (parse dump)  — parse + return Uint16Array(blocks)+Uint8Array(biomes)+JS object to JS');
  console.log('  WASM no-marshal    — same parse, but returns only a u64 checksum (no Uint16Array marshalling)');
  console.log('  parse-only / full  — what fraction of WASM time is spent in actual parsing vs marshalling');
}

main();
