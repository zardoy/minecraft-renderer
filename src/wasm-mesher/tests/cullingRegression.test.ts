import { test, expect, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Chunks from 'prismarine-chunk'
import MinecraftData from 'minecraft-data'
import { Vec3 } from 'vec3'
import PrismarineBlockLoader from 'prismarine-block'
import blocksAtlasesJson from 'mc-assets/dist/blocksAtlases.json'
import blockStatesModels from 'mc-assets/dist/blockStatesModels.json'
import { World } from '../../mesher-shared/world'
import { setBlockStatesData, getSectionGeometry } from '../../mesher-shared/models'
import { resetFaceOcclusionCache } from '../../mesher-shared/faceOcclusion'
import { convertChunkToWasm } from '../bridge/convertChunk'
import { renderWasmOutputToGeometry } from '../bridge/render-from-wasm'

const VERSION = '1.18.2'
const SECTION_Y = 0
const SECTION_HEIGHT = 16

const DRY_STAIR_PROPS = { facing: 'east', half: 'bottom', shape: 'straight', waterlogged: false } as const

type BlockSpec = { x: number; y: number; z: number; name: string; props?: Record<string, string | boolean> }

let wasmModule: typeof import('../runtime-build/wasm_mesher.js')

beforeAll(async () => {
  wasmModule = await import('../runtime-build/wasm_mesher.js')
  const wasmDir = dirname(fileURLToPath(import.meta.url))
  const wasmBytes = readFileSync(join(wasmDir, '../runtime-build/wasm_mesher_bg.wasm'))
  wasmModule.initSync(wasmBytes)
})

beforeEach(() => {
  resetFaceOcclusionCache()
  const mcData = MinecraftData(VERSION)
  setBlockStatesData(blockStatesModels, blocksAtlasesJson, false, true, VERSION, { blocks: mcData.blocksArray })
  ;(globalThis as any).__wasmBlockModelCache = new Map()
})

function resolveStateId(mcData: ReturnType<typeof MinecraftData>, name: string, props?: Record<string, string | boolean>) {
  const block = mcData.blocksByName[name]
  if (!block) throw new Error(`Unknown block: ${name}`)
  if (!props || Object.keys(props).length === 0) return block.defaultState
  const Block = PrismarineBlockLoader(VERSION)
  const requested = { ...props }
  if (!('waterlogged' in requested)) requested.waterlogged = false

  const matches: number[] = []
  for (let id = block.minStateId; id <= block.maxStateId; id++) {
    const stateProps = Block.fromStateId(id, 1).getProperties() as Record<string, string | boolean>
    let match = true
    for (const [key, val] of Object.entries(requested)) {
      if (stateProps[key] !== val) {
        match = false
        break
      }
    }
    if (match) matches.push(id)
  }
  if (matches.length === 0) throw new Error(`No state for ${name} ${JSON.stringify(props)}`)
  return matches[0]!
}

function buildWorld(blocks: BlockSpec[]): World {
  const mcData = MinecraftData(VERSION)
  const Chunk = Chunks(VERSION) as any
  const chunk = new Chunk(undefined as any)

  for (const b of blocks) {
    const id = resolveStateId(mcData, b.name, b.props)
    chunk.setBlockStateId(new Vec3(b.x, b.y, b.z), id)
    chunk.setBlockLight(new Vec3(b.x, b.y, b.z), 15)
    chunk.setSkyLight(new Vec3(b.x, b.y, b.z), 15)
  }

  const world = new World(VERSION)
  world.addColumn(0, 0, chunk.toJson())
  return world
}

function countQuadsFromLegacy(world: World): number {
  const geo = getSectionGeometry(0, SECTION_Y, 0, world, SECTION_HEIGHT)
  const opaque = geo.indicesCount / 6
  const blend = geo.blend ? geo.blend.indices.length / 6 : 0
  return opaque + blend
}

function countQuadsFromWasm(world: World, shaderCubes = false): number {
  const column = world.getColumn(0, 0)!
  const conversion = convertChunkToWasm(column, VERSION, 0, 0, SECTION_Y, SECTION_Y + SECTION_HEIGHT, SECTION_Y, SECTION_HEIGHT)
  const wasmResult = wasmModule.generate_geometry(
    0,
    SECTION_Y,
    0,
    SECTION_HEIGHT,
    SECTION_Y,
    SECTION_Y + SECTION_HEIGHT,
    SECTION_Y,
    conversion.blockStates,
    conversion.blockLight,
    conversion.skyLight,
    conversion.biomesArray,
    conversion.invisibleBlocks,
    conversion.transparentBlocks,
    conversion.noAoBlocks,
    conversion.cullIdenticalBlocks,
    conversion.occludingBlocks,
    true,
    false,
    15
  )
  const section = renderWasmOutputToGeometry(wasmResult, VERSION, '0,0,0', { x: 8, y: 8, z: 8 }, world, {
    sectionHeight: SECTION_HEIGHT,
    shaderCubes
  })
  const opaque = section.geometry.indices.length / 6
  const blend = section.blendGeometry?.indices.length ? section.blendGeometry.indices.length / 6 : 0
  const shader = shaderCubes ? (section.shaderCubes?.count ?? 0) : 0
  return opaque + blend + shader
}

function assertMesherParity(world: World, expectedQuads: number) {
  const legacy = countQuadsFromLegacy(world)
  const wasmLegacy = countQuadsFromWasm(world, false)
  const wasmShader = countQuadsFromWasm(world, true)
  expect(legacy).toBe(expectedQuads)
  expect(wasmLegacy).toBe(expectedQuads)
  expect(wasmShader).toBe(expectedQuads)
}

function farmlandFieldBlocks(): BlockSpec[] {
  const blocks: BlockSpec[] = []
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      blocks.push({ x, y: 4, z, name: 'dirt' })
      blocks.push({ x, y: 5, z, name: 'farmland' })
    }
  }
  return blocks
}

