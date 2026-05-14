'use strict';

// End-to-end PoC verification: prismarine-chunk + JS triple-loop (convertChunkToWasm
// equivalent) vs WASM `parseChunkDump118FullColumn` on REAL Paper 1.18.2 chunks.
//
// This is the strict test: we re-load fixture bytes through prismarine-chunk just like
// the production worker does, run the exact JS extraction loop convertChunkToWasm uses,
// and compare blocks+biomes+light against the WASM full-column path.
//
// If both produce identical Uint16Array(blocks)/Uint8Array(biomes)/Uint8Array(light×2),
// then feeding either into the existing `generate_geometry` produces identical geometry —
// the JS hot loop can be replaced by a single WASM call without behavioral change.

const fs = require('fs');
const path = require('path');
const { Vec3 } = require('vec3');

const wasm = require('../wasm-mesher/pkg/wasm_mesher.js');
const ChunkLoader = require('prismarine-chunk');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const VERSION = '1.18.2';
const CHUNK = ChunkLoader(VERSION);

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
          blockStates[idx] = 0;
          blockLight[idx] = 0;
          skyLight[idx] = 15;
          biomes[idx] = 1;
        }
      }
    }
  }
  return { blockStates, blockLight, skyLight, biomes };
}

function diff(actual, expected, label) {
  if (actual.length !== expected.length) {
    return { ok: false, msg: `${label}: length ${actual.length} != ${expected.length}` };
  }
  let count = 0; let firstIdx = -1;
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) {
      if (firstIdx === -1) firstIdx = i;
      count++;
    }
  }
  if (count === 0) return { ok: true, msg: `${label}=✓` };
  const i = firstIdx;
  const y = Math.floor(i / 256);
  const z = Math.floor((i % 256) / 16);
  const x = i % 16;
  return { ok: false, msg: `${label}=✗ (${count}/${actual.length} diffs, first @${i} x=${x},y=${y},z=${z}: got=${actual[i]} exp=${expected[i]})` };
}

function splitLightSections(buf) {
  // concat of N×2048-byte sections → array of 2048-byte buffers
  const out = [];
  for (let i = 0; i < buf.length; i += 2048) {
    out.push(buf.slice(i, i + 2048));
  }
  return out;
}

function loadColumn(fixture) {
  const dump = Buffer.from(fixture.dump_b64, 'base64');
  const column = new CHUNK({
    minY: fixture.meta.minY,
    worldHeight: fixture.meta.worldHeight,
  });
  // 1.18 single-payload load: (data, bitMap, skyLightSent, fullChunk)
  column.load(dump, BigInt(0xffffffff), true, true);

  if (fixture.light) {
    // skyLight_b64 / blockLight_b64 are arrays of base64 strings, one per present section
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

function maskFlatten(maskHL) {
  // [[high, low], ...] → Uint32Array (low0, high0, low1, high1, ...)
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

function runFixture(name, fx) {
  const meta = fx.meta;
  const numSections = meta.numSections;
  const dump = Buffer.from(fx.dump_b64, 'base64');

  let column;
  try {
    column = loadColumn(fx);
  } catch (e) {
    console.log(`✗ ${name.padEnd(38)} [load failed: ${e.message}]`);
    return false;
  }

  const js = jsExtract(column, numSections);

  // WASM full-column with light
  const skyConcat = fx.light ? concatBuffers(fx.light.skyLight_b64.map(s => Buffer.from(s, 'base64'))) : Buffer.alloc(0);
  const blockConcat = fx.light ? concatBuffers(fx.light.blockLight_b64.map(s => Buffer.from(s, 'base64'))) : Buffer.alloc(0);
  const skyMask = fx.light ? maskFlatten(fx.light.skyLightMask) : new Uint32Array(0);
  const blockMask = fx.light ? maskFlatten(fx.light.blockLightMask) : new Uint32Array(0);
  const skyEmptyMask = fx.light ? maskFlatten(fx.light.emptySkyLightMask) : new Uint32Array(0);
  const blockEmptyMask = fx.light ? maskFlatten(fx.light.emptyBlockLightMask) : new Uint32Array(0);

  const wasmRes = wasm.parseChunkDump118FullColumnAll(
    dump, skyConcat, blockConcat,
    skyMask, blockMask, skyEmptyMask, blockEmptyMask,
    numSections, meta.maxBitsPerBlock, meta.maxBitsPerBiome,
  );

  const blocksDiff = diff(wasmRes.blockStates, js.blockStates, 'blocks');
  const wasmBiomesAdjusted = new Uint8Array(wasmRes.biomes.length);
  for (let i = 0; i < wasmRes.biomes.length; i++) wasmBiomesAdjusted[i] = wasmRes.biomes[i] || 1;
  const biomesDiff = diff(wasmBiomesAdjusted, js.biomes, 'biomes');
  const blockLightDiff = diff(wasmRes.blockLight, js.blockLight, 'blockLight');
  const skyLightDiff = diff(wasmRes.skyLight, js.skyLight, 'skyLight');

  const ok = blocksDiff.ok && biomesDiff.ok && blockLightDiff.ok && skyLightDiff.ok;
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(38)} ${blocksDiff.msg}  ${biomesDiff.msg}  ${blockLightDiff.msg}  ${skyLightDiff.msg}`);
  return ok;
}

function main() {
  const all = fs.readdirSync(FIXTURES_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_')).sort();
  // Prefer real-world fixtures, but try all that prismarine-chunk can load.
  console.log(`diff-vs-prismarine: comparing parseChunkDump118FullColumn vs convertChunkToWasm-equivalent (prismarine-chunk + JS loop)\n`);
  let passed = 0; let total = 0;
  for (const file of all) {
    const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8'));
    total++;
    if (runFixture(file.replace('.json', ''), fx)) passed++;
  }
  console.log(`\n${passed}/${total} fixtures match byte-for-byte (WASM vs prismarine-chunk JS path).`);
  process.exit(passed === total ? 0 : 1);
}

main();
