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
import { renderWasmOutputToGeometry } from '../bridge/render-from-wasm'

// A cross plant (short grass) next to a solid block: one of its quads has a face direction pointing into the block. Its
// light was read from that neighbour cell (sky 0 inside the block), so that half of the plant rendered black. Vanilla reads
// the neighbour only for faces on the block boundary; the plant's diagonal quads take the plant's own cell.

const VERSION = '1.17.1'
const WORLD_MIN_Y = 0
const WORLD_MAX_Y = 256
const PLANT = { x: 4, y: 1, z: 4 }

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

function meshPlant(solidNeighbours: Array<[number, number, number]>) {
  const mcData = MinecraftData(VERSION)
  const chunk = new (Chunks(VERSION) as any)(undefined)
  for (let y = 0; y < 4; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) chunk.setSkyLight(new Vec3(x, y, z), 15)
  chunk.setBlockStateId(new Vec3(PLANT.x, PLANT.y, PLANT.z), mcData.blocksByName.grass!.defaultState)
  for (const [dx, dy, dz] of solidNeighbours) {
    const pos = new Vec3(PLANT.x + dx, PLANT.y + dy, PLANT.z + dz)
    chunk.setBlockStateId(pos, mcData.blocksByName.stone!.defaultState)
    chunk.setSkyLight(pos, 0)
  }
  const world = new World(VERSION)
  world.addColumn(0, 0, chunk.toJson())
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
  // shader cubes: the stone goes to the cube instances, the legacy geometry is only the plant
  return renderWasmOutputToGeometry(wasmResult, VERSION, '0,0,0', { x: 8, y: 8, z: 8 }, world, { sectionHeight: 16, shaderCubes: true })
}

const plantSkyLights = (section: ReturnType<typeof meshPlant>) => Array.from(section.geometry.skyLights as ArrayLike<number>)

test('a lone plant is lit by the sky on every vertex', () => {
  const sky = plantSkyLights(meshPlant([]))
  expect(sky.length).toBeGreaterThan(0)
  expect(new Set(sky)).toEqual(new Set([1]))
})

test.each([
  ['west', [-1, 0, 0]],
  ['east', [1, 0, 0]],
  ['north', [0, 0, -1]],
  ['south', [0, 0, 1]]
] as const)('a solid block to the %s does not darken any quad of the plant', (_name, offset) => {
  const lone = plantSkyLights(meshPlant([]))
  const next = plantSkyLights(meshPlant([offset as unknown as [number, number, number]]))
  expect(next.length).toBe(lone.length)
  expect(new Set(next)).toEqual(new Set([1]))
})

test('a plant boxed in on all four sides keeps its own light', () => {
  const sky = plantSkyLights(
    meshPlant([
      [-1, 0, 0],
      [1, 0, 0],
      [0, 0, -1],
      [0, 0, 1]
    ])
  )
  expect(new Set(sky)).toEqual(new Set([1]))
})
