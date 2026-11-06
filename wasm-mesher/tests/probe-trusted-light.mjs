// Run after pnpm build:wasm: node wasm-mesher/tests/probe-trusted-light.mjs [columns]
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { initSync, JsLightEngine } from '../../src/wasm-mesher/runtime-build/wasm_mesher.js'
initSync({ module: readFileSync(new URL('../../src/wasm-mesher/runtime-build/wasm_mesher_bg.wasm', import.meta.url)) })
const K = Number(process.argv[2] ?? 400)
const e = new JsLightEngine(0, 256)
e.setLightTables(new Uint8Array([0, 0, 14]), new Uint8Array([0, 15, 0]))
e.setSkyLightEnabled(true)
const load = (sx, sz) => {
  // A trusted padding section seeds the omitted-section repeat rule.
  e.pushEvent({ type: 'serverLight', sx, sy: 16, sz, channel: 'sky', kind: 'data', trusted: true, data: new Uint8Array(2048).fill(255) })
  for (let sy = 0; sy < 16; sy++) {
    e.pushEvent({ type: 'ingestBlockSection', sx, sy, sz, states: new Uint16Array(4096) })
    e.pushEvent({ type: 'setAvailability', sx, sy, sz, availability: 'loaded' })
  }
}
const neighborMode = process.argv[3] === 'neighbor'
const side = Math.ceil(Math.sqrt(K))
if (neighborMode) {
  load(0, 0)
  while (e.step(5)) e.pollCompletedPublication()
  e.pollCompletedPublication()
}
for (let i = 0; i < K; i++) load((i % side) + (neighborMode ? 10 : 0), Math.floor(i / side))
if (neighborMode) load(1, 0)
const editX = neighborMode ? 15 : 8
e.pushEvent({ type: 'blockChange', x: editX, y: 72, z: 8, stateId: 2 })
const start = performance.now()
let editLatencyMs = null
let neighborLatencyMs = null
let neighborPublication = null
let publications = 0
let dirtySections = 0
let calls = 0
for (; calls < 200000; calls++) {
  const remaining = e.step(5)
  const p = e.pollCompletedPublication()
  if (p) {
    publications++
    dirtySections += p.dirtyMeshSections.length / 3
    if (editLatencyMs == null && e.getBlockLight(editX, 72, 8) === 14) editLatencyMs = performance.now() - start
    if (neighborMode && neighborLatencyMs == null && e.getBlockLight(16, 72, 8) === 13) {
      neighborLatencyMs = performance.now() - start
      neighborPublication = publications
    }
  }
  if (!remaining) break
}
const totalMs = performance.now() - start
if (e.fallbackRelights !== 0 || e.getBlockLight(editX, 72, 8) !== 14 || editLatencyMs == null) throw new Error('trusted path failed')
if (neighborMode && (neighborPublication == null || neighborPublication > 2)) throw new Error('trusted neighbor convoy regression')
console.log(JSON.stringify({ K, trusted: true, neighborMode, editLatencyMs, neighborLatencyMs, neighborPublication, totalMs, msPerColumn: totalMs / K, publications, dirtySections, calls: calls + 1, fallbackRelights: e.fallbackRelights }))
e.free()
