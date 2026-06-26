import { test, expect, beforeEach } from 'vitest'
import MinecraftData from 'minecraft-data'
import blocksAtlasesJson from 'mc-assets/dist/blocksAtlases.json'
import blockStatesModels from 'mc-assets/dist/blockStatesModels.json'
import worldBlockProvider from 'mc-assets/dist/worldBlockProvider'
import PrismarineBlockLoader from 'prismarine-block'
import Chunks from 'prismarine-chunk'
import { Vec3 } from 'vec3'
import { blockRendersSolid, getOcclusionShape, faceIsCulled, resetFaceOcclusionCache, oppositeDir, buildModelGlobalMatrix } from '../faceOcclusion'
import { elemFaces } from '../modelsGeometryCommon'
import { setBlockStatesData, getSectionGeometry } from '../models'
import { World } from '../world'

const VERSION = '1.18.2'

beforeEach(() => {
  resetFaceOcclusionCache()
  const mcData = MinecraftData(VERSION)
  setBlockStatesData(blockStatesModels, blocksAtlasesJson, false, true, VERSION, { blocks: mcData.blocksArray })
})

function blockProvider() {
  return (globalThis as any).blockProvider
}

function farmlandElement(provider: ReturnType<typeof worldBlockProvider>) {
  const mcData = MinecraftData(VERSION)
  const farmlandId = mcData.blocksByName.farmland!.defaultState
  const blockObj = PrismarineBlockLoader(VERSION).fromStateId(farmlandId, 1)
  const models = provider.getAllResolvedModels0_1({ name: blockObj.name, properties: blockObj.getProperties() }, false)
  return { farmlandId, element: models[0]![0]!.elements![0]! }
}

function stairStateId(props: Record<string, string | boolean>) {
  const mcData = MinecraftData(VERSION)
  const Block = PrismarineBlockLoader(VERSION)
  for (let sid = mcData.blocksByName.cut_copper_stairs!.minStateId; sid <= mcData.blocksByName.cut_copper_stairs!.maxStateId; sid++) {
    const p = Block.fromStateId(sid, 1).getProperties() as Record<string, string>
    let match = true
    for (const [k, v] of Object.entries(props)) {
      if (p[k] !== v) {
        match = false
        break
      }
    }
    if (match) return sid
  }
  throw new Error(`no stair state for ${JSON.stringify(props)}`)
}

function stairModel(stateId: number, provider: ReturnType<typeof worldBlockProvider>) {
  const blockObj = PrismarineBlockLoader(VERSION).fromStateId(stateId, 1)
  return provider.getAllResolvedModels0_1({ name: blockObj.name, properties: blockObj.getProperties() }, false)[0]![0]!
}

test('blockRendersSolid: farmland opaque, glass and leaves not', () => {
  const Block = PrismarineBlockLoader(VERSION)
  const farmland = Block.fromStateId(MinecraftData(VERSION).blocksByName.farmland!.defaultState, 1)
  const glass = Block.fromStateId(MinecraftData(VERSION).blocksByName.glass!.defaultState, 1)
  const leaves = Block.fromStateId(MinecraftData(VERSION).blocksByName.oak_leaves!.defaultState, 1)
  expect(blockRendersSolid(farmland)).toBe(true)
  expect(blockRendersSolid(glass)).toBe(false)
  expect(blockRendersSolid(leaves)).toBe(false)
})

test('getOcclusionShape: full cube covers entire plane', () => {
  const mcData = MinecraftData(VERSION)
  const stoneId = mcData.blocksByName.stone!.defaultState
  const shape = getOcclusionShape(VERSION, stoneId, [1, 0, 0], blockProvider())
  for (let row = 0; row < 16; row++) {
    expect(shape[row]).toBe(0xffff)
  }
})

test('getOcclusionShape: farmland side is shorter than full height', () => {
  const mcData = MinecraftData(VERSION)
  const farmlandId = mcData.blocksByName.farmland!.defaultState
  const eastShape = getOcclusionShape(VERSION, farmlandId, [1, 0, 0], blockProvider())
  let covered = 0
  for (let row = 0; row < 16; row++) {
    for (let col = 0; col < 16; col++) {
      if (eastShape[row]! & (1 << col)) covered++
    }
  }
  expect(covered).toBeLessThan(16 * 16)
  expect(covered).toBeGreaterThan(0)
})

test('getOcclusionShape: west-facing stair fully covers west plane (step on west side)', () => {
  const westId = stairStateId({ facing: 'west', half: 'bottom', shape: 'straight', waterlogged: false })
  const westShape = getOcclusionShape(VERSION, westId, [-1, 0, 0], blockProvider())
  for (let row = 0; row < 16; row++) {
    expect(westShape[row]).toBe(0xffff)
  }
})