function slabFieldBlocks(): BlockSpec[] {
  const blocks: BlockSpec[] = []
  for (let z = 0; z < 4; z++) {
    for (let x = 0; x < 4; x++) {
      blocks.push({ x, y: 0, z, name: 'stone' })
      blocks.push({ x, y: 1, z, name: 'stone_slab' })
    }
  }
  return blocks
}

function cutCopperStairsRunBlocks(): BlockSpec[] {
  const blocks: BlockSpec[] = []
  for (let x = 0; x < 8; x++) {
    blocks.push({ x, y: 0, z: 0, name: 'cut_copper_stairs', props: { ...DRY_STAIR_PROPS } })
    blocks.push({ x, y: 0, z: 1, name: 'cut_copper_stairs', props: { ...DRY_STAIR_PROPS } })
  }
  return blocks
}

function cutCopperStairsAscentBlocks(): BlockSpec[] {
  const blocks: BlockSpec[] = []
  for (let x = 0; x < 6; x++) {
    blocks.push({ x, y: 0, z: 0, name: 'cut_copper_stairs', props: { ...DRY_STAIR_PROPS } })
    blocks.push({ x, y: 1, z: 0, name: 'cut_copper_stairs', props: { ...DRY_STAIR_PROPS } })
  }
  return blocks
}

function cutCopperStairsWestRunBlocks(): BlockSpec[] {
  const blocks: BlockSpec[] = []
  for (let x = 0; x < 8; x++) {
    blocks.push({
      x,
      y: 0,
      z: 0,
      name: 'cut_copper_stairs',
      props: { facing: 'west', half: 'bottom', shape: 'straight', waterlogged: false }
    })
    blocks.push({
      x,
      y: 0,
      z: 1,
      name: 'cut_copper_stairs',
      props: { facing: 'west', half: 'bottom', shape: 'straight', waterlogged: false }
    })
  }
  return blocks
}

function cutCopperStairsEastWestMirrorBlocks(): BlockSpec[] {
  const blocks: BlockSpec[] = []
  for (let x = 0; x < 3; x++) {
    blocks.push({ x, y: 0, z: 0, name: 'cut_copper_stairs', props: { ...DRY_STAIR_PROPS } })
  }
  for (let x = 0; x < 3; x++) {
    blocks.push({
      x: x + 4,
      y: 0,
      z: 0,
      name: 'cut_copper_stairs',
      props: { facing: 'west', half: 'bottom', shape: 'straight', waterlogged: false }
    })
  }
  return blocks
}

