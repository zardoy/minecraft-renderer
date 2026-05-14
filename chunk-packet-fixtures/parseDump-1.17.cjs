#!/usr/bin/env node
/* eslint-disable */
// JS-prototype dump parser for Minecraft 1.17 chunk sections.
// Validates our understanding of the 1.17 packet wire format before we
// commit to the Rust port.
//
// Mirrors prismarine-chunk:
//   src/pc/1.17/ChunkColumn.js  — load(data, bitMap)
//   src/pc/common/BitArray.js   — note: 1.17 uses BitArray (spanning),
//                                  not BitArrayNoSpan like 1.18.
//
// API: parseDump(chunkData, bitMapLong, { numSections, maxBitsPerBlock })
//      → { blockStates: Uint16Array(numSections * 4096), bytesRead, bytesTotal }

'use strict'

const BLOCK_SECTION_VOLUME = 16 * 16 * 16   // 4096
const MAX_BITS_PER_BLOCK = 8                 // > this → global (direct) palette

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
    return result | 0
  }
}

// 1.17 ChunkColumn imports BitArrayNoSpan under the alias "BitArray"
// (see prismarine-chunk src/pc/1.17/ChunkColumn.js line 2). Despite the
// 1.17 ChunkColumn.js calling `bitArray.readBuffer(SmartBuffer.fromBuffer(sectionReader))`
// for light, blocks use a NoSpan layout where each long holds
// floor(64/bpv) values and the rest of the bits are padding. Our get()
// must mirror BitArrayNoSpan.get(): values never span a long boundary.
//
// Underlying data layout (after readBuffer reads BE longs as (hi_u32, lo_u32)):
//   data[2k]   = lo of long k
//   data[2k+1] = hi of long k
function bitArrayGet (data, bitsPerValue, valuesPerLong, valueMask, index) {
  const startLongIndex = (index / valuesPerLong) | 0
  const indexInLong = (index - startLongIndex * valuesPerLong) * bitsPerValue
  if (indexInLong >= 32) {
    const indexInStartLong = indexInLong - 32
    const startLong = data[startLongIndex * 2 + 1]   // hi
    return (startLong >>> indexInStartLong) & valueMask
  }
  const indexInStartLong = indexInLong
  const startLong = data[startLongIndex * 2]         // lo
  let result = startLong >>> indexInStartLong
  const endBitOffset = indexInStartLong + bitsPerValue
  if (endBitOffset > 32) {
    const endLong = data[startLongIndex * 2 + 1]     // hi of same long
    result |= endLong << (32 - indexInStartLong)
  }
  return result & valueMask
}

// Reads `longs` long-values from the reader as BE pairs of (hi, lo) and
// stores them flat as Uint32Array of length `longs*2` with [lo, hi, lo, hi, ...]
// to match prismarine BitArray.readBuffer layout.
function readBitArrayLongs (reader, longs) {
  const data = new Uint32Array(longs * 2)
  for (let i = 0; i < longs * 2; i += 2) {
    data[i + 1] = reader.readUInt32BE()  // high
    data[i] = reader.readUInt32BE()      // low
  }
  return data
}

function parseSection (reader, maxBitsPerBlock) {
  const solidBlockCount = reader.readInt16BE()      // unused, kept for offset
  const bitsPerBlock = reader.readUInt8()

  // Indirect / single — local palette.
  // Single is a 0-bit palette in some upstreams; in zardoy fork we expect
  // bitsPerBlock to be at least 4 (snapped up). We follow the same threshold
  // logic as the upstream loader: if bitsPerBlock <= MAX_BITS_PER_BLOCK,
  // there is a local palette; otherwise the global palette is used and
  // BitArray uses `maxBitsPerBlock` as its bitsPerValue.
  let palette = null
  let bitsPerValueForData = bitsPerBlock
  if (bitsPerBlock <= MAX_BITS_PER_BLOCK) {
    const numPaletteItems = reader.readVarInt()
    palette = new Array(numPaletteItems)
    for (let i = 0; i < numPaletteItems; i++) palette[i] = reader.readVarInt()
  } else {
    bitsPerValueForData = maxBitsPerBlock
  }

  const dataLen = reader.readVarInt()  // number of longs
  const data = readBitArrayLongs(reader, dataLen)
  const valueMask = bitsPerValueForData === 32 ? 0xffffffff : ((1 << bitsPerValueForData) - 1)
  const valuesPerLong = (64 / bitsPerValueForData) | 0

  const out = new Uint16Array(BLOCK_SECTION_VOLUME)
  if (palette) {
    for (let i = 0; i < BLOCK_SECTION_VOLUME; i++) {
      const idx = bitArrayGet(data, bitsPerValueForData, valuesPerLong, valueMask, i)
      out[i] = palette[idx]
    }
  } else {
    for (let i = 0; i < BLOCK_SECTION_VOLUME; i++) {
      out[i] = bitArrayGet(data, bitsPerValueForData, valuesPerLong, valueMask, i)
    }
  }
  return { solidBlockCount, palette, bitsPerBlock, out }
}

// bitMapLong is the prismarine-shape long-array: Array<[hi, lo]> from BitArray.toLongArray()
// We test bit `s` (section index) by checking bit `s` across the flat stream.
function bitMapHas (bitMapLong, sectionIdx) {
  // toLongArray packs in bitsPerValue=1 mode; bit `s` lives in long `s>>>6`,
  // bit position `s & 63`. Each long is [hi, lo].
  const longIdx = sectionIdx >>> 6
  if (longIdx >= bitMapLong.length) return false
  const bitInLong = sectionIdx & 63
  const [hi, lo] = bitMapLong[longIdx]
  if (bitInLong < 32) return ((lo >>> bitInLong) & 1) === 1
  return ((hi >>> (bitInLong - 32)) & 1) === 1
}

function parseDump (chunkData, bitMapLong, meta) {
  const { numSections, maxBitsPerBlock } = meta
  const reader = new Reader(chunkData)
  const blockStates = new Uint16Array(numSections * BLOCK_SECTION_VOLUME)

  for (let s = 0; s < numSections; s++) {
    if (!bitMapHas(bitMapLong, s)) continue
    const sec = parseSection(reader, maxBitsPerBlock)
    blockStates.set(sec.out, s * BLOCK_SECTION_VOLUME)
  }

  return { blockStates, bytesRead: reader.pos, bytesTotal: chunkData.length }
}

module.exports = { parseDump, parseSection, Reader, bitArrayGet, bitMapHas }

// CLI: node parseDump-1.17.cjs <fixture.json>
if (require.main === module) {
  const fs = require('fs')
  const path = require('path')
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node parseDump-1.17.cjs <fixture.json>')
    process.exit(2)
  }
  const fix = JSON.parse(fs.readFileSync(file, 'utf8'))
  const dump = Buffer.from(fix.chunkData_b64, 'base64')
  const r = parseDump(dump, fix.bitMap_long, fix.meta)
  console.log(`parsed ${path.basename(file)}: bytes ${r.bytesRead}/${r.bytesTotal}, blockStates len=${r.blockStates.length}`)
}