test('faceIsCulled: farmland east face culled by adjacent farmland', () => {
  const provider = blockProvider()
  const { farmlandId, element } = farmlandElement(provider)
  expect(faceIsCulled(VERSION, element, 'east', farmlandId, { stateId: farmlandId, name: 'farmland' }, provider, [1, 0, 0], null)).toBe(true)
})

test('faceIsCulled: farmland east face not culled by air', () => {
  const provider = blockProvider()
  const { farmlandId, element } = farmlandElement(provider)
  expect(faceIsCulled(VERSION, element, 'east', 0, { stateId: farmlandId, name: 'farmland' }, provider, [1, 0, 0], null)).toBe(false)
})

test('faceIsCulled: glass identical neighbor still culls', () => {
  const mcData = MinecraftData(VERSION)
  const glassId = mcData.blocksByName.glass!.defaultState
  const provider = blockProvider()
  const models = provider.getAllResolvedModels0_1({ name: 'glass', properties: {} }, false)
  const element = models[0]![0]!.elements![0]!
  expect(faceIsCulled(VERSION, element, 'north', glassId, { stateId: glassId, name: 'glass' }, provider, [0, 0, -1], null)).toBe(true)
})

test('legacy mesher: adjacent farmland culled internal side', () => {
  const mcData = MinecraftData(VERSION)
  const Chunk = Chunks(VERSION) as any
  const chunk = new Chunk(undefined as any)
  const farmlandId = mcData.blocksByName.farmland!.defaultState
  chunk.setBlockStateId(new Vec3(0, 0, 0), farmlandId)
  chunk.setBlockStateId(new Vec3(1, 0, 0), farmlandId)
  const world = new World(VERSION)
  world.addColumn(0, 0, chunk.toJson())
  const geo = getSectionGeometry(0, 0, 0, world, 16)
  expect(geo.indicesCount / 6).toBe(10)
})

test('faceIsCulled: east stair interior faces culled against identical stair', () => {
  const stairId = stairStateId({ facing: 'east', half: 'bottom', shape: 'straight', waterlogged: false })
  const provider = blockProvider()
  const model = stairModel(stairId, provider)
  const globalMatrix = buildModelGlobalMatrix(model)
  let culled = 0
  for (const element of model.elements ?? []) {
    for (const face of Object.keys(element.faces)) {
      const localDir = elemFaces[face as keyof typeof elemFaces].dir as [number, number, number]
      const worldDir = [Math.round(localDir[0]), Math.round(localDir[1]), Math.round(localDir[2])] as [number, number, number]
      if (faceIsCulled(VERSION, element, face, stairId, { stateId: stairId, name: 'cut_copper_stairs' }, provider, worldDir, globalMatrix)) {
        culled++
      }
    }
  }
  expect(culled).toBeGreaterThan(0)
})

test('faceIsCulled: west stair interior faces culled against identical west stair', () => {
  const stairId = stairStateId({ facing: 'west', half: 'bottom', shape: 'straight', waterlogged: false })
  const provider = blockProvider()
  const model = stairModel(stairId, provider)
  const globalMatrix = buildModelGlobalMatrix(model)
  expect(globalMatrix).not.toBeNull()
  let culled = 0
  for (const element of model.elements ?? []) {
    for (const face of Object.keys(element.faces)) {
      const localDir = elemFaces[face as keyof typeof elemFaces].dir
      const rotated = globalMatrix
        ? [
            globalMatrix[0][0] * localDir[0] + globalMatrix[0][1] * localDir[1] + globalMatrix[0][2] * localDir[2],
            globalMatrix[1][0] * localDir[0] + globalMatrix[1][1] * localDir[1] + globalMatrix[1][2] * localDir[2],
            globalMatrix[2][0] * localDir[0] + globalMatrix[2][1] * localDir[1] + globalMatrix[2][2] * localDir[2]
          ]
        : localDir
      const worldDir = [Math.round(rotated[0]), Math.round(rotated[1]), Math.round(rotated[2])] as [number, number, number]
      if (faceIsCulled(VERSION, element, face, stairId, { stateId: stairId, name: 'cut_copper_stairs' }, provider, worldDir, globalMatrix)) {
        culled++
      }
    }
  }
  expect(culled).toBeGreaterThan(0)
})

test('oppositeDir inverts cardinal directions', () => {
  expect(oppositeDir([1, 0, 0])[0]).toBe(-1)
  expect(oppositeDir([0, 1, 0])[1]).toBe(-1)
})
