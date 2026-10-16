import { Vec3 } from 'vec3'
import MinecraftData from 'minecraft-data'
import moreBlockDataGeneratedJson from '../../lib/moreBlockDataGenerated.json'
import { getOccludingBlockMeta } from '../../mesher-shared/occludingBlocks'

type BlockMeta = {
  invisibleBlocks: Uint16Array
  transparentBlocks: Uint16Array
  noAoBlocks: Uint16Array
  cullIdenticalBlocks: Uint16Array
  occludingBlocks: Uint16Array
  occludingLookup: Uint8Array
}

const metaCache = new Map<string, BlockMeta>()

const blockToIds = (block: { minStateId: number; maxStateId: number }) => {
  const ids: number[] = []
  for (let i = block.minStateId; i <= block.maxStateId; i++) {
    ids.push(i)
  }
  return ids
}

export const getBlockMeta = (version: string): BlockMeta => {
  const cached = metaCache.get(version)
  if (cached) return cached

  const mcData = MinecraftData(version)

  const invisibleBlocks = new Uint16Array(mcData.blocksArray.filter(x => moreBlockDataGeneratedJson.invisibleBlocks[x.name]).flatMap(blockToIds))
  const transparentBlocks = new Uint16Array(mcData.blocksArray.filter(x => x.transparent).flatMap(blockToIds))
  const noAoBlocks = new Uint16Array(mcData.blocksArray.filter(x => moreBlockDataGeneratedJson.noOcclusions[x.name]).flatMap(blockToIds))
  const cullIdenticalBlocks = new Uint16Array(mcData.blocksArray.filter(x => x.name.includes('glass') || x.name.includes('ice')).flatMap(blockToIds))
  const { occludingBlocks, occludingLookup } = getOccludingBlockMeta(version)

  const meta = {
    invisibleBlocks,
    transparentBlocks,
    noAoBlocks,
    cullIdenticalBlocks,
    occludingBlocks,
    occludingLookup
  }

  metaCache.set(version, meta)
  return meta
}

const ceilLog2 = (count: number) => (count <= 1 ? 0 : 32 - Math.clz32(count - 1))

const globalPaletteBitsCache = new Map<string, { blocks: number; biomes: number }>()

/**
 * Bits of the global block state and biome palettes, vanilla's
 * `Strategy.globalPaletteBitsInMemory`: ceillog2 of the registry size.
 * map_chunk stores direct (unpaletted) containers with them. The biome count
 * is minecraft-data's vanilla registry; a server's own biomes can change it.
 */
export const getGlobalPaletteBits = (version: string) => {
  const cached = globalPaletteBitsCache.get(version)
  if (cached) return cached
  const mcData = MinecraftData(version)
  const blockStates = mcData.blocksArray.reduce((max, block) => Math.max(max, block.maxStateId ?? 0), 0) + 1
  const bits = { blocks: ceilLog2(blockStates), biomes: ceilLog2(mcData.biomesArray.length) }
  globalPaletteBitsCache.set(version, bits)
  return bits
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

  const { invisibleBlocks, transparentBlocks, noAoBlocks, cullIdenticalBlocks, occludingBlocks } = getBlockMeta(version)

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
    blockCount
  }
}
