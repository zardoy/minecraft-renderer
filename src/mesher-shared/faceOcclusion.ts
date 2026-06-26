import type { WorldBlockProvider } from 'mc-assets/dist/worldBlockProvider'
import PrismarineBlockLoader from 'prismarine-block'
import moreBlockDataGeneratedJson from '../lib/moreBlockDataGenerated.json'
import { buildRotationMatrix, elemFaces, matmul3, matmulmat3, vecsub3 } from './modelsGeometryCommon'
import type { BlockElement } from './modelsGeometryCommon'
import type { BlockModelPartsResolved } from './world'

export type CardinalDir = [number, number, number]

type FaceName = keyof typeof elemFaces

type BlockStateInfo = {
  stateId: number
  name: string
}

const BLOCK_CENTER: [number, number, number] = [8, 8, 8]
const SNAP_EPS = 1e-5

function snapBlockUnit(n: number): number {
  const rounded = Math.round(n)
  return Math.abs(n - rounded) < SNAP_EPS ? rounded : n
}

const DIR_KEYS: CardinalDir[] = [
  [0, 1, 0],
  [0, -1, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1]
]

const faceProjections: Record<
  FaceName,
  {
    touches: (element: BlockElement) => boolean
    rect: (element: BlockElement) => [number, number, number, number]
  }
> = {
  up: {
    touches: e => e.to[1] === 16,
    rect: e => [e.from[0], e.from[2], e.to[0], e.to[2]]
  },
  down: {
    touches: e => e.from[1] === 0,
    rect: e => [e.from[0], e.from[2], e.to[0], e.to[2]]
  },
  east: {
    touches: e => e.to[0] === 16,
    rect: e => [e.from[2], e.from[1], e.to[2], e.to[1]]
  },
  west: {
    touches: e => e.from[0] === 0,
    rect: e => [e.from[2], e.from[1], e.to[2], e.to[1]]
  },
  south: {
    touches: e => e.to[2] === 16,
    rect: e => [e.from[0], e.from[1], e.to[0], e.to[1]]
  },
  north: {
    touches: e => e.from[2] === 0,
    rect: e => [e.from[0], e.from[1], e.to[0], e.to[1]]
  }
}

const shapeCache = new Map<string, Uint16Array[]>()
const blockLoaderCache = new Map<string, ReturnType<typeof PrismarineBlockLoader>>()
const noOcclusionsSet = new Set(Object.keys(moreBlockDataGeneratedJson.noOcclusions))

export function resetFaceOcclusionCache() {
  shapeCache.clear()
}

export function oppositeDir(dir: CardinalDir): CardinalDir {
  return [-dir[0], -dir[1], -dir[2]]
}

export function roundCardinalDir(dir: [number, number, number]): CardinalDir {
  return [Math.round(dir[0]), Math.round(dir[1]), Math.round(dir[2])]
}

export function buildModelGlobalMatrix(model: { x?: number; y?: number; z?: number }): number[][] | null {
  let globalMatrix = null as number[][] | null
  for (const axis of ['x', 'y', 'z'] as const) {
    if (axis in model) {
      globalMatrix = globalMatrix ? matmulmat3(globalMatrix, buildRotationMatrix(axis, -(model[axis] ?? 0))) : buildRotationMatrix(axis, -(model[axis] ?? 0))
    }
  }
  return globalMatrix
}

function isAxisAligned90Rotation(model: { x?: number; y?: number; z?: number }): boolean {
  for (const axis of ['x', 'y', 'z'] as const) {
    if (!(axis in model)) continue
    const deg = model[axis] ?? 0
    if (deg !== 0 && deg % 90 !== 0) return false
  }
  return true
}

function dirKey(dir: CardinalDir): string {
  return `${dir[0]},${dir[1]},${dir[2]}`
}

function dirIndex(dir: CardinalDir): number {
  const key = dirKey(dir)
  const idx = DIR_KEYS.findIndex(d => dirKey(d) === key)
  return idx >= 0 ? idx : 0
}