function countQuadsForFacing(facing: 'east' | 'west' | 'south' | 'north', half: 'bottom' | 'top'): number {
  const world = buildWorld([{ x: 0, y: 0, z: 0, name: 'cut_copper_stairs', props: { facing, half, shape: 'straight', waterlogged: false } }])
  return countQuadsFromWasm(world)
}

function glassLeavesClusterBlocks(): BlockSpec[] {
  return [
    { x: 0, y: 0, z: 0, name: 'stone' },
    { x: 1, y: 0, z: 0, name: 'glass' },
    { x: 0, y: 0, z: 1, name: 'oak_leaves' },
    { x: 1, y: 0, z: 1, name: 'glass' }
  ]
}

test('culling regression: farmland field — internal side faces culled (pre-fix ~8704 quads)', () => {
  const world = buildWorld(farmlandFieldBlocks())
  // Post-fix: 640 quads (legacy + WASM agree). Pre-fix was ~8704 with all internal farmland sides drawn.
  assertMesherParity(world, 640)
})

test('culling regression: slab field', () => {
  const world = buildWorld(slabFieldBlocks())
  assertMesherParity(world, 64)
})

test('culling regression: single cut copper stair legacy vs wasm', () => {
  const world = buildWorld([{ x: 0, y: 0, z: 0, name: 'cut_copper_stairs', props: { ...DRY_STAIR_PROPS } }])
  assertMesherParity(world, 11)
})

test('culling regression: cut copper stairs run (east-facing)', () => {
  const world = buildWorld(cutCopperStairsRunBlocks())
  assertMesherParity(world, 116)
})

test('culling regression: cut copper stairs run (west-facing, rotated)', () => {
  const world = buildWorld(cutCopperStairsWestRunBlocks())
  assertMesherParity(world, 116)
})

test('culling regression: cut copper stairs ascent', () => {
  const world = buildWorld(cutCopperStairsAscentBlocks())
  assertMesherParity(world, 106)
})

test('culling regression: 3 east + 3 west stairs mirror user scenario', () => {
  const world = buildWorld(cutCopperStairsEastWestMirrorBlocks())
  const legacy = countQuadsFromLegacy(world)
  const wasmLegacy = countQuadsFromWasm(world, false)
  const wasmShader = countQuadsFromWasm(world, true)
  expect(legacy).toBe(wasmLegacy)
  expect(legacy).toBe(wasmShader)
  // 6 stairs with 2 internal interfaces culled per row; gap at x=3 prevents east↔west culling
  expect(wasmShader).toBe(58)
  expect(wasmShader).toBeLessThan(3 * 11 * 2)
})

test('culling regression: all stair facings and top half match east baseline', () => {
  const east = countQuadsForFacing('east', 'bottom')
  expect(countQuadsForFacing('west', 'bottom')).toBe(east)
  expect(countQuadsForFacing('south', 'bottom')).toBe(east)
  expect(countQuadsForFacing('north', 'bottom')).toBe(east)
  expect(countQuadsForFacing('east', 'top')).toBe(east)
})

test('culling regression: glass/leaves cluster — see-through blocks not over-culled', () => {
  const world = buildWorld(glassLeavesClusterBlocks())
  // Leaves never occlude; glass self-culls. Baseline locks parity (pre shape-cull guard was 24 legacy-only).
  assertMesherParity(world, 20)
})

test('shader cubes: dirt UP face culled under farmland', () => {
  const world = buildWorld([
    { x: 0, y: 0, z: 0, name: 'dirt' },
    { x: 0, y: 1, z: 0, name: 'farmland' }
  ])
  assertMesherParity(world, 10)
})

test('shader cubes: dirt DOWN face culled under top slab', () => {
  const world = buildWorld([
    { x: 0, y: 0, z: 0, name: 'stone_slab', props: { type: 'top' } },
    { x: 0, y: 1, z: 0, name: 'dirt' }
  ])
  assertMesherParity(world, 10)
})

test('shader cubes: dirt side not culled beside bottom slab', () => {
  const world = buildWorld([
    { x: 0, y: 0, z: 0, name: 'dirt' },
    { x: 1, y: 0, z: 0, name: 'stone_slab', props: { type: 'bottom' } }
  ])
  const legacy = countQuadsFromLegacy(world)
  const wasmShader = countQuadsFromWasm(world, true)
  expect(wasmShader).toBe(legacy)
  expect(wasmShader).toBeGreaterThan(5)
})
