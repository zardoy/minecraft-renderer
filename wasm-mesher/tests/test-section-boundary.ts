/**
 * Synthetic-chunk regression fixtures for the WASM mesher.
 *
 * Stage 4 of issue #15. Two independent assertions:
 *
 *  1. Section-boundary culling — proves `section_data_start_y` correctly
 *     describes the offset of the data array relative to world-Y. If the
 *     offset is wrong, the WASM mesher will emit faces at the seam between
 *     two stacked solid blocks (visual seam bug).
 *
 *  2. Heightmap parity — the shared `computeHeightmap` helper produces the
 *     expected pattern, and is the single source of truth used by both the
 *     JS mesher (`mesher.ts`) and WASM mesher (`mesherWasm.ts`).
 */
import ChunkLoader, { PCChunk } from 'prismarine-chunk'
import { Vec3 } from 'vec3'
import * as wasm from '../pkg/wasm_mesher.js'
import { convertChunkToWasm } from '../../src/wasm-mesher/bridge/convertChunk'
import { World } from '../../src/mesher-shared/world'
import { computeHeightmap, handleGetHeightmap } from '../../src/mesher-shared/computeHeightmap'

const VERSION = '1.16.5'
const WORLD_MIN_Y = 0
const WORLD_MAX_Y = 256
const WORLD_HEIGHT = WORLD_MAX_Y - WORLD_MIN_Y
const STONE = 1 // 1.16.5 stone state id

// ---- Face-mask layout (matches FACE_DIRS in wasm-mesher Rust source / render-from-wasm.ts) ----
const FACE_UP = 1 << 0    // +Y
const FACE_DOWN = 1 << 1  // -Y

function makeChunk(): PCChunk {
  const Chunk = ChunkLoader(VERSION) as any
  const chunk = new Chunk({ minY: WORLD_MIN_Y, worldHeight: WORLD_HEIGHT, x: 0, z: 0 }) as PCChunk
  return chunk
}

function fillLayer(chunk: PCChunk, y: number, stateId: number) {
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      chunk.setBlockStateId(new Vec3(x, y, z), stateId)
    }
  }
}

function meshSection(chunk: PCChunk, sectionY: number, sectionHeight: number) {
  // Reproduce mesherWasm.ts's data-window expansion: ±1 in Y, clamped to world bounds.
  const sectionDataStartY = Math.max(sectionY - 1, WORLD_MIN_Y)
  const sectionDataEndY = Math.min(sectionY + sectionHeight + 1, WORLD_MAX_Y)
  const sectionDataHeight = sectionDataEndY - sectionDataStartY

  const conv = convertChunkToWasm(
    chunk,
    VERSION,
    0, 0,
    WORLD_MIN_Y, WORLD_MAX_Y,
    sectionDataStartY,
    sectionDataHeight
  )

  return wasm.generate_geometry(
    0, sectionY, 0, sectionHeight,
    WORLD_MIN_Y, WORLD_MAX_Y,
    sectionDataStartY,
    conv.blockStates, conv.blockLight, conv.skyLight, conv.biomesArray,
    conv.invisibleBlocks, conv.transparentBlocks, conv.noAoBlocks,
    conv.cullIdenticalBlocks, conv.occludingBlocks,
    true, false, 15
  )
}

function countFaces(result: any, predicate: (block: any) => boolean, faceMask: number): number {
  let count = 0
  for (const block of result.blocks) {
    if (!predicate(block)) continue
    if ((block.visible_faces & faceMask) !== 0) count++
  }
  return count
}

// ---------------------------------------------------------------------------
// Test 1 — section-boundary culling
// ---------------------------------------------------------------------------
function testSectionBoundary() {
  console.log('\n=== Section-boundary fixture ===')
  const chunk = makeChunk()
  fillLayer(chunk, 15, STONE) // top layer of lower section
  fillLayer(chunk, 16, STONE) // bottom layer of upper section

  // Lower section: y=0..15 inclusive. Mesh and count top-faces at y=15.
  const lower = meshSection(chunk, 0, 16)
  const topFacesAtSeamLower = countFaces(lower, b => b.position[1] === 15, FACE_UP)
  console.log(`  lower section: top faces emitted at y=15: ${topFacesAtSeamLower} (expected 0)`)
  console.log(`  lower section: total emitted blocks: ${lower.blocks.length}`)
  if (topFacesAtSeamLower !== 0) {
    throw new Error(
      `Section-boundary regression (lower): expected 0 top faces at y=15 (occluded by y=16 stone), got ${topFacesAtSeamLower}`
    )
  }

  // Upper section: y=16..31. Mesh and count bottom-faces at y=16.
  const upper = meshSection(chunk, 16, 16)
  const bottomFacesAtSeamUpper = countFaces(upper, b => b.position[1] === 16, FACE_DOWN)
  console.log(`  upper section: bottom faces emitted at y=16: ${bottomFacesAtSeamUpper} (expected 0)`)
  console.log(`  upper section: total emitted blocks: ${upper.blocks.length}`)
  if (bottomFacesAtSeamUpper !== 0) {
    throw new Error(
      `Section-boundary regression (upper): expected 0 bottom faces at y=16 (occluded by y=15 stone), got ${bottomFacesAtSeamUpper}`
    )
  }

  console.log('  ✅ Section-boundary fixture passed')
}

