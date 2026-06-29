// Renderer that converts WASM mesher output to Three.js geometry
// This file takes WASM output and generates full Three.js buffer geometry

import * as THREE from 'three'
import worldBlockProviderModule, { WorldBlockProvider } from 'mc-assets/dist/worldBlockProvider'
import blocksAtlasesJson from 'mc-assets/dist/blocksAtlases.json'
import blockStatesModels from 'mc-assets/dist/blockStatesModels.json'
import MinecraftData from 'minecraft-data'
import PrismarineBlockLoader from 'prismarine-block'
import { Vec3 } from 'vec3'
import { elemFaces, buildElementRotation, buildRotationMatrix, matmul3, matmulmat3, vecadd3, vecsub3 } from '../../mesher-shared/modelsGeometryCommon'
import type { ExportedWorldGeometry, ExportedSection } from '../../mesher-shared/exportedGeometryTypes'
import type { MesherGeometryOutput } from '../../mesher-shared/shared'
import { bakeLegacyVertexColors } from '../../lib/bakeLegacyLight'
import { SECTION_HEIGHT } from '../../mesher-shared/shared'
import type { World } from '../../mesher-shared/world'
import { resolveBlockPropertiesForMeshing } from '../../mesher-shared/blockPropertiesForMeshing'
import { isSemiTransparentBlockName } from '../../mesher-shared/models'
import { faceIsCulled } from '../../mesher-shared/faceOcclusion'
import { buildShaderCubesFromWords, getShaderCubeResources, tryBuildShaderCubeInstances } from './shaderCubeBridge'
import { getSideShading, vertexLightFromAo } from '../../mesher-shared/vertexShading'
import tintsJson from 'minecraft-data/minecraft-data/data/pc/1.16.2/tints.json'

// Handle both default and named export
const worldBlockProvider = (worldBlockProviderModule as any).default || worldBlockProviderModule

// Initialize tints (same as in models.ts)
const tints: any = {}
let tintsInitialized = false

function initializeTints() {
  if (tintsInitialized) return
  for (const key of Object.keys(tintsJson as Record<string, unknown>)) {
    tints[key] = prepareTints((tintsJson as Record<string, unknown>)[key])
  }
  tintsInitialized = true
}

function prepareTints(tints: any) {
  const map = new Map()
  const defaultValue = tintToGl(tints.default)
  for (let { keys, color } of tints.data) {
    color = tintToGl(color)
    for (const key of keys) {
      map.set(`${key}`, color)
    }
  }
  return new Proxy(map, {
    get(target, key) {
      return target.has(key) ? target.get(key) : defaultValue
    }
  })
}

function tintToGl(tint: number) {
  const r = (tint >> 16) & 0xff
  const g = (tint >> 8) & 0xff
  const b = tint & 0xff
  return [r / 255, g / 255, b / 255]
}

// Cached model definition with precomputed matrices
interface CachedBlockModel {
  blockName: string
  blockProps: Record<string, any>
  models: any // BlockModelPartsResolved
  isCube: boolean
  boundingBox: string
  // Precomputed per-model variant
  modelVariants: Array<{
    model: any
    globalMatrix: any
    globalShift: any
    // Precomputed per-element
    elements: Array<{
      element: any
      localMatrix: any
      localShift: any
    }>
  }>
}

interface WasmBlockFaceData {
  position: [number, number, number]
  block_state_id: number
  visible_faces: number
  ao_data: number[][]
  light_data?: number[][]
  sky_light_data?: number[][]
  block_light_data?: number[][]
  light_combined?: number[][]
}

export interface WasmGeometryOutput {
  blocks: WasmBlockFaceData[]
  block_count: number
  block_iterations: number
  /**
   * Per-(x,z) max non-invisible block Y for the meshed column, indexed as
   * `z * 16 + x`. Sentinel value `-32768` = no block in that column.
   *
   * Populated by Rust `Mesher::generate_with_world` (see
   * `wasm-mesher/src/mesher.rs`, field `heightmap`). serde_wasm_bindgen
   * serializes `Vec<i16>` as a plain JS `number[]`, which is why the type
   * here is `ArrayLike<number>` rather than `Int16Array` — the runtime
   * adapter `extractColumnHeightmap` handles both shapes.
   *
   * Used at runtime by `mesherWasm.ts` `processColumnTick`: every column
   * tick the WASM heightmap is extracted via `extractColumnHeightmap` and
   * posted to the main thread as a `'heightmap'` message. JS
   * `computeHeightmap` is now only a fallback (length mismatch / missing
   * field) and a safety-net for empty columns at chunk load. Empty-column
   * semantics are aligned: both Rust and JS use `-32768` (see
   * `EMPTY_COLUMN_HEIGHTMAP_SENTINEL`).
   */
  heightmap?: ArrayLike<number> | null
}

/**
 * Extract a 256-entry Int16Array heightmap from a full-column WASM mesher
 * result, indexed as `z * 16 + x` (matching the JS `computeHeightmap`
 * convention). Returns `null` when the WASM output does not carry a
 * heightmap or carries one of unexpected length — in that case the
 * caller MUST fall back to JS `computeHeightmap` rather than guess.
 *
 * This adapter is the single place that converts Rust's `Vec<i16>` heightmap
 * shape into a transferable typed array. Tests exercise this same adapter so
 * future runtime usage and parity assertions cannot drift apart.
 */
export function extractColumnHeightmap(wasmOutput: { heightmap?: ArrayLike<number> | null } | null | undefined): Int16Array | null {
  const raw = wasmOutput?.heightmap
  if (!raw || raw.length !== 256) return null
  if (raw instanceof Int16Array) return new Int16Array(raw)
  const out = new Int16Array(256)
  for (let i = 0; i < 256; i++) out[i] = raw[i]
  return out
}