function emptyShape(): Uint16Array {
  return new Uint16Array(16)
}

function orRectIntoShape(u0: number, v0: number, u1: number, v1: number, shape: Uint16Array) {
  const minU = Math.max(0, Math.floor(Math.min(u0, u1)))
  const maxU = Math.min(15, Math.ceil(Math.max(u0, u1)) - 1)
  const minV = Math.max(0, Math.floor(Math.min(v0, v1)))
  const maxV = Math.min(15, Math.ceil(Math.max(v0, v1)) - 1)
  for (let row = minV; row <= maxV; row++) {
    for (let col = minU; col <= maxU; col++) {
      shape[row]! |= 1 << col
    }
  }
}

function rectIsSubsetOfShape(u0: number, v0: number, u1: number, v1: number, shape: Uint16Array): boolean {
  const minU = Math.max(0, Math.floor(Math.min(u0, u1)))
  const maxU = Math.min(15, Math.ceil(Math.max(u0, u1)) - 1)
  const minV = Math.max(0, Math.floor(Math.min(v0, v1)))
  const maxV = Math.min(15, Math.ceil(Math.max(v0, v1)) - 1)
  for (let row = minV; row <= maxV; row++) {
    for (let col = minU; col <= maxU; col++) {
      if ((shape[row]! & (1 << col)) === 0) return false
    }
  }
  return true
}

function rotatePointAboutCenter(globalMatrix: number[][] | null, point: [number, number, number]): [number, number, number] {
  if (!globalMatrix) return point
  const centered = vecsub3(point, BLOCK_CENTER)
  const rotated = matmul3(globalMatrix, centered)
  return [snapBlockUnit(rotated[0] + 8), snapBlockUnit(rotated[1] + 8), snapBlockUnit(rotated[2] + 8)]
}

function rectToFaceCorners3D(faceName: FaceName, rect: [number, number, number, number]): [number, number, number][] {
  const [u0, v0, u1, v1] = rect
  switch (faceName) {
    case 'up':
      return [
        [u0, 16, v0],
        [u1, 16, v0],
        [u0, 16, v1],
        [u1, 16, v1]
      ]
    case 'down':
      return [
        [u0, 0, v0],
        [u1, 0, v0],
        [u0, 0, v1],
        [u1, 0, v1]
      ]
    case 'east':
      return [
        [16, v0, u0],
        [16, v0, u1],
        [16, v1, u0],
        [16, v1, u1]
      ]
    case 'west':
      return [
        [0, v0, u0],
        [0, v0, u1],
        [0, v1, u0],
        [0, v1, u1]
      ]
    case 'south':
      return [
        [u0, v0, 16],
        [u1, v0, 16],
        [u0, v1, 16],
        [u1, v1, 16]
      ]
    case 'north':
      return [
        [u0, v0, 0],
        [u1, v0, 0],
        [u0, v1, 0],
        [u1, v1, 0]
      ]
  }
}

function boundingRectOnWorldPlane(corners: [number, number, number][], worldDir: CardinalDir): [number, number, number, number] {
  const dk = dirKey(worldDir)
  let minU = 16
  let minV = 16
  let maxU = 0
  let maxV = 0
  for (const [x, y, z] of corners) {
    let u: number
    let v: number
    if (dk === '0,1,0' || dk === '0,-1,0') {
      u = x
      v = z
    } else if (dk === '1,0,0' || dk === '-1,0,0') {
      u = z
      v = y
    } else {
      u = x
      v = y
    }
    minU = Math.min(minU, u)
    maxU = Math.max(maxU, u)
    minV = Math.min(minV, v)
    maxV = Math.max(maxV, v)
  }
  return [minU, minV, maxU, maxV]
}

