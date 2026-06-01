// Renderer that converts WASM mesher output to Three.js geometry
// This file takes WASM output and generates full Three.js buffer geometry

import * as THREE from 'three'
import worldBlockProviderModule, { WorldBlockProvider } from 'mc-assets/dist/worldBlockProvider'
import blocksAtlasesJson from 'mc-assets/dist/blocksAtlases.json'
import blockStatesModels from 'mc-assets/dist/blockStatesModels.json'
import MinecraftData from 'minecraft-data'
import PrismarineBlockLoader from 'prismarine-block'
import { Vec3 } from 'vec3'
import { elemFaces, buildRotationMatrix, matmul3, matmulmat3, vecadd3, vecsub3 } from '../../mesher-shared/modelsGeometryCommon'
import type { ExportedWorldGeometry, ExportedSection } from '../../three/worldGeometryExport'
import type { MesherGeometryOutput } from '../../mesher-shared/shared'
import type { World } from '../../mesher-shared/world'
import { resolveBlockPropertiesForMeshing } from '../../mesher-shared/models'
import { getSideShading, vertexLightFromAo } from '../../mesher-shared/vertexShading'

// Handle both default and named export
const worldBlockProvider = (worldBlockProviderModule as any).default || worldBlockProviderModule

// Initialize tints (same as in models.ts)
const tints: any = {}
let tintsInitialized = false

