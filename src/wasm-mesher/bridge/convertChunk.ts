import { Vec3 } from 'vec3'
import MinecraftData from 'minecraft-data'
import PrismarineBlockLoader from 'prismarine-block'
import moreBlockDataGeneratedJson from '../../lib/moreBlockDataGenerated.json'

type BlockMeta = {
  invisibleBlocks: Uint16Array
  transparentBlocks: Uint16Array
  noAoBlocks: Uint16Array
  cullIdenticalBlocks: Uint16Array
  occludingBlocks: Uint16Array
}

const metaCache = new Map<string, BlockMeta>()

const blockToIds = (block: { minStateId: number, maxStateId: number }) => {
  const ids: number[] = []
  for (let i = block.minStateId; i <= block.maxStateId; i++) {
    ids.push(i)
  }
  return ids
}

const isCube = (shapes: any) => {
  if (!shapes || shapes.length !== 1) return false
  const s = shapes[0]
  return s[0] === 0 && s[1] === 0 && s[2] === 0 && s[3] === 1 && s[4] === 1 && s[5] === 1
}

const isLikelyFullCubeBlockName = (name: string) => {
  if (!name) return false
  if (name.includes('stairs')) return false
  if (name.includes('slab')) return false
  if (name.includes('fence')) return false
  if (name.includes('gate')) return false
  if (name.includes('pane')) return false
  if (name.includes('wall')) return false
  if (name.includes('door')) return false
  if (name.includes('trapdoor')) return false
  if (name.includes('sign')) return false
  if (name.includes('banner')) return false
  if (name.includes('rail')) return false
  if (name.includes('torch')) return false
  if (name.includes('lantern')) return false
  if (name.includes('button')) return false
  if (name.includes('lever')) return false
  if (name.includes('pressure_plate')) return false
  if (name.includes('carpet')) return false
  if (name.includes('flower')) return false
  if (name.includes('sapling')) return false
  if (name.includes('tall_grass')) return false
  if (name === 'grass' || name === 'short_grass' || name === 'tall_grass') return false
  return true
}

export const getBlockMeta = (version: string): BlockMeta => {
  const cached = metaCache.get(version)
  if (cached) return cached

  const mcData = MinecraftData(version)

  const invisibleBlocks = new Uint16Array(mcData.blocksArray.filter(x => moreBlockDataGeneratedJson.invisibleBlocks[x.name]).flatMap(blockToIds))
  const transparentBlocks = new Uint16Array(mcData.blocksArray.filter(x => x.transparent).flatMap(blockToIds))
  const noAoBlocks = new Uint16Array(mcData.blocksArray.filter(x => moreBlockDataGeneratedJson.noOcclusions[x.name]).flatMap(blockToIds))
  const cullIdenticalBlocks = new Uint16Array(mcData.blocksArray.filter(x => x.name.includes('glass') || x.name.includes('ice')).flatMap(blockToIds))
  const Block = PrismarineBlockLoader(version)
  const noOcclusionsSet = new Set(Object.keys(moreBlockDataGeneratedJson.noOcclusions))

  const occludingBlockIds: number[] = []
  for (const idStr of Object.keys((mcData as any).blocksByStateId)) {
    const id = Number(idStr)
    if (!id) continue
    const b = (Block as any).fromStateId(id, 0)
    if (!b) continue
    if (b.transparent) continue
    if (b.boundingBox !== 'block') continue
    if (noOcclusionsSet.has(b.name)) continue
    if (!isCube(b.shapes)) continue
    occludingBlockIds.push(id)
  }

  const occludingBlocks = new Uint16Array(occludingBlockIds)

  const meta = {
    invisibleBlocks,
    transparentBlocks,
    noAoBlocks,
    cullIdenticalBlocks,
    occludingBlocks
  }

  metaCache.set(version, meta)
  return meta
}

export interface ChunkConversionResult {
  blockStates: Uint16Array
  blockLight: Uint8Array
  skyLight: Uint8Array
  biomesArray: Uint8Array
  invisibleBlocks: Uint16Array
  transparentBlocks: Uint16Array
  noAoBlocks: Uint16Array
  cullIdenticalBlocks: Uint16Array
  occludingBlocks: Uint16Array
  blockCount: number
}

/**
 * Convert a prismarine chunk to WASM format
 */
export function convertChunkToWasm(
  chunk: any,
  version: string,
  chunkX: number = 0,
  chunkZ: number = 0,
  worldMinY: number = 0,
  worldMaxY: number = 256,
  sectionY?: number,
  sectionHeight?: number
): ChunkConversionResult {
  const CHUNK_SIZE = 16

  // If sectionY and sectionHeight are provided, only convert that section
  // Otherwise convert the full chunk
  const startY = sectionY !== undefined ? sectionY : worldMinY
  const endY = sectionHeight !== undefined ? startY + sectionHeight : worldMaxY
  const totalBlocks = CHUNK_SIZE * CHUNK_SIZE * (endY - startY)

  const blockStates = new Uint16Array(totalBlocks)
  const blockLight = new Uint8Array(totalBlocks)
  const skyLight = new Uint8Array(totalBlocks)
  const biomesArray = new Uint8Array(totalBlocks)

  // Traverse chunk and extract data
  let blockCount = 0

  for (let y = startY; y < endY; y++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const pos = new Vec3(x, y, z)
        const idx = x + z * CHUNK_SIZE + (y - startY) * CHUNK_SIZE * CHUNK_SIZE

        try {
          // Get block state ID
          const stateId = chunk.getBlockStateId(pos)
          blockStates[idx] = stateId || 0

          // Get light values
          const bl = chunk.getBlockLight(pos)
          const sl = chunk.getSkyLight(pos)
          blockLight[idx] = bl !== undefined ? bl : 0
          skyLight[idx] = sl !== undefined ? sl : 15

          // Get biome
          const biome = chunk.getBiome ? chunk.getBiome(pos) : 1
          biomesArray[idx] = biome || 1

          if (stateId && stateId !== 0) blockCount++
        } catch (err) {
          // If position is out of bounds, set to air
          blockStates[idx] = 0
          blockLight[idx] = 0
          skyLight[idx] = 15
          biomesArray[idx] = 1
        }
      }
    }
  }

  const {
    invisibleBlocks,
    transparentBlocks,
    noAoBlocks,
    cullIdenticalBlocks,
    occludingBlocks
  } = getBlockMeta(version)

  return {
    blockStates,
    blockLight,
    skyLight,
    biomesArray,
    invisibleBlocks,
    transparentBlocks,
    noAoBlocks,
    cullIdenticalBlocks,
    occludingBlocks,
    blockCount,
  }
}
