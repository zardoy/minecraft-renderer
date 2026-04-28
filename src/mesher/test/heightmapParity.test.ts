import { test, expect } from 'vitest'
import Chunks from 'prismarine-chunk'
import MinecraftData from 'minecraft-data'
import { Vec3 } from 'vec3'
import { World } from '../world'
import { computeHeightmap } from '../computeHeightmap'
import { INVISIBLE_BLOCKS } from '../worldConstants'
import { extractColumnHeightmap, WasmGeometryOutput } from '../../wasm-lib/render-from-wasm'

// ---------------------------------------------------------------------------
// Heightmap parity test
//
// Verifies that the (future) Rust full-column heightmap (as exposed via the
// `extractColumnHeightmap` adapter) yields the same 256-entry Int16Array as
// the existing JS source-of-truth `computeHeightmap`, for representative
// chunk fixtures.
//
// Strategy:
//   1. Build a real `World` with known blocks.
//   2. Run the real JS `computeHeightmap` to get the reference.
//   3. Simulate Rust's full-column iteration in JS (mirroring
//      `wasm-mesher/src/mesher.rs::generate_with_world`: scan all
//      `(y, z, x)` over the full Y range, last write per `(x,z)` wins,
//      skipping blocks whose state IDs are in the `invisible_blocks`
//      set — equivalent to `INVISIBLE_BLOCKS` by name) and pack it into
//      a `WasmGeometryOutput.heightmap` field shaped exactly like Rust
//      returns it (`Vec<i16>` => plain `number[]`, length 256, indexed
//      `z*16+x`, sentinel `-32768`).
//   4. Run the simulated output through the SAME `extractColumnHeightmap`
//      adapter that the runtime uses, and assert element-wise equality
//      with the JS heightmap.
//
// If parity ever fails here, Rust heightmap usage in `mesherWasm.ts` MUST stay
// disabled and `getHeightmap` MUST keep using the JS handler.
// ---------------------------------------------------------------------------

const VERSION = '1.16.5'

type BlockSpec = { x: number, y: number, z: number, name: string }

function buildWorld(blocks: BlockSpec[]): { world: World, invisibleStateIds: Set<number> } {
  const mcData = MinecraftData(VERSION)
  const Chunk = Chunks(VERSION) as any
  const chunk = new Chunk(undefined as any)

  for (const b of blocks) {
    const id = mcData.blocksByName[b.name]?.defaultState
    if (id == null) throw new Error(`Unknown block name in fixture: ${b.name}`)
    chunk.setBlockStateId(new Vec3(b.x, b.y, b.z), id)
  }

  const world = new World(VERSION)
  // computeHeightmap requires worldMinY / worldMaxY on world.config; the
  // defaults (0..256) match the 1.16.5 chunk shape we're using here.
  world.addColumn(0, 0, chunk.toJson())

  // Build the invisible-state-ID set the way `convertChunkToWasm` does at
  // runtime: every state ID of every block whose name is in
  // INVISIBLE_BLOCKS. Used by the Rust simulation below.
  const invisibleStateIds = new Set<number>()
  for (const block of mcData.blocksArray) {
    if (!INVISIBLE_BLOCKS.has(block.name)) continue
    const min = block.minStateId ?? block.defaultState
    const max = block.maxStateId ?? block.defaultState
    for (let id = min; id <= max; id++) invisibleStateIds.add(id)
  }
  return { world, invisibleStateIds }
}

/**
 * JS port of `Mesher::generate_with_world` heightmap pass — bottom-up
 * iteration over the full column with last-write-wins per `(x,z)`.
 * Returns a plain `number[]` matching the on-the-wire shape of Rust's
 * `Vec<i16>` (length 256, indexed `z*16+x`, sentinel `-32768`).
 */
function simulateRustColumnHeightmap(
  world: World,
  invisibleStateIds: Set<number>,
  worldMinY: number,
  worldMaxY: number
): number[] {
  const heightmap = new Array<number>(256).fill(-32768)
  const column = world.getColumn(0, 0)
  if (!column) return heightmap

  const pos = new Vec3(0, 0, 0)
  for (let y = worldMinY; y < worldMaxY; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        pos.x = x
        pos.y = y
        pos.z = z
        const stateId = column.getBlockStateId(pos)
        if (stateId === 0 || invisibleStateIds.has(stateId)) continue
        heightmap[z * 16 + x] = y
      }
    }
  }
  return heightmap
}

function makeWasmOutputWithHeightmap(heightmap: number[]): WasmGeometryOutput {
  return {
    blocks: [],
    block_count: 0,
    block_iterations: 0,
    heightmap,
  }
}

function runParity(blocks: BlockSpec[]): { js: Int16Array, rust: Int16Array } {
  const { world, invisibleStateIds } = buildWorld(blocks)
  const js = computeHeightmap(world, 0, 0)

  const rustShaped = simulateRustColumnHeightmap(
    world,
    invisibleStateIds,
    world.config.worldMinY,
    world.config.worldMaxY
  )
  const wasmOutput = makeWasmOutputWithHeightmap(rustShaped)
  const rust = extractColumnHeightmap(wasmOutput)
  expect(rust).not.toBeNull()
  return { js, rust: rust! }
}

