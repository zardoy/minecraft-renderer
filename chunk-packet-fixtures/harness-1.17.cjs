#!/usr/bin/env node
/* eslint-disable */
// Conformance harness for the 1.17 prototype parser.
// Diffs parseDump-1.17 output (and dumpLight-style data) against the
// reference typed-arrays in fixtures-1.17/.
//
// Run: node chunk-packet-fixtures/harness-1.17.cjs

'use strict'

const fs = require('fs')
const path = require('path')
const { parseDump } = require('./parseDump-1.17.cjs')

const FIXTURES_DIR = path.join(__dirname, 'fixtures-1.17')

function diffArrays (a, b, label, maxShow = 5) {
  if (a.length !== b.length) {
    return { ok: false, msg: `${label}: length mismatch ${a.length} vs ${b.length}` }
  }
  const diffs = []
  let total = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      total++
      if (diffs.length < maxShow) diffs.push({ i, a: a[i], b: b[i] })
    }
  }
  if (total === 0) return { ok: true }
  return {
    ok: false,
    msg: `${label}: ${total} mismatches (showing ${diffs.length}): ${diffs.map(d => `[${d.i}] ${d.a}≠${d.b}`).join(', ')}`,
  }
}

// Generator order (in fixture reference): for y in [minY..minY+H), for z in 0..16, for x in 0..16
// Parser order: per-section flat array, idx = (yIn << 8) | (z << 4) | x, sections stacked.
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

function bufToTyped (b64, Ctor) {
  const buf = Buffer.from(b64, 'base64')
  // Copy to align to typed-array element size.
  const ab = new ArrayBuffer(buf.byteLength)
  Buffer.from(ab).set(buf)
  return new Ctor(ab)
}

function runFixture (file) {
  const fix = JSON.parse(fs.readFileSync(file, 'utf8'))
  const chunkData = Buffer.from(fix.chunkData_b64, 'base64')

  const refBlockStates = bufToTyped(fix.reference.blockStates_b64, Uint16Array)

  let parsed
  try {
    parsed = parseDump(chunkData, fix.bitMap_long, fix.meta)
  } catch (e) {
    return { name: fix.name, error: `parseDump threw: ${e.message}` }
  }

  const blockOut = reorderReferenceToSectionLayout(refBlockStates, fix.meta, Uint16Array)
  const r1 = diffArrays(parsed.blockStates, blockOut, 'blockStates')

  return {
    name: fix.name,
    bytes: `${parsed.bytesRead}/${parsed.bytesTotal}`,
    blockStatesOK: r1.ok,
    msgs: [r1].filter(r => !r.ok).map(r => r.msg),
  }
}

function main () {
  const files = fs.readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('_'))
    .sort()
    .map(f => path.join(FIXTURES_DIR, f))

  let pass = 0, fail = 0
  for (const f of files) {
    const r = runFixture(f)
    const allOk = r.blockStatesOK
    const status = allOk ? 'PASS' : 'FAIL'
    if (status === 'PASS') pass++; else fail++
    console.log(`[${status}] ${(r.name ?? path.basename(f)).padEnd(36)} bytes=${r.bytes ?? '?'}  blocks=${r.blockStatesOK?'✓':'✗'}`)
    if (r.error) console.log(`        error: ${r.error}`)
    for (const m of (r.msgs ?? [])) console.log(`        ${m}`)
  }
  console.log(`\n${pass}/${pass + fail} fixtures passed.`)
  process.exit(fail === 0 ? 0 : 1)
}

main()