function initializeTints() {
  if (tintsInitialized) return
  let tintsData
  try {
    tintsData = require('esbuild-data').tints
  } catch (err) {
    tintsData = require('minecraft-data/minecraft-data/data/pc/1.16.2/tints.json')
  }
  for (const key of Object.keys(tintsData)) {
    tints[key] = prepareTints(tintsData[key])
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
  light_data: number[][]
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
export function extractColumnHeightmap(
  wasmOutput: { heightmap?: ArrayLike<number> | null } | null | undefined
): Int16Array | null {
  const raw = wasmOutput?.heightmap
  if (!raw || raw.length !== 256) return null
  if (raw instanceof Int16Array) return new Int16Array(raw)
  const out = new Int16Array(256)
  for (let i = 0; i < 256; i++) out[i] = raw[i]
  return out
}

function computeMesherVertexLight(
  world: World | undefined,
  ao: number,
  cornerLight15: number,
  faceDir: [number, number, number]
): number {
  const shadingTheme = world?.config.shadingTheme ?? 'high-contrast'
  const cardinalLight = world?.config.cardinalLight ?? 'default'
  const sideShading = getSideShading(faceDir, shadingTheme, cardinalLight)
  return vertexLightFromAo(ao, cornerLight15, sideShading, shadingTheme)
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
  blockPos?: { x: number, y: number, z: number }
): CachedBlockModel | null {
  const usePreflat = !!(world?.preflat && blockPos)
  let blockName: string
  let blockProps: Record<string, unknown>
  if (usePreflat) {
    const resolved = resolveBlockPropertiesForMeshing(
      world,
      new Vec3(blockPos!.x, blockPos!.y, blockPos!.z),
      blockProvider,
      blockStateId,
      PrismarineBlock
    )
    blockName = resolved.name
    blockProps = resolved.properties
  } else {
    const blockObj = PrismarineBlock.fromStateId(blockStateId, 1)
    blockName = blockObj.name
    blockProps = blockObj.getProperties()
  }

  const cacheKey = usePreflat
    ? `${version}:${blockStateId}:${blockName}:${JSON.stringify(blockProps)}`
    : `${version}:${blockStateId}`
  if (!(globalThis as any).__wasmBlockModelCache) {
    (globalThis as any).__wasmBlockModelCache = new Map()
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

    const models = blockProvider.getAllResolvedModels0_1(
      { name: blockName, properties: blockProps as Record<string, string | number | boolean> },
      false
    )

    if (!models || models.length === 0) return null

    // Precompute matrices for all model variants
    const modelVariants = models.map((modelVars) => {
      return modelVars.map((model) => {
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
            localMatrix = buildRotationMatrix(
              element.rotation.axis,
              element.rotation.angle
            )
            localShift = vecsub3(
              element.rotation.origin,
              matmul3(localMatrix, element.rotation.origin)
            )
          }
          return { element, localMatrix, localShift }
        })

        return { model, globalMatrix, globalShift, elements }
      })
    }).flat()

    const isCube = (() => {
      try {
        if (!models?.length || models.length !== 1) return false
        if (blockObj.transparent) return false
        return models[0].every((v) => v.elements.every((e) => {
          return e.from[0] === 0 && e.from[1] === 0 && e.from[2] === 0 && e.to[0] === 16 && e.to[1] === 16 && e.to[2] === 16
        }))
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
      boundingBox: blockObj.boundingBox,
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
    } else if (
      blockName === 'birch_leaves' ||
      blockName === 'spruce_leaves' ||
      blockName === 'lily_pad'
    ) {
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

const ALWAYS_WATERLOGGED = new Set([
  'seagrass',
  'tall_seagrass',
  'kelp',
  'kelp_plant',
  'bubble_column'
])

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
  uvs: number[],
  indices: number[],
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

    const baseLight = world.getLight(neighborPos, undefined, undefined, water ? 'water' : 'lava') / 15

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

      let cornerLightResult = baseLight
      if (world.config.smoothLighting) {
        const dx = pos[0] * 2 - 1
        const dy = pos[1] * 2 - 1
        const dz = pos[2] * 2 - 1
        const cornerDir: [number, number, number] = [dx, dy, dz]
        const side1Dir: [number, number, number] = [dx * mask1[0], dy * mask1[1], dz * mask1[2]]
        const side2Dir: [number, number, number] = [dx * mask2[0], dy * mask2[1], dz * mask2[2]]

        const dirVec = new Vec3(dir[0], dir[1], dir[2])

        const side1LightDir = getVec(new Vec3(side1Dir[0], side1Dir[1], side1Dir[2]), dirVec)
        const side1Light = world.getLight(cursor.plus(side1LightDir)) / 15
        const side2DirLight = getVec(new Vec3(side2Dir[0], side2Dir[1], side2Dir[2]), dirVec)
        const side2Light = world.getLight(cursor.plus(side2DirLight)) / 15
        const cornerLightDir = getVec(new Vec3(cornerDir[0], cornerDir[1], cornerDir[2]), dirVec)
        const cornerLight = world.getLight(cursor.plus(cornerLightDir)) / 15

        cornerLightResult = (side1Light + side2Light + cornerLight + baseLight) / 4
      }

      colors.push(tint[0] * cornerLightResult, tint[1] * cornerLightResult, tint[2] * cornerLightResult)
    }

    indices.push(
      baseIndex,
      baseIndex + 1,
      baseIndex + 2,
      baseIndex + 2,
      baseIndex + 1,
      baseIndex + 3,
      baseIndex,
      baseIndex + 2,
      baseIndex + 1,
      baseIndex + 2,
      baseIndex + 3,
      baseIndex + 1,
    )
  }
}

/**
 * Render WASM mesher output to Three.js geometry
 */
export function renderWasmOutputToGeometry(
  wasmOutput: WasmGeometryOutput,
  version: string,
  sectionKey: string,
  sectionPosition: { x: number, y: number, z: number },
  world?: World
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
  const uvs: number[] = []
  const indices: number[] = []

  const liquidQueue: Array<{
    pos: Vec3,
    type: number,
    biome: string,
    water: boolean,
    isRealWater: boolean,
  }> = []

  let currentIndex = 0

  for (const block of wasmOutput.blocks) {
    const [bx, by, bz] = block.position
    const blockStateId = block.block_state_id

    log(`[WASM] Processing block at (${bx}, ${by}, ${bz}), stateId=${blockStateId}, visible_faces=0b${block.visible_faces.toString(2).padStart(6, '0')}`)

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
          isRealWater: prismBlock.name === 'water' && !waterlogged,
        })
      }

      if (prismBlock.name === 'lava') {
        liquidQueue.push({
          pos: new Vec3(bx, by, bz),
          type: prismBlock.type,
          biome: biome || 'plains',
          water: false,
          isRealWater: false,
        })
      }

      if (prismBlock.name === 'water' || prismBlock.name === 'lava') {
        continue
      }
    }

    const cachedModel = getCachedBlockModel(
      blockStateId,
      version,
      blockProvider,
      PrismarineBlock,
      world,
      { x: bx, y: by, z: bz }
    )
    if (!cachedModel) continue

    if (false) {
      // For now, use first model variant (can be extended later)
      const modelVariant = cachedModel!.modelVariants[0]
      if (!modelVariant) continue

      const { model, globalMatrix, globalShift, elements } = modelVariant

      // Get biome for tint calculation if world is provided
      let biome: string | undefined
      if (world) {
        const blockObj = world!.getBlock(new Vec3(bx, by, bz))
        biome = blockObj?.biome?.name
      }

      // Process faces in the same order as TypeScript (iterate through model's faces)
      // TypeScript uses: for (const face in element.faces)
      // We need to match this order to get the same vertex ordering

      // Find the element that contains faces (use cached element data)
      const faceElements = elements.filter(elemData => elemData.element.faces && Object.keys(elemData.element.faces).length > 0)

      if (faceElements.length === 0) continue

      // Map face names to their index in WASM output
      const faceNameToIndex: Record<string, number> = {
        'up': 0,
        'down': 1,
        'east': 2,
        'west': 3,
        'south': 4,
        'north': 5
      }

      // WASM processes faces in fixed order: [up, down, east, west, south, north]
      // Build a mapping from WASM face order to data index
      const wasmFaceOrder = ['up', 'down', 'east', 'west', 'south', 'north']
      const wasmFaceToDataIndex: Record<string, number> = {}
      let dataIndex = 0
      for (const faceName of wasmFaceOrder) {
        const faceIdx = faceNameToIndex[faceName]
        if ((block.visible_faces & (1 << faceIdx)) !== 0) {
          wasmFaceToDataIndex[faceName] = dataIndex++
        }
      }

      // Process faces in the order they appear in the model (matching TS)
      for (const elemData of faceElements) {
        const element = elemData.element
        const localMatrix = elemData.localMatrix
        const localShift = elemData.localShift

        // eslint-disable-next-line guard-for-in
        for (const faceName in element.faces) {
          const faceIdx = faceNameToIndex[faceName]
          if (faceIdx === undefined) continue

          // Check if this face is visible in WASM output
          if ((block.visible_faces & (1 << faceIdx)) === 0) {
            continue
          }

          const matchingEFace = element.faces[faceName]
          const { dir, corners, mask1, mask2 } = elemFaces[faceName]

          // Get the correct data index for this face based on WASM's processing order
          const faceDataIndex = wasmFaceToDataIndex[faceName]
          if (faceDataIndex === undefined) continue

          const aoValues = block.ao_data[faceDataIndex]
          const lightValues = block.light_data[faceDataIndex]

          log(`[WASM]   Face ${faceIdx} (${faceName}): dir=[${dir.join(',')}], ao=[${aoValues.join(',')}], light=[${lightValues.map(l => l.toFixed(3)).join(',')}]`)

          const texture = matchingEFace.texture as any
          const u = texture.u || 0
          const v = texture.v || 0
          const su = texture.su || 1
          const sv = texture.sv || 1

          // UV rotation (matching reference implementation)
          let r = matchingEFace.rotation || 0
          if (faceName === 'down') {
            r += 180
          }
          const uvcs = Math.cos(r * Math.PI / 180)
          const uvsn = -Math.sin(r * Math.PI / 180)

          // Get tint (use cached model data and world if available)
          const tint = getTint(matchingEFace, cachedModel!.blockName, cachedModel!.blockProps, biome, world)

          const minx = element.from[0]
          const miny = element.from[1]
          const minz = element.from[2]
          const maxx = element.to[0]
          const maxy = element.to[1]
          const maxz = element.to[2]

          // Calculate transformed direction
          const transformedDir = matmul3(globalMatrix, dir)

          // Add 4 vertices for this face
          const baseIndex = currentIndex
          for (let cornerIdx = 0; cornerIdx < 4; cornerIdx++) {
            const pos = corners[cornerIdx]

            // Calculate vertex position (matching reference)
            let vertex = [
              (pos[0] ? maxx : minx),
              (pos[1] ? maxy : miny),
              (pos[2] ? maxz : minz)
            ]

            // Apply element rotation
            vertex = vecadd3(matmul3(localMatrix, vertex), localShift)
            // Apply model rotation
            vertex = vecadd3(matmul3(globalMatrix, vertex), globalShift)
            // Convert to block coordinates (0-1)
            vertex = vertex.map(v => v / 16)

            // World position (relative to section)
            const worldPos = [
              vertex[0] + (bx & 15) - 8,
              vertex[1] + (by & 15) - 8,
              vertex[2] + (bz & 15) - 8
            ]

            log(`[WASM]     Corner ${cornerIdx}: corner=[${pos.join(',')}], vertex=[${vertex.map(v => v.toFixed(3)).join(',')}], worldPos=[${worldPos.map(v => v.toFixed(3)).join(',')}]`)

            positions.push(...worldPos)

            // Normal (transformed direction)
            normals.push(transformedDir[0], transformedDir[1], transformedDir[2])

            // Color (with AO and light from WASM) - matching TS formula exactly
            const ao = aoValues[cornerIdx]

            // TS calculation:
            // baseLight = world.getLight(neighborPos, ...) / 15  (0-1 range)
            // cornerLightResult = baseLight * 15  (0-15 range, or interpolated if smooth lighting)
            // light = (ao + 1) / 4 * (cornerLightResult / 15)
            // finalColor = baseLight * tint * light

            // WASM provides lightValues in 0-1 range (already divided by 15)
            // But WASM light calculation seems to return 0.0, so we need to handle that
            // In the test case, TypeScript gets baseLight = 1.0 (full brightness)
            // So we should use 1.0 as the base light value when WASM returns 0
            const cornerLight15 = (lightValues[cornerIdx] ?? 1) * 15
            const faceDir = transformedDir as [number, number, number]
            const light = computeMesherVertexLight(world, ao, cornerLight15, faceDir)

            colors.push(tint[0] * light, tint[1] * light, tint[2] * light)

            // UV calculation (matching reference exactly)
            const baseu = (pos[3] - 0.5) * uvcs - (pos[4] - 0.5) * uvsn + 0.5
            const basev = (pos[3] - 0.5) * uvsn + (pos[4] - 0.5) * uvcs + 0.5
            const finalU = baseu * su + u
            const finalV = basev * sv + v
            log(`[WASM]       UV: cornerUV=[${pos[3]},${pos[4]}], baseUV=[${baseu.toFixed(6)},${basev.toFixed(6)}], finalUV=[${finalU.toFixed(6)},${finalV.toFixed(6)}], texture=[u=${u},v=${v},su=${su},sv=${sv}], rotation=${r}`)
            uvs.push(finalU, finalV)

            currentIndex++
          }

          // Add indices (2 triangles) - matching TS AO-optimized winding
          // TS uses: if (doAO && aos[0] + aos[3] >= aos[1] + aos[2]) { optimized } else { standard }
          let tri1: number[], tri2: number[]
          if (aoValues[0] + aoValues[3] >= aoValues[1] + aoValues[2]) {
            // AO-optimized winding
            tri1 = [baseIndex, baseIndex + 3, baseIndex + 2]
            tri2 = [baseIndex, baseIndex + 1, baseIndex + 3]
            log(`[WASM]     Indices (AO optimized): tri1=[${tri1.join(',')}], tri2=[${tri2.join(',')}], aos=[${aoValues.join(',')}]`)
          } else {
            // Standard winding
            tri1 = [baseIndex, baseIndex + 1, baseIndex + 2]
            tri2 = [baseIndex + 2, baseIndex + 1, baseIndex + 3]
            log(`[WASM]     Indices (standard): tri1=[${tri1.join(',')}], tri2=[${tri2.join(',')}], aos=[${aoValues.join(',')}]`)
          }
          indices.push(...tri1, ...tri2)
        }
      }
    }

    const models = cachedModel.models
    if (!models || models.length == 0) continue

    const faceNameToIndex: Record<string, number> = {
      'up': 0,
      'down': 1,
      'east': 2,
      'west': 3,
      'south': 4,
      'north': 5
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
          localMatrix = buildRotationMatrix(
            element.rotation.axis,
            element.rotation.angle
          )
          localShift = vecsub3(
            element.rotation.origin,
            matmul3(localMatrix, element.rotation.origin)
          )
        }

        // eslint-disable-next-line guard-for-in
        for (const faceName in element.faces) {
          const matchingEFace = element.faces[faceName]
          const { dir, corners, mask1, mask2 } = elemFaces[faceName]

          const transformedDir = matmul3(globalMatrix, dir)
          const transformedDirI: [number, number, number] = [
            Math.round(transformedDir[0]),
            Math.round(transformedDir[1]),
            Math.round(transformedDir[2]),
          ]
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

          if (matchingEFace.cullface && faceIdx !== undefined) {
            if ((block.visible_faces & (1 << faceIdx)) === 0) {
              continue
            }
          }

          const faceDataIndex = faceIdx === undefined ? undefined : wasmFaceToDataIndex[faceIdx]
          const aoValuesRaw = faceDataIndex === undefined ? undefined : block.ao_data[faceDataIndex]
          const lightValuesRaw = faceDataIndex === undefined ? undefined : block.light_data[faceDataIndex]

          const texture = matchingEFace.texture as any
          const u = texture.u || 0
          const v = texture.v || 0
          const su = texture.su || 1
          const sv = texture.sv || 1

          let r = matchingEFace.rotation || 0
          if (faceName === 'down') {
            r += 180
          }
          const uvcs = Math.cos(r * Math.PI / 180)
          const uvsn = -Math.sin(r * Math.PI / 180)

          const tint = getTint(matchingEFace, cachedModel.blockName, cachedModel.blockProps, biome, world)

          const baseIndex = currentIndex
          const computedAoValues = [3, 3, 3, 3]
          for (let cornerIdx = 0; cornerIdx < 4; cornerIdx++) {
            const pos = corners[cornerIdx]

            let vertex = [
              (pos[0] ? maxx : minx),
              (pos[1] ? maxy : miny),
              (pos[2] ? maxz : minz)
            ]

            vertex = vecadd3(matmul3(localMatrix, vertex), localShift)
            vertex = vecadd3(matmul3(globalMatrix, vertex), globalShift)
            vertex = vertex.map(v => v / 16)

            const worldPos = [
              vertex[0] + (bx & 15) - 8,
              vertex[1] + (by & 15) - 8,
              vertex[2] + (bz & 15) - 8
            ]

            positions.push(...worldPos)

            normals.push(transformedDir[0], transformedDir[1], transformedDir[2])

            const useModelLighting = !cachedModel.isCube && world

            let ao = 3
            let cornerLightResult = 15
            let light: number

            if (!doAO) {
              // JS parity: skip AO/light sampling, emit full-bright vertex.
              computedAoValues[cornerIdx] = 3
              light = 1
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

              ao = (side1Block && side2Block) ? 0 : (3 - (side1Block + side2Block + cornerBlock))
              computedAoValues[cornerIdx] = ao

              const neighborPos = cursor.offset(transformedDirI[0], transformedDirI[1], transformedDirI[2])
              const baseLight15 = world.getLight(neighborPos)

              if (world.config.smoothLighting) {
                const dirVec = new Vec3(transformedDirI[0], transformedDirI[1], transformedDirI[2])
                const getVec = (v: Vec3) => {
                  for (const coord of ['x', 'y', 'z'] as const) {
                    if (Math.abs((dirVec as any)[coord]) > 0) (v as any)[coord] = 0
                  }
                  return v.plus(dirVec)
                }

                const side1LightDir = getVec(new Vec3(side1DirI[0], side1DirI[1], side1DirI[2]))
                const side2LightDir = getVec(new Vec3(side2DirI[0], side2DirI[1], side2DirI[2]))
                const cornerLightDir = getVec(new Vec3(cornerDirI[0], cornerDirI[1], cornerDirI[2]))

                const side1Light = world.getLight(cursor.plus(side1LightDir))
                const side2Light = world.getLight(cursor.plus(side2LightDir))
                const cornerLight = world.getLight(cursor.plus(cornerLightDir))

                cornerLightResult = (side1Light + side2Light + cornerLight + baseLight15) / 4
              } else {
                cornerLightResult = baseLight15
              }
            } else {
              const aoValues = aoValuesRaw ?? [3, 3, 3, 3]
              const lightValues = lightValuesRaw ?? [1, 1, 1, 1]

              ao = aoValues[cornerIdx] ?? 3
              computedAoValues[cornerIdx] = ao

              const baseLight = lightValues[cornerIdx] ?? 1
              cornerLightResult = baseLight * 15
            }

            if (doAO) {
              const faceDir = transformedDirI as [number, number, number]
              light = computeMesherVertexLight(world, ao, cornerLightResult, faceDir)
            }

            colors.push(tint[0] * light!, tint[1] * light!, tint[2] * light!)

            const baseu = (pos[3] - 0.5) * uvcs - (pos[4] - 0.5) * uvsn + 0.5
            const basev = (pos[3] - 0.5) * uvsn + (pos[4] - 0.5) * uvcs + 0.5
            const finalU = baseu * su + u
            const finalV = basev * sv + v
            uvs.push(finalU, finalV)

            currentIndex++
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
          indices.push(...tri1, ...tri2)
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
        positions,
        normals,
        colors,
        uvs,
        indices,
      )
    }
  }

  const result = {
    key: sectionKey,
    position: sectionPosition,
    geometry: {
      positions,
      normals,
      colors,
      uvs,
      indices,
    },
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
  requestedSectionKeys: Array<{ x: number, y: number, z: number }>,
  ctx: { version: string, world?: World, sectionHeight?: number }
): Map<string, { exported: ExportedSection, blocksCount: number }> {
  const { version, world } = ctx
  const sectionHeight = ctx.sectionHeight ?? 16

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

  const out = new Map<string, { exported: ExportedSection, blocksCount: number }>()
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
      block_iterations: fullColumnOutput.block_iterations,
    }

    const sectionKey = `${x},${y},${z}`
    const sectionPosition = { x: x + 8, y: y + 8, z: z + 8 }
    const exported = renderWasmOutputToGeometry(
      sectionView,
      version,
      sectionKey,
      sectionPosition,
      world
    )
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
  sectionPosition: { x: number, y: number, z: number },
  cameraPosition = { x: 0, y: 0, z: 0 },
  cameraRotation = { pitch: 0, yaw: 0 },
  world?: World
): ExportedWorldGeometry {
  const section = renderWasmOutputToGeometry(wasmOutput, version, sectionKey, sectionPosition, world)

  return {
    version,
    exportedAt: new Date().toISOString(),
    camera: {
      position: cameraPosition,
      rotation: cameraRotation,
    },
    sections: [section],
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
  cameraRotation = { pitch: 0, yaw: 0 }
): ExportedWorldGeometry {
  // Convert typed arrays to regular number arrays
  const positions = Array.from(mesherGeometry.positions) as number[]
  const normals = mesherGeometry.normals ? (Array.from(mesherGeometry.normals) as number[]) : []
  const colors = mesherGeometry.colors ? (Array.from(mesherGeometry.colors) as number[]) : []
  const uvs = mesherGeometry.uvs ? (Array.from(mesherGeometry.uvs) as number[]) : []
  const indices = Array.from(mesherGeometry.indices) as number[]

  // Generate section key from chunk key and section coordinates, or use chunk key directly
  const sectionKey = mesherGeometry.chunkKey || `${mesherGeometry.sx},${mesherGeometry.sy},${mesherGeometry.sz}`

  // Use section coordinates for position
  const sectionPosition = {
    x: mesherGeometry.sx,
    y: mesherGeometry.sy,
    z: mesherGeometry.sz,
  }

  const section: ExportedSection = {
    key: sectionKey,
    position: sectionPosition,
    geometry: {
      positions,
      normals,
      colors,
      uvs,
      indices,
    },
  }

  return {
    version,
    exportedAt: new Date().toISOString(),
    camera: {
      position: cameraPosition,
      rotation: cameraRotation,
    },
    sections: [section],
  }
}
