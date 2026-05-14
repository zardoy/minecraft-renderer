#!/usr/bin/env node
/* eslint-disable */
// Conformance harness: gonyaem parseDump-1.18 protiv reference-dannyh iz fixtures.
// Vyvodit po kazhdomu fixture: bytes consumed, OK / FAIL po blockStates i biomes.
//
// Zapuskat: node chunk-packet-fixtures/harness.cjs

'use strict'

const fs = require('fs')
const path = require('path')
const { parseDump } = require('./parseDump-1.18.cjs')
const { parseLight } = require('./parseLight-1.18.cjs')

const FIXTURES_DIR = path.join(__dirname, 'fixtures')

function diffArrays (a, b, label, maxShow = 5) {
  if (a.length !== b.length) {
    return { ok: false, msg: `${label}: length mismatch ${a.length} vs ${b.length}` }
  }
  const diffs = []
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      diffs.push({ i, a: a[i], b: b[i] })
      if (diffs.length >= maxShow) break
    }
  }
  if (diffs.length === 0) return { ok: true }
  // poschitaem total
  let total = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) total++
  return {
    ok: false,
    msg: `${label}: ${total} mismatches (showing ${diffs.length}): ${diffs.map(d => `[${d.i}] ${d.a}≠${d.b}`).join(', ')}`,
  }
}

// Pereraskladyvaem reference (poryadok generator: y, z, x ot minY) v section-layout parsera:
// out[s * 4096 + (yIn << 8) | (z << 4) | x]
function reorderReferenceToSectionLayout (refArr, meta, ArrType) {
  const { numSections } = meta
  const out = new ArrType(numSections * 4096)
  for (let s = 0; s < numSections; s++) {
    for (let yIn = 0; yIn < 16; yIn++) {
      const yAbs = (s * 16) + yIn
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          const refIdx = yAbs * 256 + z * 16 + x
          const dstIdx = (s * 4096) + ((yIn << 8) | (z << 4) | x)
          out[dstIdx] = refArr[refIdx]
        }
      }
    }
  }
  return out
}

// Reference biomes from generator: poryadok (y, z, x) s shagom 4
//   for y in [minY..minY+H) step 4: for z in 0..16 step 4: for x in 0..16 step 4
// Parser daet biomes v poryadke: s=0..numSections, biomeIndex = (y_in_sec_4 << 4) | (z_4 << 2) | x_4
function reorderReferenceBiomes (refBiomes, meta) {
  const { numSections } = meta
  const biomeOut = new Uint8Array(numSections * 64)
  for (let s = 0; s < numSections; s++) {
    for (let yIn4 = 0; yIn4 < 4; yIn4++) {
      const yAbs4 = s * 4 + yIn4
      for (let z4 = 0; z4 < 4; z4++) {
        for (let x4 = 0; x4 < 4; x4++) {
          const refIdx = yAbs4 * 16 + z4 * 4 + x4
          const dstIdx = (s * 64) + ((yIn4 << 4) | (z4 << 2) | x4)
          biomeOut[dstIdx] = refBiomes[refIdx]
        }
      }
    }
  }
  return biomeOut
}

function runFixture (file) {
  const fix = JSON.parse(fs.readFileSync(file, 'utf8'))
  const dump = Buffer.from(fix.dump_b64, 'base64')

  // Reference typed-array iz base64. Sozdaem cherez Buffer kopiyu chtoby vyrovnyat alignement.
  const refBlocksBuf = Buffer.from(fix.reference.blockStates_b64, 'base64')
  const refBlockStates = new Uint16Array(refBlocksBuf.buffer.slice(refBlocksBuf.byteOffset, refBlocksBuf.byteOffset + refBlocksBuf.byteLength))
  const refBlockLight = new Uint8Array(Buffer.from(fix.reference.blockLight_b64, 'base64'))
  const refSkyLight = new Uint8Array(Buffer.from(fix.reference.skyLight_b64, 'base64'))
  const refBiomes = new Uint8Array(Buffer.from(fix.reference.biomes_b64, 'base64'))

  let parsed
  try {
    parsed = parseDump(dump, fix.meta)
  } catch (e) {
    return { name: fix.name, error: `parseDump threw: ${e.message}` }
  }

  let parsedLight
  try {
    parsedLight = parseLight(fix.light, fix.meta)
  } catch (e) {
    return { name: fix.name, error: `parseLight threw: ${e.message}` }
  }

  const blockOut = reorderReferenceToSectionLayout(refBlockStates, fix.meta, Uint16Array)
  const blockLightOut = reorderReferenceToSectionLayout(refBlockLight, fix.meta, Uint8Array)
  const skyLightOut = reorderReferenceToSectionLayout(refSkyLight, fix.meta, Uint8Array)
  const biomeRefReordered = reorderReferenceBiomes(refBiomes, fix.meta)

  const r1 = diffArrays(parsed.blockStates, blockOut, 'blockStates')
  const r2 = diffArrays(parsed.biomes, biomeRefReordered, 'biomes')
  const r3 = diffArrays(parsedLight.blockLight, blockLightOut, 'blockLight')
  const r4 = diffArrays(parsedLight.skyLight, skyLightOut, 'skyLight')

  return {
    name: fix.name,
    bytes: `${parsed.bytesRead}/${parsed.bytesTotal}`,
    blockStatesOK: r1.ok,
    biomesOK: r2.ok,
    blockLightOK: r3.ok,
    skyLightOK: r4.ok,
    msgs: [r1, r2, r3, r4].filter(r => !r.ok).map(r => r.msg),
  }
}

function main () {
  const files = fs.readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('_'))
    .map(f => path.join(FIXTURES_DIR, f))

  let pass = 0, fail = 0
  for (const f of files) {
    const r = runFixture(f)
    const allOk = r.blockStatesOK && r.biomesOK && r.blockLightOK && r.skyLightOK
    const status = allOk ? 'PASS' : 'FAIL'
    if (status === 'PASS') pass++; else fail++
    console.log(`[${status}] ${r.name.padEnd(32)} bytes=${r.bytes ?? '?'}  blocks=${r.blockStatesOK?'✓':'✗'} biomes=${r.biomesOK?'✓':'✗'} blockLight=${r.blockLightOK?'✓':'✗'} skyLight=${r.skyLightOK?'✓':'✗'}`)
    if (r.error) console.log(`        error: ${r.error}`)
    for (const m of (r.msgs ?? [])) console.log(`        ${m}`)
  }
  console.log(`\n${pass}/${pass + fail} fixtures passed.`)
  process.exit(fail === 0 ? 0 : 1)
}

main()