function computeMesherVertexLight(world: World | undefined, ao: number, cornerLight15: number, faceDir: [number, number, number]): number {
  const shadingTheme = world?.config.shadingTheme ?? 'high-contrast'
  const cardinalLight = world?.config.cardinalLight ?? 'default'
  const sideShading = getSideShading(faceDir, shadingTheme, cardinalLight)
  return vertexLightFromAo(ao, cornerLight15, sideShading, shadingTheme)
}

function vertexTintAoColor(world: World | undefined, tint: [number, number, number], ao: number, faceDir: [number, number, number]): [number, number, number] {
  const shadingTheme = world?.config.shadingTheme ?? 'high-contrast'
  const cardinalLight = world?.config.cardinalLight ?? 'default'
  const sideShading = getSideShading(faceDir, shadingTheme, cardinalLight)
  if (shadingTheme === 'high-contrast') {
    const f = sideShading * ((ao + 1) / 4)
    return [tint[0] * f, tint[1] * f, tint[2] * f]
  }
  const f = sideShading * (ao * 0.2 + 0.4)
  return [tint[0] * f, tint[1] * f, tint[2] * f]
}

function sampleChannelLightAt(world: World, pos: Vec3): { block: number; sky: number } {
  return world.getChannelLightNorm(pos)
}

function smoothChannelLightAt(
  world: World,
  cursor: Vec3,
  faceDir: [number, number, number],
  cornerOffset: [number, number, number],
  faceIdx: number
): { block: number; sky: number } {
  const neighbor = cursor.offset(faceDir[0], faceDir[1], faceDir[2])
  const base = sampleChannelLightAt(world, neighbor)

  if (!world.config.smoothLighting) {
    return base
  }

  const mask1 = [
    [1, 1, 0],
    [1, 1, 0],
    [1, 1, 0],
    [1, 1, 0],
    [1, 0, 1],
    [1, 0, 1]
  ][faceIdx]!
  const mask2 = [
    [0, 1, 1],
    [0, 1, 1],
    [1, 0, 1],
    [1, 0, 1],
    [0, 1, 1],
    [0, 1, 1]
  ][faceIdx]!
  const [cx, cy, cz] = cornerOffset
  const [fx, fy, fz] = faceDir

  const shrink = (v: [number, number, number], mask: number[]) => {
    const out: [number, number, number] = [cx * mask[0]!, cy * mask[1]!, cz * mask[2]!]
    if (fx !== 0) out[0] = 0
    if (fy !== 0) out[1] = 0
    if (fz !== 0) out[2] = 0
    return out
  }

  const s1 = shrink([cx, cy, cz], mask1)
  const s2 = shrink([cx, cy, cz], mask2)
  const c = shrink([cx, cy, cz], [1, 1, 1])

  const samples = [
    base,
    sampleChannelLightAt(world, neighbor.offset(s1[0], s1[1], s1[2])),
    sampleChannelLightAt(world, neighbor.offset(s2[0], s2[1], s2[2])),
    sampleChannelLightAt(world, neighbor.offset(c[0], c[1], c[2]))
  ]

  let blockSum = 0
  let skySum = 0
  for (const s of samples) {
    blockSum += s.block
    skySum += s.sky
  }
  return { block: blockSum / 4, sky: skySum / 4 }
}

/**
 * Get or create cached block model with precomputed matrices
 */
function getCachedBlockModel(
  blockStateId: number,
  version: string,
  blockProvider: WorldBlockProvider,
  PrismarineBlock: any,
  world?: World,
  blockPos?: { x: number; y: number; z: number }
): CachedBlockModel | null {
  const usePreflat = !!(world?.preflat && blockPos)
  let blockName: string
  let blockProps: Record<string, unknown>
  if (usePreflat) {
    const resolved = resolveBlockPropertiesForMeshing(world, new Vec3(blockPos!.x, blockPos!.y, blockPos!.z), blockProvider, blockStateId, PrismarineBlock)
    blockName = resolved.name
    blockProps = resolved.properties
  } else {
    const blockObj = PrismarineBlock.fromStateId(blockStateId, 1)
    blockName = blockObj.name
    blockProps = blockObj.getProperties()
  }

  const cacheKey = usePreflat ? `${version}:${blockStateId}:${blockName}:${JSON.stringify(blockProps)}` : `${version}:${blockStateId}`
  if (!(globalThis as any).__wasmBlockModelCache) {
    ;(globalThis as any).__wasmBlockModelCache = new Map()
  }
  const cache = (globalThis as any).__wasmBlockModelCache

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey)
  }

  try {
    const blockObj = PrismarineBlock.fromStateId(blockStateId, 1)
    if (!usePreflat) {
      blockName = blockObj.name
      blockProps = blockObj.getProperties()
    }

    const models = blockProvider.getAllResolvedModels0_1({ name: blockName, properties: blockProps as Record<string, string | number | boolean> }, false)

    if (!models || models.length === 0) return null

    // Precompute matrices for all model variants
    const modelVariants = models
      .map(modelVars => {
        return modelVars.map(model => {
          // Calculate global matrix and shift for model rotation
          let globalMatrix = null as any
          let globalShift = null as any
          for (const axis of ['x', 'y', 'z'] as const) {
            if (axis in model) {
              globalMatrix = globalMatrix
                ? matmulmat3(globalMatrix, buildRotationMatrix(axis, -(model[axis] ?? 0)))
                : buildRotationMatrix(axis, -(model[axis] ?? 0))
            }
          }
          if (globalMatrix) {
            globalShift = [8, 8, 8]
            globalShift = vecsub3(globalShift, matmul3(globalMatrix, globalShift))
          }

          // Precompute element matrices
          const elements = (model.elements ?? []).map((element: any) => {
            let localMatrix = null as any
            let localShift = null as any
            if (element.rotation) {
              ;({ localMatrix, localShift } = buildElementRotation(element.rotation))
            }
            return { element, localMatrix, localShift }
          })

          return { model, globalMatrix, globalShift, elements }
        })
      })
      .flat()

    const isCube = (() => {
      try {
        if (!models?.length || models.length !== 1) return false
        if (blockObj.transparent) return false
        return models[0].every(v =>
          v.elements.every(e => {
            return e.from[0] === 0 && e.from[1] === 0 && e.from[2] === 0 && e.to[0] === 16 && e.to[1] === 16 && e.to[2] === 16
          })
        )
      } catch {
        return false
      }
    })()

    const cached: CachedBlockModel = {
      blockName,
      blockProps,
      models,
      modelVariants,
      isCube,
      boundingBox: blockObj.boundingBox
    }

    cache.set(cacheKey, cached)
    return cached
  } catch (err) {
    console.warn(`Failed to get model for state ${blockStateId}:`, err)
    return null
  }
}

