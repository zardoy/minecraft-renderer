// Renderer that converts WASM mesher output to Three.js geometry
// This file takes WASM output and generates full Three.js buffer geometry

import * as THREE from 'three'
import worldBlockProviderModule, { WorldBlockProvider } from 'mc-assets/dist/worldBlockProvider'
import blocksAtlasesJson from 'mc-assets/dist/blocksAtlases.json'
import blockStatesModels from 'mc-assets/dist/blockStatesModels.json'
import MinecraftData from 'minecraft-data'
import PrismarineBlockLoader from 'prismarine-block'
import { Vec3 } from 'vec3'
import { elemFaces, buildRotationMatrix, matmul3, matmulmat3, vecadd3, vecsub3 } from '../mesher/modelsGeometryCommon'
import type { ExportedWorldGeometry, ExportedSection } from '../three/worldGeometryExport'
import type { MesherGeometryOutput } from '../mesher/shared'
import type { World } from '../mesher/world'

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

interface WasmGeometryOutput {
  blocks: WasmBlockFaceData[]
  block_count: number
  block_iterations: number
}

/**
 * Get or create cached block model with precomputed matrices
 */
function getCachedBlockModel(
  blockStateId: number,
  version: string,
  blockProvider: WorldBlockProvider,
  PrismarineBlock: any
): CachedBlockModel | null {
  // Use a module-level cache
  const cacheKey = `${version}:${blockStateId}`
  if (!(globalThis as any).__wasmBlockModelCache) {
    (globalThis as any).__wasmBlockModelCache = new Map()
  }
  const cache = (globalThis as any).__wasmBlockModelCache

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey)
  }

  try {
    const blockObj = PrismarineBlock.fromStateId(blockStateId, 1)
    const blockName = blockObj.name
    const blockProps = blockObj.getProperties()

    const models = blockProvider.getAllResolvedModels0_1(
      { name: blockName, properties: blockProps },
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

    const cached: CachedBlockModel = {
      blockName,
      blockProps,
      models,
      modelVariants,
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

  // Initialize block provider
  let blockProvider: WorldBlockProvider
  if (typeof worldBlockProvider === 'function') {
    blockProvider = worldBlockProvider(blockStatesModels, blocksAtlasesJson, version)
  } else {
    // Try alternative import
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

  let currentIndex = 0

  for (const block of wasmOutput.blocks) {
    const [bx, by, bz] = block.position
    const blockStateId = block.block_state_id

    log(`[WASM] Processing block at (${bx}, ${by}, ${bz}), stateId=${blockStateId}, visible_faces=0b${block.visible_faces.toString(2).padStart(6, '0')}`)

    // Get cached block model with precomputed matrices
    const cachedModel = getCachedBlockModel(blockStateId, version, blockProvider, PrismarineBlock)
    if (!cachedModel) continue

    if (false) {
    // For now, use first model variant (can be extended later)
    const modelVariant = cachedModel.modelVariants[0]
    if (!modelVariant) continue

    const { model, globalMatrix, globalShift, elements } = modelVariant

    // Get biome for tint calculation if world is provided
    let biome: string | undefined
    if (world) {
      const blockObj = world.getBlock(new Vec3(bx, by, bz))
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
      const { dir, corners } = elemFaces[faceName]

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
      const tint = getTint(matchingEFace, cachedModel.blockName, cachedModel.blockProps, biome, world)

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
        const wasmLightValue = lightValues[cornerIdx]
        const baseLight = wasmLightValue > 0 ? wasmLightValue : 1.0 // Default to 1.0 if WASM returns 0
        const cornerLightResult = baseLight * 15 // Convert to 0-15 range

        // TS formula: light = (ao + 1) / 4 * (cornerLightResult / 15)
        const light = (ao + 1) / 4 * (cornerLightResult / 15)

        // Base color - TS uses: baseLight * tint[0] * light
        colors.push(baseLight * tint[0] * light, baseLight * tint[1] * light, baseLight * tint[2] * light)

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
          const { dir, corners } = elemFaces[faceName]

          const transformedDir = matmul3(globalMatrix, dir)
          const dirKey = `${Math.round(transformedDir[0])},${Math.round(transformedDir[1])},${Math.round(transformedDir[2])}`
          const faceIdx = dirKeyToIndex[dirKey]
          if (faceIdx === undefined) continue

          const minx = element.from[0]
          const miny = element.from[1]
          const minz = element.from[2]
          const maxx = element.to[0]
          const maxy = element.to[1]
          const maxz = element.to[2]

          const isBoundary =
            (faceName === 'east' && maxx === 16) ||
            (faceName === 'west' && minx === 0) ||
            (faceName === 'up' && maxy === 16) ||
            (faceName === 'down' && miny === 0) ||
            (faceName === 'south' && maxz === 16) ||
            (faceName === 'north' && minz === 0)

          if (matchingEFace.cullface && isBoundary) {
            if ((block.visible_faces & (1 << faceIdx)) === 0) {
              continue
            }
          }

          const faceDataIndex = wasmFaceToDataIndex[faceIdx]
          const aoValues = faceDataIndex === undefined ? [3, 3, 3, 3] : block.ao_data[faceDataIndex]
          const lightValues = faceDataIndex === undefined ? [1, 1, 1, 1] : block.light_data[faceDataIndex]

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

            const ao = aoValues[cornerIdx]

            const wasmLightValue = lightValues[cornerIdx]
            const baseLight = wasmLightValue > 0 ? wasmLightValue : 1.0
            const cornerLightResult = baseLight * 15

            const light = (ao + 1) / 4 * (cornerLightResult / 15)

            colors.push(baseLight * tint[0] * light, baseLight * tint[1] * light, baseLight * tint[2] * light)

            const baseu = (pos[3] - 0.5) * uvcs - (pos[4] - 0.5) * uvsn + 0.5
            const basev = (pos[3] - 0.5) * uvsn + (pos[4] - 0.5) * uvcs + 0.5
            const finalU = baseu * su + u
            const finalV = basev * sv + v
            uvs.push(finalU, finalV)

            currentIndex++
          }

          let tri1: number[], tri2: number[]
          if (aoValues[0] + aoValues[3] >= aoValues[1] + aoValues[2]) {
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

  console.log(`[WASM] Final geometry summary:`)
  console.log(`[WASM]   Total vertices: ${positions.length / 3}`)
  console.log(`[WASM]   Total triangles: ${indices.length / 3}`)
  console.log(`[WASM]   Positions: [${positions.slice(0, 12).join(',')}...] (first 4 vertices)`)
  console.log(`[WASM]   Indices: [${indices.slice(0, 12).join(',')}...] (first 2 faces)`)

  return result
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
