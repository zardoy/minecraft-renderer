#!/usr/bin/env node
/* eslint-disable */
// JS-prototype dlya light-dump 1.18+: raspakovyvaet skyLight/blockLight nibble-bufery
// (kazhdyi po 2048 bayt = 4096 nibbles) v Uint8Array(numSections * 4096).
//
// Format dumpLight():
//   {
//     skyLight: Uint8Array[],          // tolko non-null sekcii, po poryadku bitov maski
//     blockLight: Uint8Array[],        // analogichno
//     skyLightMask: number[][],        // long-array, kazhdyi element [high32, low32]
//     blockLightMask: number[][],
//     emptySkyLightMask, emptyBlockLightMask
//   }
// Maska imeet kapacity numSections+2: index 0 = below world, 1..numSections = real sections,
// numSections+1 = above world. Nas interesuyut tolko real sections.

'use strict'

const { bitArrayGet } = require('./parseDump-1.18.cjs')

const SECTION_VOLUME = 16 * 16 * 16
const LIGHT_BPV = 4
const LIGHT_VALUES_PER_LONG = 16  // 64 / 4
const LIGHT_VALUE_MASK = 0x0f

// Razvorachivaet long-array maski v Uint8Array bitov (po 1 bitu na element).
// Kazhdyi long [high, low] daet 64 bita (low first, naimladshii v low<<0).
function maskToBits (longArr, capacity) {
  const out = new Uint8Array(capacity)
  for (let i = 0; i < longArr.length; i++) {
    const [high, low] = longArr[i]
    for (let b = 0; b < 32; b++) {
      const idx = i * 64 + b
      if (idx < capacity) out[idx] = (low >>> b) & 1
    }
    for (let b = 0; b < 32; b++) {
      const idx = i * 64 + 32 + b
      if (idx < capacity) out[idx] = (high >>> b) & 1
    }
  }
  return out
}

// 2048 bayt → BitArray-NoSpan c bpv=4 i capacity=4096.
// Layout identichen blokam: writeBuffer pishet [data[i+1], data[i]] (high then low) BE.
function unpackLightSection (buffer) {
  if (buffer.length !== 2048) {
    throw new Error(`unexpected light buffer size ${buffer.length}, want 2048`)
  }
  // 2048 bayt = 512 uint32 (po 4 bayta).
  const data = new Uint32Array(512)
  for (let i = 0; i < 512; i += 2) {
    // BE: pervyi uint32 — high (data[i+1]), vtoroi — low (data[i]).
    data[i + 1] = buffer.readUInt32BE(i * 4)
    data[i]     = buffer.readUInt32BE(i * 4 + 4)
  }
  const out = new Uint8Array(SECTION_VOLUME)
  for (let i = 0; i < SECTION_VOLUME; i++) {
    out[i] = bitArrayGet(data, LIGHT_BPV, LIGHT_VALUES_PER_LONG, LIGHT_VALUE_MASK, i)
  }
  return out
}

function parseLight (light, meta) {
  const { numSections } = meta
  const maskCapacity = numSections + 2

  function expand (lightBuffersB64, longMask) {
    const bits = maskToBits(longMask, maskCapacity)
    const out = new Uint8Array(numSections * SECTION_VOLUME)
    let bufferIdx = 0
    for (let i = 0; i < maskCapacity; i++) {
      if (!bits[i]) continue
      const realSectionIdx = i - 1  // i=0 — below world, i=numSections+1 — above world
      const buf = Buffer.from(lightBuffersB64[bufferIdx++], 'base64')
      if (realSectionIdx >= 0 && realSectionIdx < numSections) {
        const unpacked = unpackLightSection(buf)
        out.set(unpacked, realSectionIdx * SECTION_VOLUME)
      }
    }
    if (bufferIdx !== lightBuffersB64.length) {
      throw new Error(`mask says ${bufferIdx} sections but got ${lightBuffersB64.length} buffers`)
    }
    return out
  }

  return {
    skyLight: expand(light.skyLight_b64, light.skyLightMask),
    blockLight: expand(light.blockLight_b64, light.blockLightMask),
  }
}

module.exports = { parseLight, maskToBits, unpackLightSection }
