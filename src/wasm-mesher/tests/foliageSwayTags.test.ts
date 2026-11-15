import { beforeAll, beforeEach, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Chunks from 'prismarine-chunk'
import MinecraftData from 'minecraft-data'
import PrismarineBlockLoader from 'prismarine-block'
import { Vec3 } from 'vec3'
import blocksAtlasesJson from 'mc-assets/dist/blocksAtlases.json'
import blockStatesModels from 'mc-assets/dist/blockStatesModels.json'
import { World } from '../../mesher-shared/world'
import { setBlockStatesData } from '../../mesher-shared/models'
import { resetFaceOcclusionCache } from '../../mesher-shared/faceOcclusion'
import { decodeFoliageSwayLevel } from '../../mesher-shared/foliageSway'
import { convertChunkToWasm, getBlockMeta } from '../bridge/convertChunk'
import { renderWasmOutputToGeometry } from '../bridge/render-from-wasm'

const VERSION = '1.17.1'
const WORLD_MIN_Y = 0
const WORLD_MAX_Y = 256

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

function meshColumn(blocks: Array<[x: number, y: number, z: number, stateId: number]>) {
  const chunk = new (Chunks(VERSION) as any)(undefined)
  for (const [x, y, z, stateId] of blocks) {
    chunk.setBlockStateId(new Vec3(x, y, z), stateId)
    chunk.setSkyLight(new Vec3(x, y, z), 15)
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
  return renderWasmOutputToGeometry(wasmResult, VERSION, '0,0,0', { x: 8, y: 8, z: 8 }, world, { sectionHeight: 16, shaderCubes: false })
}

test('mesher tags plant vertices with their sway level, anchored at the bottom', () => {
  const Block = PrismarineBlockLoader(VERSION)
  const mcData = MinecraftData(VERSION)
  const tallLower = Block.fromProperties('tall_grass', { half: 'lower' }, 0).stateId!
  const tallUpper = Block.fromProperties('tall_grass', { half: 'upper' }, 0).stateId!
  const { geometry } = meshColumn([
    [2, 1, 2, mcData.blocksByName.grass!.defaultState],
    [5, 1, 5, tallLower],
    [5, 2, 5, tallUpper],
    [10, 1, 10, mcData.blocksByName.stone!.defaultState]
  ])
  const { width, height } = blocksAtlasesJson.latest

  // block column (x, z) → height of vertex inside the column → levels seen
  const levels = new Map<string, Map<number, Set<number>>>()
  for (let i = 0; i < geometry.positions.length / 3; i++) {
    const x = geometry.positions[i * 3]! + 8
    const y = geometry.positions[i * 3 + 1]! + 8
    const z = geometry.positions[i * 3 + 2]! + 8
    const column = `${Math.round(x - 0.5)},${Math.round(z - 0.5)}`
    const level = decodeFoliageSwayLevel(Math.fround(geometry.uvs[i * 2]!), Math.fround(geometry.uvs[i * 2 + 1]!), width, height)
    const byHeight = levels.get(column) ?? new Map<number, Set<number>>()
    levels.set(column, byHeight)
    const key = Math.round(y * 16) / 16
    byHeight.set(key, (byHeight.get(key) ?? new Set()).add(level))
  }
  const asObject = (column: string) => Object.fromEntries([...levels.get(column)!].map(([y, set]) => [y, [...set]]))

  expect(asObject('2,2')).toEqual({ 1: [0], 2: [1] })
  expect(asObject('5,5')).toEqual({ 1: [0], 2: [1], 3: [2] })
  expect(new Set(Object.values(asObject('10,10')).flat())).toEqual(new Set([0]))
})
