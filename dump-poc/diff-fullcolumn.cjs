'use strict';

// PoC verification: full-column WASM dump-parser path vs reference layout.
//
// Goal: prove that `parseChunkDump118FullColumn` produces blocks+biomes arrays
// in the SAME layout as `convertChunkToWasm` (prismarine-chunk + JS triple-loop).
// If they match byte-for-byte on every fixture, then feeding WASM-output to the
// existing `generate_geometry` is guaranteed to produce identical geometry —
// `generate_geometry` is a pure function of these arrays.
//
// Reference data:
//   fixture.reference.blockStates_b64 — Uint16Array, layout x + z*16 + y*256
//                                       (this is exactly what convertChunkToWasm builds)
//   fixture.reference.biomes_b64       — Uint8Array,  same layout, biome per block

const fs = require('fs');
const path = require('path');

const wasm = require('../wasm-mesher/pkg/wasm_mesher.js');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

function diff(actual, expected) {
  if (actual.length !== expected.length) {
    return { ok: false, msg: `length ${actual.length} != ${expected.length}` };
  }
  let count = 0; let firstIdx = -1;
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) {
      if (firstIdx === -1) firstIdx = i;
      count++;
    }
  }
  if (count === 0) return { ok: true };
  const i = firstIdx;
  const y = Math.floor(i / 256);
  const z = Math.floor((i % 256) / 16);
  const x = i % 16;
  return {
    ok: false,
    msg: `${count} diffs (of ${actual.length}), first @${i} (x=${x},y=${y},z=${z}): got=${actual[i]} exp=${expected[i]}`,
  };
}

function runFixture(name, fx) {
  const meta = fx.meta;
  const numSections = meta.numSections;
  const dump = Buffer.from(fx.dump_b64, 'base64');

  const result = wasm.parseChunkDump118FullColumn(
    dump,
    numSections,
    meta.maxBitsPerBlock,
    meta.maxBitsPerBiome,
  );

  const refBlocksBuf = Buffer.from(fx.reference.blockStates_b64, 'base64');
  const refBlocks = new Uint16Array(refBlocksBuf.buffer, refBlocksBuf.byteOffset, refBlocksBuf.byteLength / 2);
  const refBiomesCompact = new Uint8Array(Buffer.from(fx.reference.biomes_b64, 'base64'));

  // Reference biomes are stored in per-section 4×4×4 layout (64 per section).
  // Expand them per-block the same way prismarine-chunk's `getBiome(pos)` does:
  // biome at (x,y,z) = compact[section*64 | (y_in>>2)<<4 | (z>>2)<<2 | (x>>2)],
  // then place at full-column index (x + z*16 + y_abs*256).
  const refBiomes = new Uint8Array(numSections * 4096);
  for (let s = 0; s < numSections; s++) {
    for (let yIn = 0; yIn < 16; yIn++) {
      const yAbs = s * 16 + yIn;
      const y4 = yIn >> 2;
      for (let z = 0; z < 16; z++) {
        const z4 = z >> 2;
        for (let x = 0; x < 16; x++) {
          const x4 = x >> 2;
          const compactIdx = s * 64 + ((y4 << 4) | (z4 << 2) | x4);
          const fullIdx = x + z * 16 + yAbs * 256;
          refBiomes[fullIdx] = refBiomesCompact[compactIdx];
        }
      }
    }
  }

  const blocksDiff = diff(result.blockStates, refBlocks);
  const biomesDiff = diff(result.biomes, refBiomes);

  const status = blocksDiff.ok && biomesDiff.ok ? '✓' : '✗';
  let line = `${status} ${name.padEnd(38)}`;
  line += `blocks=${blocksDiff.ok ? '✓' : `✗ ${blocksDiff.msg}`}`;
  if (!biomesDiff.ok || biomesDiff.msg) line += `  biomes=${biomesDiff.ok ? '✓' : `✗ ${biomesDiff.msg}`}`;
  else line += `  biomes=✓`;
  console.log(line);

  return blocksDiff.ok && biomesDiff.ok;
}

function main() {
  const files = fs.readdirSync(FIXTURES_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_')).sort();
  console.log(`diff-fullcolumn: comparing parseChunkDump118FullColumn against fixture.reference (convertChunkToWasm layout)\n`);
  let passed = 0; let total = 0;
  for (const file of files) {
    const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8'));
    total++;
    if (runFixture(file.replace('.json', ''), fx)) passed++;
  }
  console.log(`\n${passed}/${total} fixtures match byte-for-byte.`);
  process.exit(passed === total ? 0 : 1);
}

main();
