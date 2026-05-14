'use strict';

// Conformance harness na sobrannom WASM (wasm-mesher/pkg).
// Gonyaet te zhe fixtures, chto i harness.cjs (JS-prototype).

const fs = require('fs');
const path = require('path');

const wasm = require('../wasm-mesher/pkg/wasm_mesher.js');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

function reorderBlocksToSectionLayout(refs, numSections) {
  const out = new Uint16Array(numSections * 4096);
  for (let s = 0; s < numSections; s++) {
    for (let yIn = 0; yIn < 16; yIn++) {
      const yAbs = s * 16 + yIn;
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          const refIdx = yAbs * 256 + z * 16 + x;
          const dstIdx = (s * 4096) + ((yIn << 8) | (z << 4) | x);
          out[dstIdx] = refs[refIdx];
        }
      }
    }
  }
  return out;
}

function reorderU8ToSectionLayout(refs, numSections) {
  const out = new Uint8Array(numSections * 4096);
  for (let s = 0; s < numSections; s++) {
    for (let yIn = 0; yIn < 16; yIn++) {
      const yAbs = s * 16 + yIn;
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          const refIdx = yAbs * 256 + z * 16 + x;
          const dstIdx = (s * 4096) + ((yIn << 8) | (z << 4) | x);
          out[dstIdx] = refs[refIdx];
        }
      }
    }
  }
  return out;
}

function reorderBiomes(refs, numSections) {
  const out = new Uint8Array(numSections * 64);
  for (let s = 0; s < numSections; s++) {
    for (let yIn4 = 0; yIn4 < 4; yIn4++) {
      const yAbs4 = s * 4 + yIn4;
      for (let z4 = 0; z4 < 4; z4++) {
        for (let x4 = 0; x4 < 4; x4++) {
          const refIdx = yAbs4 * 16 + z4 * 4 + x4;
          const dstIdx = (s * 64) + ((yIn4 << 4) | (z4 << 2) | x4);
          out[dstIdx] = refs[refIdx];
        }
      }
    }
  }
  return out;
}

function maskToBits(longArr, capacity) {
  const out = new Uint8Array(capacity);
  for (let i = 0; i < longArr.length; i++) {
    const [high, low] = longArr[i];
    const hi = high >>> 0; const lo = low >>> 0;
    for (let b = 0; b < 32; b++) {
      const idx = i * 64 + b;
      if (idx < capacity) out[idx] = (lo >>> b) & 1;
    }
    for (let b = 0; b < 32; b++) {
      const idx = i * 64 + 32 + b;
      if (idx < capacity) out[idx] = (hi >>> b) & 1;
    }
  }
  return out;
}

function arraysEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function diffSummary(a, b, label) {
  let firstIdx = -1; let count = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      if (firstIdx === -1) firstIdx = i;
      count++;
    }
  }
  if (count === 0) return `${label}=✓`;
  return `${label}=✗ (${count} diffs, first @${firstIdx} got=${a[firstIdx]} exp=${b[firstIdx]})`;
}

function runFixture(name, fx) {
  const meta = fx.meta;
  const numSections = meta.numSections;
  const dump = Buffer.from(fx.dump_b64, 'base64');

  const result = wasm.parseChunkDump118(dump, numSections, meta.maxBitsPerBlock, meta.maxBitsPerBiome);

  const refBlocks = new Uint16Array(Buffer.from(fx.reference.blockStates_b64, 'base64').buffer.slice(0));
  // Vyshe slice(0) ne nuzhen, no Uint16Array oborachivaet ArrayBuffer Buffer'a — pereklyuchim na yavnyi:
  const refBlocksBuf = Buffer.from(fx.reference.blockStates_b64, 'base64');
  const refBlocksTyped = new Uint16Array(refBlocksBuf.buffer, refBlocksBuf.byteOffset, refBlocksBuf.byteLength / 2);
  const refBiomes = Buffer.from(fx.reference.biomes_b64, 'base64');
  const refBlockLight = Buffer.from(fx.reference.blockLight_b64, 'base64');
  const refSkyLight = Buffer.from(fx.reference.skyLight_b64, 'base64');

  const expBlocks = reorderBlocksToSectionLayout(refBlocksTyped, numSections);
  const expBiomes = reorderBiomes(refBiomes, numSections);
  const expBlockLight = reorderU8ToSectionLayout(refBlockLight, numSections);
  const expSkyLight = reorderU8ToSectionLayout(refSkyLight, numSections);

  // Light: razvorachivaem cherez wasm.unpackLightSection118 (kazhdaya sekciya po maske).
  const skyMask = fx.light.skyLightMask;
  const blockMask = fx.light.blockLightMask;
  const skyBuffers = fx.light.skyLight_b64.map(s => Buffer.from(s, 'base64'));
  const blockBuffers = fx.light.blockLight_b64.map(s => Buffer.from(s, 'base64'));

  function unpackField(buffers, mask) {
    const cap = numSections + 2;
    const bits = maskToBits(mask, cap);
    const out = new Uint8Array(numSections * 4096);
    let bufIdx = 0;
    for (let i = 0; i < cap; i++) {
      if (!bits[i]) continue;
      const realIdx = i - 1;
      const buf = buffers[bufIdx++];
      if (realIdx < 0 || realIdx >= numSections) continue;
      const unpacked = wasm.unpackLightSection118(buf);
      out.set(unpacked, realIdx * 4096);
    }
    return out;
  }

  const parsedSky = unpackField(skyBuffers, skyMask);
  const parsedBlock = unpackField(blockBuffers, blockMask);

  const blocksOk = arraysEq(result.blockStates, expBlocks);
  const biomesOk = arraysEq(result.biomes, expBiomes);
  const blOk = arraysEq(parsedBlock, expBlockLight);
  const slOk = arraysEq(parsedSky, expSkyLight);
  const bytesOk = result.bytesRead === dump.length;
  const allOk = bytesOk && blocksOk && biomesOk && blOk && slOk;

  const status = allOk ? 'PASS' : 'FAIL';
  const parts = [
    `bytes=${result.bytesRead}/${dump.length}`,
    diffSummary(result.blockStates, expBlocks, 'blocks'),
    diffSummary(result.biomes, expBiomes, 'biomes'),
    diffSummary(parsedBlock, expBlockLight, 'blockLight'),
    diffSummary(parsedSky, expSkyLight, 'skyLight'),
  ];
  console.log(`[${status}] ${name.padEnd(36)} ${parts.join(' ')}`);
  return allOk;
}

function main() {
  const files = fs.readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('_'))
    .sort();
  let pass = 0, fail = 0;
  for (const f of files) {
    const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), 'utf8'));
    if (runFixture(fx.name, fx)) pass++; else fail++;
  }
  console.log(`\n${pass}/${pass + fail} fixtures passed (WASM build).`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
