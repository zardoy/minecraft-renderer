#!/usr/bin/env node
/* eslint-disable */
// JS-prototype dump parser dlya Minecraft 1.18+ chunk column dump-formata.
// Tsel: validirovat ponimanie formata pered perepisyvaniem v Rust.
//
// Zerkalit logiku iz prismarine-chunk:
//   src/pc/1.18/ChunkColumn.js  — load()/dump()
//   src/pc/common/PaletteChunkSection.js  — section.write/read
//   src/pc/common/PaletteBiome.js  — biome.write/read
//   src/pc/common/PaletteContainer.js  — Single/Indirect/Direct
//   src/pc/common/BitArrayNoSpan.js  — bit-pack lеyaut
//
// API: parseDump(buffer, { numSections, maxBitsPerBlock, maxBitsPerBiome })
//      → { blockStates: Uint16Array(numSections*4096),
//          biomes: Uint8Array(numSections*64) }

'use strict'

const BLOCK_SECTION_VOLUME = 16 * 16 * 16            // 4096
const BIOME_SECTION_VOLUME = 4 * 4 * 4               // 64
const MAX_BITS_PER_BLOCK = 8                          // > etogo → direct (global)
const MAX_BITS_PER_BIOME = 3                          // > etogo → direct (global)

class Reader {
  constructor (buffer) {
    this.buf = buffer
    this.pos = 0
  }
  readUInt8 () { return this.buf.readUInt8(this.pos++) }
  readInt16BE () { const v = this.buf.readInt16BE(this.pos); this.pos += 2; return v }
  readUInt32BE () { const v = this.buf.readUInt32BE(this.pos); this.pos += 4; return v }
  readVarInt () {
    let result = 0, numRead = 0, read
    do {
      read = this.readUInt8()
      result |= (read & 0x7f) << (7 * numRead)
      if (++numRead > 5) throw new Error('varint too big')
    } while ((read & 0x80) !== 0)
    return result | 0  // sign-extend kak v varInt.read
  }
  remaining () { return this.buf.length - this.pos }
}

// BitArray (NoSpan) get(index): zerkalit BitArrayNoSpan.get
// data — Uint32Array, longs hranyatsya kak [low32, high32] na long, no v indeksacii
// data[i*2] = low, data[i*2+1] = high.
function bitArrayGet (data, bitsPerValue, valuesPerLong, valueMask, index) {
  const startLongIndex = (index / valuesPerLong) | 0
  const indexInLong = (index - startLongIndex * valuesPerLong) * bitsPerValue
  if (indexInLong >= 32) {
    const indexInStartLong = indexInLong - 32
    const startLong = data[startLongIndex * 2 + 1]
    return (startLong >>> indexInStartLong) & valueMask
  }
  const indexInStartLong = indexInLong
  const startLong = data[startLongIndex * 2]
  let result = startLong >>> indexInStartLong
  const endBitOffset = indexInStartLong + bitsPerValue
  if (endBitOffset > 32) {
    const endLong = data[startLongIndex * 2 + 1]
    result |= endLong << (32 - indexInStartLong)
  }
  return result & valueMask
}

// Schitaet longs uint32-py iz reader'a (po 2 uint32 na long, vysokaya pol uchivaetsya pervoi).
function readBitArrayLongs (reader, longs) {
  const data = new Uint32Array(longs * 2)
  for (let i = 0; i < longs * 2; i += 2) {
    data[i + 1] = reader.readUInt32BE()  // high
    data[i] = reader.readUInt32BE()      // low
  }
  return data
}