function worldFaceRect(
  element: BlockElement,
  faceName: FaceName,
  worldFaceDir: CardinalDir,
  globalMatrix: number[][] | null
): [number, number, number, number] | null {
  const proj = faceProjections[faceName]
  if (!proj || !proj.touches(element)) return null
  const rect = proj.rect(element)
  const corners = rectToFaceCorners3D(faceName, rect).map(c => rotatePointAboutCenter(globalMatrix, c))
  return boundingRectOnWorldPlane(corners, worldFaceDir)
}

export function blockRendersSolid(block: { name: string; transparent?: boolean }): boolean {
  if (block.transparent) {
    if (/glass|ice/.test(block.name)) return false
    if (block.name.includes('leaves')) return false
  }
  if (block.name === 'water' || block.name === 'lava') return false
  if (noOcclusionsSet.has(block.name)) return false
  return true
}

function getBlockFromStateId(version: string, stateId: number) {
  let Block = blockLoaderCache.get(version)
  if (!Block) {
    Block = PrismarineBlockLoader(version)
    blockLoaderCache.set(version, Block)
  }
  return Block.fromStateId(stateId, 1)
}

function getAllShapesForState(version: string, stateId: number, blockProvider: WorldBlockProvider): Uint16Array[] {
  const cacheKey = `${version}:${stateId}`
  const cached = shapeCache.get(cacheKey)
  if (cached) return cached

  const shapes = DIR_KEYS.map(() => emptyShape())
  const blockObj = getBlockFromStateId(version, stateId)
  if (!blockObj || !blockRendersSolid(blockObj)) {
    shapeCache.set(cacheKey, shapes)
    return shapes
  }

  const models = blockProvider.getAllResolvedModels0_1({ name: blockObj.name, properties: blockObj.getProperties() }, false) as BlockModelPartsResolved

  for (const modelVars of models ?? []) {
    const model = modelVars[0]
    if (!model) continue
    if (!isAxisAligned90Rotation(model)) continue

    const globalMatrix = buildModelGlobalMatrix(model)

    for (const element of model.elements ?? []) {
      for (const faceName of Object.keys(element.faces) as FaceName[]) {
        const proj = faceProjections[faceName]
        if (!proj || !proj.touches(element)) continue

        const localDir = elemFaces[faceName].dir as CardinalDir
        const worldDir = roundCardinalDir(matmul3(globalMatrix, localDir))
        const rect = proj.rect(element)
        const corners = rectToFaceCorners3D(faceName, rect).map(c => rotatePointAboutCenter(globalMatrix, c))
        const [u0, v0, u1, v1] = boundingRectOnWorldPlane(corners, worldDir)
        orRectIntoShape(u0, v0, u1, v1, shapes[dirIndex(worldDir)]!)
      }
    }
  }

  shapeCache.set(cacheKey, shapes)
  return shapes
}

export function getOcclusionShape(version: string, stateId: number, worldDir: CardinalDir, blockProvider: WorldBlockProvider): Uint16Array {
  return getAllShapesForState(version, stateId, blockProvider)[dirIndex(worldDir)]!
}

export function faceIsCulled(
  version: string,
  currentElement: BlockElement,
  faceName: string,
  neighborStateId: number,
  currentBlock: BlockStateInfo,
  blockProvider: WorldBlockProvider,
  worldFaceDir: CardinalDir,
  globalMatrix: number[][] | null
): boolean {
  const face = currentElement.faces[faceName]
  if (!face?.cullface) return false

  if (neighborStateId === currentBlock.stateId && /glass|ice/.test(currentBlock.name)) {
    return true
  }

  if (!neighborStateId) return false

  const faceRect = worldFaceRect(currentElement, faceName as FaceName, worldFaceDir, globalMatrix)
  if (!faceRect) return false

  const neighborShape = getOcclusionShape(version, neighborStateId, oppositeDir(worldFaceDir), blockProvider)
  return rectIsSubsetOfShape(faceRect[0], faceRect[1], faceRect[2], faceRect[3], neighborShape)
}
