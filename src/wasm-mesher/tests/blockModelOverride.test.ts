import { beforeAll, beforeEach, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Chunks from 'prismarine-chunk'
import MinecraftData from 'minecraft-data'
import { Vec3 } from 'vec3'
import blocksAtlasesJson from 'mc-assets/dist/blocksAtlases.json'
import blockStatesModels from 'mc-assets/dist/blockStatesModels.json'
import { World } from '../../mesher-shared/world'
import { setBlockStatesData } from '../../mesher-shared/models'
import { resetFaceOcclusionCache } from '../../mesher-shared/faceOcclusion'
import { convertChunkToWasm, getBlockMeta } from '../bridge/convertChunk'
import { blockModelOverrideAt, renderWasmOutputToGeometry } from '../bridge/render-from-wasm'

// `minecraft-web-client:blockmodels`: a server tells the client to draw the block at x y z with a model of the resource pack.
// The WASM mesher stored it but drew the block state's own model (the Rust side has no notion of it); the model is now chosen
// in the JS geometry step, like World.getBlock does for the JS mesher.

const VERSION = '1.17.1'
const WORLD_MIN_Y = 0
const WORLD_MAX_Y = 256
const AT = { x: 4, y: 1, z: 4 }

let wasmModule: typeof import('../runtime-build/wasm_mesher.js')

beforeAll(async () => {
  wasmModule = await import('../runtime-build/wasm_mesher.js')
  const wasmDir = dirname(fileURLToPath(import.meta.url))
  wasmModule.initSync(readFileSync(join(wasmDir, '../runtime-build/wasm_mesher_bg.wasm')))
})

beforeEach(() => {
  resetFaceOcclusionCache()
  setBlockStatesData(blockStatesModels, blocksAtlasesJson, false, true, VERSION, { blocks: MinecraftData(VERSION).blocksArray })
  ;(globalThis as any).__wasmBlockModelCache = new Map()
})

function mesh(override: string | undefined, shaderCubes: boolean) {
  const mcData = MinecraftData(VERSION)
  const chunk = new (Chunks(VERSION) as any)(undefined)
  chunk.setBlockStateId(new Vec3(AT.x, AT.y, AT.z), mcData.blocksByName.furnace!.defaultState)
  for (let y = 0; y < 4; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) chunk.setSkyLight(new Vec3(x, y, z), 15)
  const world = new World(VERSION)
  world.addColumn(0, 0, chunk.toJson())
  if (override) world.customBlockModels.set('0,0', { [`${AT.x},${AT.y},${AT.z}`]: override })
  const meta = getBlockMeta(VERSION)
  const conversion = convertChunkToWasm(world.getColumn(0, 0)!, VERSION, 0, 0, WORLD_MIN_Y, WORLD_MAX_Y)
  const wasmResult = wasmModule.generate_geometry(
    0,
    WORLD_MIN_Y,
    0,
    WORLD_MAX_Y - WORLD_MIN_Y,
    WORLD_MIN_Y,
    WORLD_MAX_Y,
    WORLD_MIN_Y,
    conversion.blockStates,
    conversion.blockLight,
    conversion.skyLight,
    conversion.biomesArray,
    meta.invisibleBlocks,
    meta.transparentBlocks,
    meta.noAoBlocks,
    meta.cullIdenticalBlocks,
    meta.occludingBlocks,
    true,
    false,
    15
  )
  return { world, section: renderWasmOutputToGeometry(wasmResult, VERSION, '0,0,0', { x: 8, y: 8, z: 8 }, world, { sectionHeight: 16, shaderCubes }) }
}

const vertexCount = (section: ReturnType<typeof mesh>['section']) => section.geometry.positions.length / 3
/** shader cube faces (6 per cube) */
const shaderCubeFaces = (section: ReturnType<typeof mesh>['section']) => section.shaderCubes?.count ?? 0

test('the override is looked up per position', () => {
  const { world } = mesh('anvil', false)
  expect(blockModelOverrideAt(world, AT.x, AT.y, AT.z)).toBe('anvil')
  expect(blockModelOverrideAt(world, AT.x + 1, AT.y, AT.z)).toBeUndefined()
  expect(blockModelOverrideAt(undefined, AT.x, AT.y, AT.z)).toBeUndefined()
})

test('the WASM mesher draws the overriding model instead of the block state model', () => {
  const plain = vertexCount(mesh(undefined, false).section)
  const overridden = vertexCount(mesh('anvil', false).section)
  // a furnace is one cube (6 faces, 24 vertices); the anvil model has several boxes
  expect(plain).toBe(24)
  expect(overridden).toBeGreaterThan(plain)
})

test('an overridden full cube is not drawn as a shader cube (they take the block state texture)', () => {
  const plain = mesh(undefined, true).section
  const overridden = mesh('anvil', true).section
  expect(shaderCubeFaces(plain)).toBe(6)
  expect(shaderCubeFaces(overridden)).toBe(0)
  expect(vertexCount(overridden)).toBeGreaterThan(24)
})