/**
 * Get tint for a face (matching TypeScript logic)
 */
function getTint(
  eFace: any,
  blockName: string,
  blockProps: Record<string, any>,
  biome: string | undefined,
  world: World | undefined
): [number, number, number] {
  if (eFace.tintindex === undefined) return [1, 1, 1]

  if (eFace.tintindex === 0) {
    if (blockName === 'redstone_wire') {
      initializeTints()
      return tints.redstone[`${blockProps.power}`] || [1, 1, 1]
    } else if (blockName === 'birch_leaves' || blockName === 'spruce_leaves' || blockName === 'lily_pad') {
      initializeTints()
      return tints.constant[blockName] || [1, 1, 1]
    } else if (blockName.includes('leaves') || blockName === 'vine') {
      initializeTints()
      return tints.foliage[biome || 'plains'] || [1, 1, 1]
    } else {
      initializeTints()
      return tints.grass[biome || 'plains'] || [1, 1, 1]
    }
  }

  return [1, 1, 1]
}

const ALWAYS_WATERLOGGED = new Set(['seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'bubble_column'])

const isBlockWaterlogged = (block: any) => {
  const props = block?.getProperties?.()
  return props?.waterlogged === true || props?.waterlogged === 'true' || ALWAYS_WATERLOGGED.has(block?.name)
}

const getVec = (v: Vec3, dir: Vec3) => {
  for (const coord of ['x', 'y', 'z'] as const) {
    if (Math.abs((dir as any)[coord]) > 0) (v as any)[coord] = 0
  }
  return v.plus(dir)
}

const getLiquidRenderHeight = (world: World, block: any, type: number, pos: Vec3, isWater: boolean, isRealWater: boolean) => {
  if ((isWater && !isRealWater) || (block && isBlockWaterlogged(block))) return 8 / 9
  if (!block || block.type !== type) return 1 / 9
  if (block.metadata === 0) {
    const blockAbove = world.getBlock(pos.offset(0, 1, 0))
    if (blockAbove && blockAbove.type === type) return 1
    return 8 / 9
  }
  return ((block.metadata >= 8 ? 8 : 7 - block.metadata) + 1) / 9
}

const renderLiquidToGeometry = (
  world: World,
  cursor: Vec3,
  texture: any,
  type: number,
  biome: string,
  water: boolean,
  isRealWater: boolean,
  positions: number[],
  normals: number[],
  colors: number[],
  skyLights: number[],
  blockLights: number[],
  uvs: number[],
  indices: number[]
) => {
  const heights: number[] = []
  for (let z = -1; z <= 1; z++) {
    for (let x = -1; x <= 1; x++) {
      const pos = cursor.offset(x, 0, z)
      heights.push(getLiquidRenderHeight(world, world.getBlock(pos), type, pos, water, isRealWater))
    }
  }

  const cornerHeights = [
    Math.max(Math.max(heights[0], heights[1]), Math.max(heights[3], heights[4])),
    Math.max(Math.max(heights[1], heights[2]), Math.max(heights[4], heights[5])),
    Math.max(Math.max(heights[3], heights[4]), Math.max(heights[6], heights[7])),
    Math.max(Math.max(heights[4], heights[5]), Math.max(heights[7], heights[8]))
  ]

  for (const face in elemFaces) {
    const { dir, corners, mask1, mask2 } = (elemFaces as any)[face]
    const isUp = dir[1] === 1

    const neighborPos = cursor.offset(dir[0], dir[1], dir[2])
    const neighbor = world.getBlock(neighborPos)
    if (!neighbor) continue
    if (neighbor.type === type || (water && (neighbor.name === 'water' || isBlockWaterlogged(neighbor)))) continue
    if (neighbor.isCube && !neighbor.transparent && !isUp) continue

    let tint: [number, number, number] = [1, 1, 1]
    if (water) {
      initializeTints()
      let m = 1
      if (Math.abs(dir[0]) > 0) m = 0.6
      else if (Math.abs(dir[2]) > 0) m = 0.8
      const wt = tints.water[biome] || [1, 1, 1]
      tint = [wt[0] * m, wt[1] * m, wt[2] * m]
    }

    const u = texture.u || 0
    const v = texture.v || 0
    const su = texture.su || 1
    const sv = texture.sv || 1

    const baseChannels = sampleChannelLightAt(world, neighborPos)

    const baseIndex = positions.length / 3

    for (const pos of corners) {
      const height = cornerHeights[pos[2] * 2 + pos[0]]
      const OFFSET = 0.0001

      positions.push(
        (pos[0] ? 1 - OFFSET : OFFSET) + (cursor.x & 15) - 8,
        (pos[1] ? height - OFFSET : OFFSET) + (cursor.y & 15) - 8,
        (pos[2] ? 1 - OFFSET : OFFSET) + (cursor.z & 15) - 8
      )

      normals.push(dir[0], dir[1], dir[2])
      uvs.push(pos[3] * su + u, pos[4] * sv * (pos[1] ? 1 : height) + v)

      let skyNorm = baseChannels.sky
      let blockNorm = baseChannels.block
      if (world.config.smoothLighting) {
        const dx = pos[0] * 2 - 1
        const dy = pos[1] * 2 - 1
        const dz = pos[2] * 2 - 1
        const cornerDir: [number, number, number] = [dx, dy, dz]
        const side1Dir: [number, number, number] = [dx * mask1[0], dy * mask1[1], dz * mask1[2]]
        const side2Dir: [number, number, number] = [dx * mask2[0], dy * mask2[1], dz * mask2[2]]

        const dirVec = new Vec3(dir[0], dir[1], dir[2])

        const side1LightDir = getVec(new Vec3(side1Dir[0], side1Dir[1], side1Dir[2]), dirVec)
        const side2LightDir = getVec(new Vec3(side2Dir[0], side2Dir[1], side2Dir[2]), dirVec)
        const cornerLightDir = getVec(new Vec3(cornerDir[0], cornerDir[1], cornerDir[2]), dirVec)

        const s1 = sampleChannelLightAt(world, cursor.plus(side1LightDir))
        const s2 = sampleChannelLightAt(world, cursor.plus(side2LightDir))
        const sc = sampleChannelLightAt(world, cursor.plus(cornerLightDir))
        blockNorm = (s1.block + s2.block + sc.block + baseChannels.block) / 4
        skyNorm = (s1.sky + s2.sky + sc.sky + baseChannels.sky) / 4
      }

      colors.push(tint[0], tint[1], tint[2])
      skyLights.push(skyNorm)
      blockLights.push(blockNorm)
    }

    indices.push(baseIndex, baseIndex + 1, baseIndex + 2, baseIndex + 2, baseIndex + 1, baseIndex + 3)

    const dupBase = positions.length / 3
    for (let v = 0; v < 4; v++) {
      const src = (baseIndex + v) * 3
      positions.push(positions[src]!, positions[src + 1]!, positions[src + 2]!)
      normals.push(-dir[0], -dir[1], -dir[2])
      const uvSrc = (baseIndex + v) * 2
      uvs.push(uvs[uvSrc]!, uvs[uvSrc + 1]!)
      colors.push(colors[src]!, colors[src + 1]!, colors[src + 2]!)
      skyLights.push(skyLights[src / 3]!)
      blockLights.push(blockLights[src / 3]!)
    }
    indices.push(dupBase, dupBase + 2, dupBase + 1, dupBase + 1, dupBase + 2, dupBase + 3)
  }
}

export type RenderWasmOptions = {
  /** Section height in blocks. Shader-cube path requires 16; other values keep legacy. */
  sectionHeight?: number
  /**
   * Pack full-cube blocks into instanced shader words.
   * Set false in parity tests that expect legacy vertex buffers only.
   */
  shaderCubes?: boolean
}

/**
 * Render WASM mesher output to Three.js geometry
 */
export function renderWasmOutputToGeometry(
  wasmOutput: WasmGeometryOutput,
  version: string,
  sectionKey: string,
  sectionPosition: { x: number; y: number; z: number },
  world?: World,
  options?: RenderWasmOptions
): ExportedSection {
  const DEBUG = false
  const log = (...args) => {
    if (DEBUG) {
      console.log(...args)
    }
  }

  const mcData = MinecraftData(version)
  const PrismarineBlock = PrismarineBlockLoader(version)

  let blockProvider: WorldBlockProvider
  if ((globalThis as any).blockProvider) {
    blockProvider = (globalThis as any).blockProvider
  } else if (typeof worldBlockProvider === 'function') {
    blockProvider = worldBlockProvider(blockStatesModels, blocksAtlasesJson, version)
  } else {
    const wbp = require('mc-assets/dist/worldBlockProvider')
    blockProvider = (wbp.default || wbp)(blockStatesModels, blocksAtlasesJson, version)
  }

  // Initialize tints if world is provided
  if (world) {
    initializeTints()
  }

  const positions: number[] = []
  const normals: number[] = []
  const colors: number[] = []
  const skyLights: number[] = []
  const blockLights: number[] = []
  const uvs: number[] = []
  const indices: number[] = []

  const blendPositions: number[] = []
  const blendNormals: number[] = []
  const blendColors: number[] = []
  const blendSkyLights: number[] = []
  const blendBlockLights: number[] = []
  const blendUvs: number[] = []
  const blendIndices: number[] = []

  const liquidQueue: Array<{
    pos: Vec3
    type: number
    biome: string
    water: boolean
    isRealWater: boolean
  }> = []

  const sectionHeight = options?.sectionHeight ?? SECTION_HEIGHT
  const shaderCubesEnabled = options?.shaderCubes !== false
  const [sectionOx, sectionOy, sectionOz] = sectionKey.split(',').map(v => parseInt(v, 10))
  const shaderWordBuffer: number[] = []
  const shaderResources = shaderCubesEnabled ? getShaderCubeResources() : null

  for (const block of wasmOutput.blocks) {
    const [bx, by, bz] = block.position
    const blockStateId = block.block_state_id

    const prismBlock = PrismarineBlock.fromStateId(blockStateId, 1)

    let biome: string | undefined
    if (world) {
      const blockObj = world.getBlock(new Vec3(bx, by, bz))
      biome = blockObj?.biome?.name
    }

    if (world) {
      const waterlogged = prismBlock.name !== 'water' && prismBlock.name !== 'lava' && isBlockWaterlogged(prismBlock)

      if (prismBlock.name === 'water' || waterlogged) {
        liquidQueue.push({
          pos: new Vec3(bx, by, bz),
          type: prismBlock.type,
          biome: biome || 'plains',
          water: true,
          isRealWater: prismBlock.name === 'water' && !waterlogged
        })
      }

      if (prismBlock.name === 'lava') {
        liquidQueue.push({
          pos: new Vec3(bx, by, bz),
          type: prismBlock.type,
          biome: biome || 'plains',
          water: false,
          isRealWater: false
        })
      }

      if (prismBlock.name === 'water' || prismBlock.name === 'lava') {
        continue
      }
    }

    const cachedModel = getCachedBlockModel(blockStateId, version, blockProvider, PrismarineBlock, world, { x: bx, y: by, z: bz })
    if (!cachedModel) continue

    const neighborStateIdCache = new Map<string, number | null>()

    if (shaderResources) {
      const modelVars = cachedModel.models[0]
      const model = modelVars?.[0]
      const element = model?.elements?.[0]
      if (model && element) {
        const doAO = (model as { ao?: boolean }).ao ?? cachedModel.boundingBox !== 'empty'

        let forceCullMask = 0
        if (world) {
          const shaderCubeFaceNameToIndex: Record<string, number> = {
            up: 0,
            down: 1,
            east: 2,
            west: 3,
            south: 4,
            north: 5
          }
          for (const faceName of ['up', 'down', 'east', 'west', 'south', 'north'] as const) {
            const faceIdx = shaderCubeFaceNameToIndex[faceName]
            if ((block.visible_faces & (1 << faceIdx)) === 0) continue
            const dir = elemFaces[faceName].dir as [number, number, number]
            const dirKey = `${dir[0]},${dir[1]},${dir[2]}`
            let neighborStateId = neighborStateIdCache.get(dirKey)
            if (neighborStateId === undefined) {
              const neighborBlock = world.getBlock(new Vec3(bx, by, bz).offset(...dir))
              neighborStateId = neighborBlock?.stateId ?? null
              neighborStateIdCache.set(dirKey, neighborStateId)
            }
            if (
              neighborStateId !== null &&
              faceIsCulled(version, element, faceName, neighborStateId, { stateId: blockStateId, name: prismBlock.name }, blockProvider, dir, null)
            ) {
              forceCullMask |= 1 << faceIdx
            }
          }
        }

        const emitted = tryBuildShaderCubeInstances(
          block,
          {
            blockName: cachedModel.blockName,
            blockProps: cachedModel.blockProps,
            isCube: cachedModel.isCube,
            model
          },
          model,
          {
            sectionOrigin: { x: sectionOx, y: sectionOy, z: sectionOz },
            sectionHeight,
            biome,
            tintPalette: shaderResources.tintPalette,
            textureIndexMapping: shaderResources.textureIndexMapping,
            doAO,
            forceCullMask
          },
          shaderWordBuffer
        )
        if (emitted) continue
      }
    }

    const models = cachedModel.models
    if (!models || models.length == 0) continue

    const routeToBlend = prismBlock.transparent && isSemiTransparentBlockName(cachedModel.blockName)
    const tgtPos = routeToBlend ? blendPositions : positions
    const tgtNorm = routeToBlend ? blendNormals : normals
    const tgtCol = routeToBlend ? blendColors : colors
    const tgtSky = routeToBlend ? blendSkyLights : skyLights
    const tgtBlock = routeToBlend ? blendBlockLights : blockLights
    const tgtUv = routeToBlend ? blendUvs : uvs
    const tgtIdx = routeToBlend ? blendIndices : indices

    const faceNameToIndex: Record<string, number> = {
      up: 0,
      down: 1,
      east: 2,
      west: 3,
      south: 4,
      north: 5
    }

    const dirKeyToIndex: Record<string, number> = {
      '0,1,0': 0,
      '0,-1,0': 1,
      '1,0,0': 2,
      '-1,0,0': 3,
      '0,0,1': 4,
      '0,0,-1': 5
    }

    const wasmFaceOrder = ['up', 'down', 'east', 'west', 'south', 'north']
    const wasmFaceToDataIndex: Record<number, number> = {}
    let dataIndex = 0
    for (const faceName of wasmFaceOrder) {
      const faceIdx = faceNameToIndex[faceName]
      if ((block.visible_faces & (1 << faceIdx)) !== 0) {
        wasmFaceToDataIndex[faceIdx] = dataIndex++
      }
    }

    for (const modelVars of models ?? []) {
      const model = modelVars[0]
      if (!model) continue

      let globalMatrix = null as any
      let globalShift = null as any
      for (const axis of ['x', 'y', 'z'] as const) {
        if (axis in model) {
          globalMatrix = globalMatrix
            ? matmulmat3(globalMatrix, buildRotationMatrix(axis, -(model[axis] ?? 0)))
            : buildRotationMatrix(axis, -(model[axis] ?? 0))
        }
      }
      if (globalMatrix) {
        globalShift = [8, 8, 8]
        globalShift = vecsub3(globalShift, matmul3(globalMatrix, globalShift))
      }

      // Mirror JS mesher: doAO = model.ao ?? block.boundingBox !== 'empty'.
      // When false, faces are emitted full-bright without AO/light sampling and without
      // triangle-flip reordering (matches JS `light = 1` and standard winding).
      const doAO = (model as any).ao ?? cachedModel.boundingBox !== 'empty'

      for (const element of model.elements ?? []) {
        let localMatrix = null as any
        let localShift = null as any
        if (element.rotation) {
          ;({ localMatrix, localShift } = buildElementRotation(element.rotation))
        }

        // eslint-disable-next-line guard-for-in
        for (const faceName in element.faces) {
          const matchingEFace = element.faces[faceName]
          const { dir, corners, mask1, mask2 } = elemFaces[faceName]

          const transformedDir = matmul3(globalMatrix, dir)
          const transformedDirI: [number, number, number] = [Math.round(transformedDir[0]), Math.round(transformedDir[1]), Math.round(transformedDir[2])]
          const dirKey = `${transformedDirI[0]},${transformedDirI[1]},${transformedDirI[2]}`
          // faceIdx may be undefined for diagonal-rotated faces (e.g. signs at 45/135/225/315 deg).
          // Such faces are not representable in the 6-axis WASM visible_faces / ao_data / light_data
          // arrays. We still emit them (mirrors JS mesher behavior); cullface and AO/light data
          // lookups are skipped, and the model-lighting fallback below derives AO/light by
          // sampling neighbors via transformedDirI (its rounded form, same as for cardinal axes).
          const faceIdx = dirKeyToIndex[dirKey]

          const minx = element.from[0]
          const miny = element.from[1]
          const minz = element.from[2]
          const maxx = element.to[0]
          const maxy = element.to[1]
          const maxz = element.to[2]

          if (faceIdx !== undefined && (block.visible_faces & (1 << faceIdx)) === 0) {
            continue
          }

          if (matchingEFace.cullface && world) {
            let neighborStateId = neighborStateIdCache.get(dirKey)
            if (neighborStateId === undefined) {
              const neighborBlock = world.getBlock(new Vec3(bx, by, bz).offset(...transformedDirI))
              neighborStateId = neighborBlock?.stateId ?? null
              neighborStateIdCache.set(dirKey, neighborStateId)
            }
            if (
              neighborStateId !== null &&
              faceIsCulled(
                version,
                element,
                faceName,
                neighborStateId,
                { stateId: blockStateId, name: prismBlock.name },
                blockProvider,
                transformedDirI,
                globalMatrix
              )
            ) {
              continue
            }
          }

          const faceDataIndex = faceIdx === undefined ? undefined : wasmFaceToDataIndex[faceIdx]
          const aoValuesRaw = faceDataIndex === undefined ? undefined : block.ao_data[faceDataIndex]
          const skyValuesRaw = faceDataIndex === undefined ? undefined : block.sky_light_data?.[faceDataIndex]
          const blockValuesRaw = faceDataIndex === undefined ? undefined : block.block_light_data?.[faceDataIndex]
          const lightValuesRaw = faceDataIndex === undefined ? undefined : block.light_data?.[faceDataIndex]

          const texture = matchingEFace.texture as any
          const u = texture.u || 0
          const v = texture.v || 0
          const su = texture.su || 1
          const sv = texture.sv || 1

          let r = matchingEFace.rotation || 0
          if (faceName === 'down') {
            r += 180
          }
          const uvcs = Math.cos((r * Math.PI) / 180)
          const uvsn = -Math.sin((r * Math.PI) / 180)

          const tint = getTint(matchingEFace, cachedModel.blockName, cachedModel.blockProps, biome, world)

          const baseIndex = tgtPos.length / 3
          const computedAoValues = [3, 3, 3, 3]
          for (let cornerIdx = 0; cornerIdx < 4; cornerIdx++) {
            const pos = corners[cornerIdx]

            let vertex = [pos[0] ? maxx : minx, pos[1] ? maxy : miny, pos[2] ? maxz : minz]

            vertex = vecadd3(matmul3(localMatrix, vertex), localShift)
            vertex = vecadd3(matmul3(globalMatrix, vertex), globalShift)
            vertex = vertex.map(v => v / 16)

            const worldPos = [vertex[0] + (bx & 15) - 8, vertex[1] + (by & 15) - 8, vertex[2] + (bz & 15) - 8]

            tgtPos.push(...worldPos)

            tgtNorm.push(transformedDir[0], transformedDir[1], transformedDir[2])

            const useModelLighting = (!cachedModel.isCube || globalMatrix != null) && world

            let ao = 3
            let skyLightNorm = 1
            let blockLightNorm = 0
            const faceDir = transformedDirI as [number, number, number]

            if (!doAO) {
              computedAoValues[cornerIdx] = 3
            } else if (useModelLighting) {
              const cursor = new Vec3(bx, by, bz)

              const dx = pos[0] * 2 - 1
              const dy = pos[1] * 2 - 1
              const dz = pos[2] * 2 - 1

              const cornerDir = matmul3(globalMatrix, [dx, dy, dz])
              const side1Dir = matmul3(globalMatrix, [dx * mask1[0], dy * mask1[1], dz * mask1[2]])
              const side2Dir = matmul3(globalMatrix, [dx * mask2[0], dy * mask2[1], dz * mask2[2]])

              const cornerDirI: [number, number, number] = [Math.round(cornerDir[0]), Math.round(cornerDir[1]), Math.round(cornerDir[2])]
              const side1DirI: [number, number, number] = [Math.round(side1Dir[0]), Math.round(side1Dir[1]), Math.round(side1Dir[2])]
              const side2DirI: [number, number, number] = [Math.round(side2Dir[0]), Math.round(side2Dir[1]), Math.round(side2Dir[2])]

              const side1 = world.getBlock(cursor.offset(side1DirI[0], side1DirI[1], side1DirI[2]))
              const side2 = world.getBlock(cursor.offset(side2DirI[0], side2DirI[1], side2DirI[2]))
              const corner = world.getBlock(cursor.offset(cornerDirI[0], cornerDirI[1], cornerDirI[2]))

              const side1Block = world.shouldMakeAo(side1) ? 1 : 0
              const side2Block = world.shouldMakeAo(side2) ? 1 : 0
              const cornerBlock = world.shouldMakeAo(corner) ? 1 : 0

              ao = side1Block && side2Block ? 0 : 3 - (side1Block + side2Block + cornerBlock)
              computedAoValues[cornerIdx] = ao

              const cornerDirL = matmul3(globalMatrix, [dx, dy, dz])
              const cornerOffsetI: [number, number, number] = [Math.round(cornerDirL[0]), Math.round(cornerDirL[1]), Math.round(cornerDirL[2])]
              const channels = smoothChannelLightAt(world, cursor, faceDir, cornerOffsetI, faceIdx ?? 0)
              skyLightNorm = channels.sky
              blockLightNorm = channels.block
            } else {
              const aoValues = aoValuesRaw ?? [3, 3, 3, 3]

              ao = aoValues[cornerIdx] ?? 3
              computedAoValues[cornerIdx] = ao

              if (skyValuesRaw && blockValuesRaw) {
                skyLightNorm = skyValuesRaw[cornerIdx] ?? 1
                blockLightNorm = blockValuesRaw[cornerIdx] ?? 0
              } else {
                const combined = lightValuesRaw?.[cornerIdx] ?? 1
                skyLightNorm = combined
                blockLightNorm = 0
              }
            }

            const tintAo = vertexTintAoColor(world, tint, ao, faceDir)
            tgtCol.push(tintAo[0], tintAo[1], tintAo[2])
            tgtSky.push(skyLightNorm)
            tgtBlock.push(blockLightNorm)

            const baseu = (pos[3] - 0.5) * uvcs - (pos[4] - 0.5) * uvsn + 0.5
            const basev = (pos[3] - 0.5) * uvsn + (pos[4] - 0.5) * uvcs + 0.5
            const finalU = baseu * su + u
            const finalV = basev * sv + v
            tgtUv.push(finalU, finalV)
          }

          const aoValues = computedAoValues

          let tri1: number[], tri2: number[]
          if (doAO && aoValues[0] + aoValues[3] >= aoValues[1] + aoValues[2]) {
            tri1 = [baseIndex, baseIndex + 3, baseIndex + 2]
            tri2 = [baseIndex, baseIndex + 1, baseIndex + 3]
          } else {
            tri1 = [baseIndex, baseIndex + 1, baseIndex + 2]
            tri2 = [baseIndex + 2, baseIndex + 1, baseIndex + 3]
          }
          tgtIdx.push(...tri1, ...tri2)
        }
      }
    }
  }

  if (world && liquidQueue.length) {
    const waterTex = (blockProvider as any).getTextureInfo?.('water_still')
    const lavaTex = (blockProvider as any).getTextureInfo?.('lava_still')

    for (const q of liquidQueue) {
      const tex = q.water ? waterTex : lavaTex
      if (!tex) continue
      renderLiquidToGeometry(
        world,
        q.pos,
        tex,
        q.type,
        q.biome,
        q.water,
        q.isRealWater,
        blendPositions,
        blendNormals,
        blendColors,
        blendSkyLights,
        blendBlockLights,
        blendUvs,
        blendIndices
      )
    }
  }

  const shaderCubes = buildShaderCubesFromWords(shaderWordBuffer)

  const result: ExportedSection = {
    key: sectionKey,
    position: sectionPosition,
    geometry: {
      positions,
      normals,
      colors,
      skyLights,
      blockLights,
      uvs,
      indices
    },
    ...(blendPositions.length > 0
      ? {
          blendGeometry: {
            positions: blendPositions,
            normals: blendNormals,
            colors: blendColors,
            skyLights: blendSkyLights,
            blockLights: blendBlockLights,
            uvs: blendUvs,
            indices: blendIndices
          }
        }
      : {}),
    ...(shaderCubes ? { shaderCubes } : {})
  }

  log(`[WASM] Final geometry summary:`)
  log(`[WASM]   Total vertices: ${positions.length / 3}`)
  log(`[WASM]   Total triangles: ${indices.length / 3}`)
  log(`[WASM]   Positions: [${positions.slice(0, 12).join(',')}...] (first 4 vertices)`)
  log(`[WASM]   Indices: [${indices.slice(0, 12).join(',')}...] (first 2 faces)`)

  return result
}

/**
 * Split a single full-column WASM mesher result into per-section
 * `ExportedSection` outputs by filtering `wasmResult.blocks` per requested
 * section's Y range and invoking `renderWasmOutputToGeometry` once per
 * section.
 *
 * Why split at the block level (and not after geometry generation):
 *   - Liquids (water/lava), signs/heads/banners metadata, AO/light arrays
 *     and index numbering are computed inside `renderWasmOutputToGeometry`.
 *     Splitting *finished* vertex/index buffers would silently break those.
 *   - Filtering blocks by Y range and re-running the post-processor per
 *     section keeps the output identical to the existing per-section path.
 *
 * Y=15/16 (and any other inter-section) seam handling:
 *   - The Rust mesher produced `wasmResult` over the full column, so each
 *     block's `visible_faces`, `ao_data` and `light_data` already account
 *     for its true neighbors — including the block above at the section
 *     seam (e.g. a Y=15 top face is correctly suppressed when Y=16 is
 *     opaque, even though Y=16 lives in the next render section).
 *   - This helper therefore does NOT need to widen the per-section block
 *     window: a strict `[sy*sectionHeight, sy*sectionHeight + sectionHeight)`
 *     filter on `block.position[1]` is sufficient. The neighbor information
 *     is already baked into each block's per-face mask/AO/light arrays.
 *
 * Empty sections: sections with no blocks in range still get a call into
 * `renderWasmOutputToGeometry` with an empty `blocks` array, so the
 * returned `ExportedSection` shape matches what the per-section path
 * produces for an empty section (empty positions/normals/colors/uvs/
 * indices arrays).
 *
 * Note: this pure helper is not gated internally; callers decide whether
 * column meshing is enabled.
 */
export function splitColumnWasmOutputToSections(
  fullColumnOutput: WasmGeometryOutput,
  requestedSectionKeys: Array<{ x: number; y: number; z: number }>,
  ctx: { version: string; world?: World; sectionHeight?: number; shaderCubes?: boolean }
): Map<string, { exported: ExportedSection; blocksCount: number }> {
  const { version, world } = ctx
  const sectionHeight = ctx.sectionHeight ?? SECTION_HEIGHT

  // Bucket blocks by section Y once, so we don't re-scan the full column
  // for every requested section. Bucket key = section-relative chunk Y
  // (i.e. floor(by / sectionHeight)).
  const blocksByChunkY = new Map<number, WasmBlockFaceData[]>()
  for (const block of fullColumnOutput.blocks) {
    const by = block.position[1]
    const chunkY = Math.floor(by / sectionHeight)
    let bucket = blocksByChunkY.get(chunkY)
    if (!bucket) {
      bucket = []
      blocksByChunkY.set(chunkY, bucket)
    }
    bucket.push(block)
  }

  const out = new Map<string, { exported: ExportedSection; blocksCount: number }>()
  for (const { x, y, z } of requestedSectionKeys) {
    // `y` here is the section's world-Y origin (multiple of sectionHeight),
    // matching the convention used by `mesherWasm.ts` (section keys are
    // `${chunkX*16},${sectionY},${chunkZ*16}` with sectionY a world-Y
    // multiple of 16). Translate to chunk-Y bucket index.
    const chunkY = Math.floor(y / sectionHeight)
    const sectionBlocks = blocksByChunkY.get(chunkY) ?? []

    const sectionView: WasmGeometryOutput = {
      blocks: sectionBlocks,
      block_count: sectionBlocks.length,
      block_iterations: fullColumnOutput.block_iterations
    }

    const sectionKey = `${x},${y},${z}`
    const sectionPosition = { x: x + 8, y: y + 8, z: z + 8 }
    const exported = renderWasmOutputToGeometry(sectionView, version, sectionKey, sectionPosition, world, { sectionHeight, shaderCubes: ctx.shaderCubes })
    out.set(sectionKey, { exported, blocksCount: sectionBlocks.length })
  }

  return out
}

/**
 * Convert WASM output to exported geometry format
 */
export function wasmOutputToExportFormat(
  wasmOutput: WasmGeometryOutput,
  version: string,
  sectionKey: string,
  sectionPosition: { x: number; y: number; z: number },
  cameraPosition = { x: 0, y: 0, z: 0 },
  cameraRotation = { pitch: 0, yaw: 0 },
  world?: World
): ExportedWorldGeometry {
  const section = renderWasmOutputToGeometry(wasmOutput, version, sectionKey, sectionPosition, world, {
    shaderCubes: true
  })

  return {
    version,
    exportedAt: new Date().toISOString(),
    camera: {
      position: cameraPosition,
      rotation: cameraRotation
    },
    sections: [section]
  }
}

/**
 * Convert mesher geometry output to exported geometry format
 * Takes the output from getSectionGeometry() and converts it to ExportedWorldGeometry
 */
export function mesherGeometryToExportFormat(
  mesherGeometry: MesherGeometryOutput,
  version: string,
  cameraPosition = { x: 0, y: 0, z: 0 },
  cameraRotation = { pitch: 0, yaw: 0 },
  skyLevel = 1
): ExportedWorldGeometry {
  const positions = Array.from(mesherGeometry.positions) as number[]
  const normals = mesherGeometry.normals ? (Array.from(mesherGeometry.normals) as number[]) : []
  const tintColors = mesherGeometry.colors ? (Array.from(mesherGeometry.colors) as number[]) : []
  const skyLights = mesherGeometry.skyLights ? (Array.from(mesherGeometry.skyLights) as number[]) : []
  const blockLights = mesherGeometry.blockLights ? (Array.from(mesherGeometry.blockLights) as number[]) : []
  const colors = skyLights.length ? bakeLegacyVertexColors(tintColors, skyLights, blockLights, skyLevel) : tintColors
  const uvs = mesherGeometry.uvs ? (Array.from(mesherGeometry.uvs) as number[]) : []
  const indices = Array.from(mesherGeometry.indices) as number[]

  // Generate section key from chunk key and section coordinates, or use chunk key directly
  const sectionKey = mesherGeometry.chunkKey || `${mesherGeometry.sx},${mesherGeometry.sy},${mesherGeometry.sz}`

  // Use section coordinates for position
  const sectionPosition = {
    x: mesherGeometry.sx,
    y: mesherGeometry.sy,
    z: mesherGeometry.sz
  }

  const section: ExportedSection = {
    key: sectionKey,
    position: sectionPosition,
    geometry: {
      positions,
      normals,
      colors,
      skyLights,
      blockLights,
      uvs,
      indices
    },
    ...(mesherGeometry.blend
      ? {
          blendGeometry: {
            positions: Array.from(mesherGeometry.blend.positions),
            normals: Array.from(mesherGeometry.blend.normals),
            colors: bakeLegacyVertexColors(
              Array.from(mesherGeometry.blend.colors),
              Array.from(mesherGeometry.blend.skyLights),
              Array.from(mesherGeometry.blend.blockLights),
              skyLevel
            ),
            skyLights: Array.from(mesherGeometry.blend.skyLights),
            blockLights: Array.from(mesherGeometry.blend.blockLights),
            uvs: Array.from(mesherGeometry.blend.uvs),
            indices: Array.from(mesherGeometry.blend.indices)
          }
        }
      : {})
  }

  return {
    version,
    exportedAt: new Date().toISOString(),
    camera: {
      position: cameraPosition,
      rotation: cameraRotation
    },
    sections: [section]
  }
}