test('heightmap parity: flat stone layer at y=5', () => {
  const blocks: BlockSpec[] = []
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      blocks.push({ x, y: 5, z, name: 'stone' })
    }
  }
  const { js, rust } = runParity(blocks)
  expect(rust.length).toBe(256)
  expect(js.length).toBe(256)
  expect(Array.from(rust)).toEqual(Array.from(js))
  // Sanity: every column should report y=5.
  for (let i = 0; i < 256; i++) expect(js[i]).toBe(5)
})

test('heightmap parity: varied heights, every column populated (Rust == JS)', () => {
  // Fully-populated chunk (every (x,z) has at least one block) so we sidestep
  // the documented empty-column gap captured in the next test.
  const blocks: BlockSpec[] = []
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      // Default floor.
      blocks.push({ x, y: 5, z, name: 'stone' })
    }
  }
  // Layered overrides exercising mid/high/low surfaces and invisible-skipping.
  blocks.push({ x: 0, y: 64, z: 0, name: 'stone' })
  blocks.push({ x: 1, y: 70, z: 0, name: 'dirt' })
  blocks.push({ x: 2, y: 80, z: 0, name: 'oak_log' }) // top wins over y=64 below
  blocks.push({ x: 2, y: 64, z: 0, name: 'stone' })
  blocks.push({ x: 5, y: 255, z: 5, name: 'stone' }) // high-Y edge (worldMaxY-1)
  blocks.push({ x: 6, y: 0, z: 6, name: 'stone' })   // low-Y edge (worldMinY)
  // Invisible block above a real surface must be skipped on both sides.
  blocks.push({ x: 7, y: 10, z: 7, name: 'stone' })
  blocks.push({ x: 7, y: 11, z: 7, name: 'barrier' })
  blocks.push({ x: 8, y: 12, z: 8, name: 'stone' })
  blocks.push({ x: 8, y: 13, z: 8, name: 'cave_air' })

  const { js, rust } = runParity(blocks)
  expect(Array.from(rust)).toEqual(Array.from(js))

  // Spot-check absolute values so a future regression in either side
  // doesn't silently align them on a wrong shared value.
  expect(js[0 * 16 + 0]).toBe(64)
  expect(js[0 * 16 + 1]).toBe(70)
  expect(js[0 * 16 + 2]).toBe(80)
  expect(js[5 * 16 + 5]).toBe(255)
  expect(js[6 * 16 + 6]).toBe(5)  // y=0 stone is below the y=5 floor stone
  expect(js[7 * 16 + 7]).toBe(10) // barrier above must be skipped
  expect(js[8 * 16 + 8]).toBe(12) // cave_air above must be skipped
})

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Empty-column parity (post-alignment).
//
// Historically `computeHeightmap` returned `0` (== worldMinY) for a fully-
// empty column, because its loop reads at worldMinY, finds air (truthy block,
// name in INVISIBLE_BLOCKS), exits the `while` because `blockPos.y > worldMinY`
// becomes false, and fell through to `heightmap[index] = blockPos.y`
// (== worldMinY). Rust's mesher writes `-32768` for any column with no
// non-invisible block, so the two encodings disagreed and the WASM
// `getHeightmap` runtime switch was blocked on that gap.
//
// `computeHeightmap` has since been aligned: it now writes
// `EMPTY_COLUMN_HEIGHTMAP_SENTINEL` (-32768) for empty columns, matching
// Rust. This test pins that alignment so a regression can never silently
// re-introduce the divergence.
// ---------------------------------------------------------------------------
test('heightmap parity: empty columns produce the same sentinel (-32768) in JS and Rust', () => {
  // No blocks at all — fully empty chunk.
  const { js, rust } = runParity([])
  for (let i = 0; i < 256; i++) {
    expect(js[i]).toBe(-32768)
    expect(rust[i]).toBe(-32768)
  }
  expect(Array.from(rust)).toEqual(Array.from(js))
})

test('extractColumnHeightmap: returns null for missing or wrong-length heightmap (forces JS fallback)', () => {
  expect(extractColumnHeightmap({ heightmap: null })).toBeNull()
  expect(extractColumnHeightmap({})).toBeNull()
  expect(extractColumnHeightmap({ heightmap: [1, 2, 3] })).toBeNull()
  expect(extractColumnHeightmap(undefined)).toBeNull()
})

test('extractColumnHeightmap: accepts both number[] and Int16Array shapes', () => {
  const arr = new Array<number>(256).fill(-32768)
  arr[0] = 42
  const fromArr = extractColumnHeightmap({ heightmap: arr })!
  expect(fromArr).toBeInstanceOf(Int16Array)
  expect(fromArr[0]).toBe(42)
  expect(fromArr[1]).toBe(-32768)

  const typed = new Int16Array(256)
  typed.fill(-32768)
  typed[5] = 99
  const fromTyped = extractColumnHeightmap({ heightmap: typed })!
  expect(fromTyped).toBeInstanceOf(Int16Array)
  expect(fromTyped[5]).toBe(99)
  // Must be a copy, not aliased — runtime transfers the buffer to the
  // main thread and would otherwise detach the cached one.
  expect(fromTyped).not.toBe(typed)
})
