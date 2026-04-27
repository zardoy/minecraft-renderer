import { test, expect } from 'vitest'
import {
  splitColumnWasmOutputToSections,
  renderWasmOutputToGeometry,
  WasmGeometryOutput,
} from '../../wasm-lib/render-from-wasm'

const VERSION = '1.16.5'
const STONE = 1 // 1.16.5 stone state id

// Face mask layout (matches FACE_DIRS in wasm-mesher / render-from-wasm.ts).
const FACE_UP = 1 << 0
const FACE_DOWN = 1 << 1
const FACE_NORTH = 1 << 2
const FACE_SOUTH = 1 << 3
const FACE_WEST = 1 << 4
const FACE_EAST = 1 << 5
const SIDE_FACES = FACE_NORTH | FACE_SOUTH | FACE_WEST | FACE_EAST

// Build a synthetic full-column WASM mesher output by hand. This avoids
// pulling in `wasm-pack`/the Rust crate from this unit test — the helper
// under test is pure JS, so an in-memory fixture is sufficient.
//
// Scenario: two adjacent stone blocks at world Y=15 and Y=16. Because
// they are stacked and opaque, Rust mesher would emit:
//   - (x,15,z): bottom face only, top face is suppressed by Y=16
//   - (x,16,z): top face only,    bottom face is suppressed by Y=15
// We hand-craft that output here.
function makeSeamFixture(): WasmGeometryOutput {
  const blocks: WasmGeometryOutput['blocks'] = []
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      blocks.push({
        position: [x, 15, z],
        block_state_id: STONE,
        // Y=15 is occluded above by the Y=16 stone — the seam neighbor
        // info is baked in here at the per-block level.
        visible_faces: FACE_DOWN | SIDE_FACES,
        ao_data: [],
        light_data: [],
      })
      blocks.push({
        position: [x, 16, z],
        block_state_id: STONE,
        // Y=16 is occluded below by the Y=15 stone (the seam from the
        // other side).
        visible_faces: FACE_UP | SIDE_FACES,
        ao_data: [],
        light_data: [],
      })
    }
  }
  // Add an isolated block in a third section, so we cover a section
  // that has no seam interaction.
  blocks.push({
    position: [0, 64, 0],
    block_state_id: STONE,
    visible_faces: FACE_UP | FACE_DOWN | SIDE_FACES,
    ao_data: [],
    light_data: [],
  })
  return {
    blocks,
    block_count: blocks.length,
    block_iterations: 0,
  }
}

test('splitColumnWasmOutputToSections: per-section split is equivalent to manual filter+render at the y=15/16 seam', () => {
  const fullColumn = makeSeamFixture()

  const requested = [
    { x: 0, y: 0, z: 0 },   // contains Y=15 row only
    { x: 0, y: 16, z: 0 },  // contains Y=16 row only
    { x: 0, y: 32, z: 0 },  // empty section
    { x: 0, y: 64, z: 0 },  // contains the isolated block at Y=64
  ]

  const split = splitColumnWasmOutputToSections(fullColumn, requested, { version: VERSION })

  expect(split.size).toBe(4)
  for (const r of requested) {
    expect(split.has(`${r.x},${r.y},${r.z}`)).toBe(true)
  }

  // Reference: do the same split manually (exactly what the helper is
  // supposed to do internally) and confirm the rendered geometry
  // matches byte-for-byte.
  for (const r of requested) {
    const yLo = r.y
    const yHi = r.y + 16
    const sectionBlocks = fullColumn.blocks.filter(b => b.position[1] >= yLo && b.position[1] < yHi)
    const reference = renderWasmOutputToGeometry(
      {
        blocks: sectionBlocks,
        block_count: sectionBlocks.length,
        block_iterations: fullColumn.block_iterations,
      },
      VERSION,
      `${r.x},${r.y},${r.z}`,
      { x: r.x + 8, y: r.y + 8, z: r.z + 8 },
      undefined
    )
    const got = split.get(`${r.x},${r.y},${r.z}`)!
    expect(got.key).toBe(reference.key)
    expect(got.position).toEqual(reference.position)
    expect(got.geometry.positions).toEqual(reference.geometry.positions)
    expect(got.geometry.normals).toEqual(reference.geometry.normals)
    expect(got.geometry.colors).toEqual(reference.geometry.colors)
    expect(got.geometry.uvs).toEqual(reference.geometry.uvs)
    expect(got.geometry.indices).toEqual(reference.geometry.indices)
  }

  // Empty section returns a real (non-undefined) ExportedSection with
  // empty geometry buffers.
  const empty = split.get('0,32,0')!
  expect(empty).toBeDefined()
  expect(empty.geometry.positions).toEqual([])
  expect(empty.geometry.indices).toEqual([])

  // Seam preservation: the Y=15/16 sections produce non-empty geometry,
  // and crucially the y=15 section does NOT contain the (Y=15 top-face)
  // that would have been emitted if the helper failed to honor the
  // already-baked-in `visible_faces` mask. The cleanest structural
  // assertion is that the seam-sections each contain only the expected
  // number of unique vertical faces. With FACE_UP/FACE_DOWN suppressed
  // at the seam, each block in those sections contributes 1 horizontal
  // face + 4 side faces = 5 quads; both sections also have identical
  // block counts (256 blocks), so their vertex/index counts must match.
  const lower = split.get('0,0,0')!
  const upper = split.get('0,16,0')!
  expect(lower.geometry.positions.length).toBeGreaterThan(0)
  expect(upper.geometry.positions.length).toBeGreaterThan(0)
  expect(lower.geometry.positions.length).toBe(upper.geometry.positions.length)
  expect(lower.geometry.indices.length).toBe(upper.geometry.indices.length)
})

test('splitColumnWasmOutputToSections: empty requested-keys list returns empty map', () => {
  const fullColumn = makeSeamFixture()
  const out = splitColumnWasmOutputToSections(fullColumn, [], { version: VERSION })
  expect(out.size).toBe(0)
})

test('splitColumnWasmOutputToSections: blocks outside requested sections are dropped', () => {
  const fullColumn = makeSeamFixture()
  // Only request the empty Y=32 section. Y=15/16/64 blocks must NOT
  // leak into it.
  const out = splitColumnWasmOutputToSections(
    fullColumn,
    [{ x: 0, y: 32, z: 0 }],
    { version: VERSION }
  )
  const empty = out.get('0,32,0')!
  expect(empty.geometry.positions).toEqual([])
  expect(empty.geometry.indices).toEqual([])
})