// ---------------------------------------------------------------------------
// Test 2 — heightmap parity
//
// This test asserts not just that `computeHeightmap` is correct, but that both
// `mesher.ts` and `mesherWasm.ts` `getHeightmap` handlers continue to call it
// (or any equivalent producing the same result). Any future refactor that
// inlines diverging logic in either handler will be caught here.
//
// Strategy:
//   1. Build a synthetic chunk with one known top block per (x,z).
//   2. Compute an INDEPENDENT reference heightmap by scanning the chunk's raw
//      block-state-ids top-down — not via `computeHeightmap`. This is the
//      structural ground truth.
//   3. Assert `computeHeightmap(world)` matches the reference (helper correct).
//   4. Source-grep both mesher files to assert their `getHeightmap` case body
//      still delegates to `computeHeightmap(world, …)` — if either handler is
//      ever inlined / diverges, the assertion fails loudly.
// ---------------------------------------------------------------------------
function testHeightmapParity() {
  console.log('\n=== Heightmap parity fixture ===')
  const chunk = makeChunk()

  // Deterministic synthetic terrain: one stone per (x,z) at varying Y, all else air.
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      const topY = 64 + ((x + z * 3) % 16)
      chunk.setBlockStateId(new Vec3(x, topY, z), STONE)
    }
  }

  // ---- Independent reference: plain triple loop over raw state-ids, NOT via computeHeightmap. ----
  const reference = new Int16Array(256)
  const probe = new Vec3(0, 0, 0)
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      let foundY = -32768
      for (let y = WORLD_MAX_Y - 1; y >= WORLD_MIN_Y; y--) {
        probe.x = x
        probe.y = y
        probe.z = z
        const id = chunk.getBlockStateId(probe)
        if (id !== 0 && id !== undefined && id !== null) {
          foundY = y
          break
        }
      }
      reference[z * 16 + x] = foundY
    }
  }

  // Build a World, inject the chunk directly (bypass fromJson round-trip).
  const buildWorld = () => {
    const w = new World(VERSION)
    w.config = { ...w.config, worldMinY: WORLD_MIN_Y, worldMaxY: WORLD_MAX_Y, version: VERSION }
    ;(w.columns as any)['0,0'] = chunk
    return w
  }

  // ---- Helper correctness: computeHeightmap matches the independent reference. ----
  const helperHeightmap = computeHeightmap(buildWorld(), 0, 0)
  for (let i = 0; i < 256; i++) {
    if (helperHeightmap[i] !== reference[i]) {
      throw new Error(
        `computeHeightmap mismatch at index ${i}: got ${helperHeightmap[i]}, expected ${reference[i]}`
      )
    }
  }

  // ---- Direct handler invocation: exercise the real worker entry point.
  // Both mesher.ts and mesherWasm.ts route their `case 'getHeightmap'` through
  // handleGetHeightmap(world, x, z). Invoking it here proves the handler logic
  // (compute + key formatting) actually runs and returns the expected payload —
  // not just that the handler source mentions the helper.
  const handlerOut = handleGetHeightmap(buildWorld(), 0, 0)
  if (handlerOut.key !== '0,0') {
    throw new Error(`handleGetHeightmap key mismatch: got "${handlerOut.key}", expected "0,0"`)
  }
  if (handlerOut.heightmap.length !== 256) {
    throw new Error(`handleGetHeightmap heightmap length: got ${handlerOut.heightmap.length}, expected 256`)
  }
  for (let i = 0; i < 256; i++) {
    if (handlerOut.heightmap[i] !== reference[i]) {
      throw new Error(
        `handleGetHeightmap mismatch at index ${i}: got ${handlerOut.heightmap[i]}, expected ${reference[i]}`
      )
    }
  }

  // ---- Handler-delegation guard: both mesher files must invoke handleGetHeightmap. ----
  // For `mesher.ts` (JS mesher) this guards the live `getHeightmap` worker case.
  // For `mesherWasm.ts` it guards the fallback path: the worker pushes heightmaps
  // from `processColumnTick` directly, but if `extractColumnHeightmap` returns
  // null (or the explicit `getHeightmap` case is hit as a safety net) the worker
  // must still route through `handleGetHeightmap(world, …)` so the JS reference
  // computation stays the single source of truth.
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  const checkHandler = (relPath: string, options?: { requireGetHeightmapCase?: boolean }) => {
    const requireCase = options?.requireGetHeightmapCase ?? true
    // __dirname = wasm-mesher/tests; repo root = ../..
    const src = fs.readFileSync(path.join(__dirname, '..', '..', relPath), 'utf8')
    if (requireCase && !/case\s+'getHeightmap'\s*:/.test(src)) {
      throw new Error(`${relPath}: no 'getHeightmap' case found — handler may have been removed/renamed`)
    }
    if (!/handleGetHeightmap\s*\(\s*world\s*,/.test(src)) {
      throw new Error(
        `${relPath}: handler no longer delegates to handleGetHeightmap(world, …). ` +
        `If you intentionally inlined the logic, update test-section-boundary.ts to assert the new path matches the independent reference.`
      )
    }
  }
  checkHandler('src/mesher-legacy/mesher.ts')
  checkHandler('src/wasm-mesher/worker/mesherWasm.ts')

  console.log(`  ✅ 256/256 entries match independent reference`)
  console.log(`  ✅ handleGetHeightmap direct invocation matches reference (key="${handlerOut.key}")`)
  console.log(`  ✅ both mesher-legacy/mesher.ts and wasm-mesher/worker/mesherWasm.ts getHeightmap handlers still delegate to handleGetHeightmap`)
  console.log(`     sample: [0]=${helperHeightmap[0]} [42]=${helperHeightmap[42]} [255]=${helperHeightmap[255]}`)
}

const main = async () => {
  testSectionBoundary()
  testHeightmapParity()
  console.log('\n✅ All boundary / heightmap fixtures passed')
}

main().catch(err => {
  console.error('❌ Fixture failure:', err)
  process.exit(1)
})
