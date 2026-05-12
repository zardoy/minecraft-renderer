import ChunkLoader, { PCChunk } from 'prismarine-chunk'
import { biomes, bitMap, chunkData, groundUp } from '../../../../test-snapshots/1.16.5/chunk.json'
import { Vec3 } from 'vec3'

export const SNAPSHOT_FILE = 'test-snapshots/1.16.5/wasm-chunk.snapshot.json'
export const VERSION = '1.16.5'
export const getChunk = () => {
  const Chunk = ChunkLoader(VERSION)
  const chunkDataBuffer = Buffer.from(chunkData.data)

  const chunk = new Chunk({ minY: 0, worldHeight: 256, x: 0, z: 0 }) as PCChunk
  chunk.load(chunkDataBuffer, bitMap, true, groundUp)
  // chunk.setBlockStateId(new Vec3(0, 1, 0), 1)
  // chunk.setBlockStateId(new Vec3(0, 0, 1), 1)

  return chunk
}