// Parsit odnu palette-section'u (block ili biome).
// Vozvraschaet funktsiyu (index→stateId).
function parseContainer (reader, opts) {
  const { capacity, maxBitsLocal, globalBits, minBits } = opts
  const bitsPerValue = reader.readUInt8()

  // SingleValueContainer: bitsPerValue == 0
  if (bitsPerValue === 0) {
    const value = reader.readVarInt()
    reader.readUInt8()  // size prefix = 0 (vsegda 1 bayt v ne-1.21.5+ fork-e)
    return { kind: 'single', value, get: () => value }
  }

  // Direct: bitsPerValue > maxBitsLocal → ispolzuetsya globalBits dlya BitArray
  if (bitsPerValue > maxBitsLocal) {
    const longs = reader.readVarInt()
    const data = readBitArrayLongs(reader, longs)
    const valuesPerLong = (64 / globalBits) | 0
    const valueMask = (1 << globalBits) - 1
    return {
      kind: 'direct',
      bitsPerValue: globalBits,
      get: (i) => bitArrayGet(data, globalBits, valuesPerLong, valueMask, i),
    }
  }

  // Indirect: lokalnaya palitra
  const paletteLen = reader.readVarInt()
  const palette = new Array(paletteLen)
  for (let i = 0; i < paletteLen; i++) palette[i] = reader.readVarInt()

  const longs = reader.readVarInt()
  const data = readBitArrayLongs(reader, longs)
  // BitArray.set/get zaversheny dlya tochno togo bitsPerValue, kotoroe my prochli
  const valuesPerLong = (64 / bitsPerValue) | 0
  const valueMask = (1 << bitsPerValue) - 1
  return {
    kind: 'indirect',
    bitsPerValue,
    palette,
    get: (i) => palette[bitArrayGet(data, bitsPerValue, valuesPerLong, valueMask, i)],
  }
}

function parseSection (reader, maxBitsPerBlock) {
  const solidBlockCount = reader.readInt16BE()  // ne ispolzuetsya, no nuzhno proitti
  const container = parseContainer(reader, {
    capacity: BLOCK_SECTION_VOLUME,
    maxBitsLocal: MAX_BITS_PER_BLOCK,
    globalBits: maxBitsPerBlock,
    minBits: 4,
  })
  const out = new Uint16Array(BLOCK_SECTION_VOLUME)
  for (let i = 0; i < BLOCK_SECTION_VOLUME; i++) out[i] = container.get(i)
  return { solidBlockCount, container, out }
}

function parseBiome (reader, maxBitsPerBiome) {
  const container = parseContainer(reader, {
    capacity: BIOME_SECTION_VOLUME,
    maxBitsLocal: MAX_BITS_PER_BIOME,
    globalBits: maxBitsPerBiome,
    minBits: 1,
  })
  const out = new Uint8Array(BIOME_SECTION_VOLUME)
  for (let i = 0; i < BIOME_SECTION_VOLUME; i++) out[i] = container.get(i)
  return { container, out }
}

function parseDump (buffer, meta) {
  const { numSections, maxBitsPerBlock, maxBitsPerBiome } = meta
  const reader = new Reader(buffer)

  const blockStates = new Uint16Array(numSections * BLOCK_SECTION_VOLUME)
  const biomes = new Uint8Array(numSections * BIOME_SECTION_VOLUME)

  for (let s = 0; s < numSections; s++) {
    const sec = parseSection(reader, maxBitsPerBlock)
    blockStates.set(sec.out, s * BLOCK_SECTION_VOLUME)

    const bi = parseBiome(reader, maxBitsPerBiome)
    biomes.set(bi.out, s * BIOME_SECTION_VOLUME)
  }

  return { blockStates, biomes, bytesRead: reader.pos, bytesTotal: buffer.length }
}

module.exports = { parseDump, parseSection, parseBiome, Reader, bitArrayGet }

// CLI: node parseDump-1.18.cjs <fixture.json>
if (require.main === module) {
  const fs = require('fs')
  const path = require('path')
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node parseDump-1.18.cjs <fixture.json>')
    process.exit(2)
  }
  const fix = JSON.parse(fs.readFileSync(file, 'utf8'))
  const dump = Buffer.from(fix.dump_b64, 'base64')
  const r = parseDump(dump, fix.meta)
  console.log(`parsed ${path.basename(file)}: bytes ${r.bytesRead}/${r.bytesTotal}, blockStates len=${r.blockStates.length}, biomes len=${r.biomes.length}`)
}
