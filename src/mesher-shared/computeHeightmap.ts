import { Vec3 } from 'vec3'
import { World } from './world'
import { INVISIBLE_BLOCKS } from './worldConstants'

/**
 * Sentinel value written to the heightmap for any column that contains no
 * non-INVISIBLE block in `[worldMinY, worldMaxY]`. Matches the value that
 * Rust's `wasm-mesher` writes for empty columns in its `Vec<i16>` heightmap,
 * so JS and Rust heightmaps are element-wise comparable.
 *
 * Downstream consumers (e.g. `src/three/modules/rain.ts`) MUST treat this
 * value as "no surface" rather than as a real Y coordinate.
 */
export const EMPTY_COLUMN_HEIGHTMAP_SENTINEL = -32768

/**
 * Compute the surface heightmap for one 16x16 chunk column.
 *
 * Returns a 256-entry Int16Array indexed as `z * 16 + x`, where each entry is
 * the world-Y of the highest non-INVISIBLE block in that column, or
 * `EMPTY_COLUMN_HEIGHTMAP_SENTINEL` (-32768) if no such block exists.
 *
 * Shared by the JS-mode mesher (`mesher.ts`) and WASM-mode mesher
 * (`mesherWasm.ts`) `getHeightmap` handlers to guarantee element-wise parity.
 */
export function computeHeightmap(world: World, chunkX: number, chunkZ: number): Int16Array {
  const heightmap = new Int16Array(256)

  const blockPos = new Vec3(0, 0, 0)
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      blockPos.x = x + chunkX
      blockPos.z = z + chunkZ
      blockPos.y = world.config.worldMaxY
      let block = world.getBlock(blockPos)
      while (block && INVISIBLE_BLOCKS.has(block.name) && blockPos.y > world.config.worldMinY) {
        blockPos.y -= 1
        block = world.getBlock(blockPos)
      }
      const index = z * 16 + x
      // Loop exits either when we found a visible (non-INVISIBLE) block, or
      // when we hit worldMinY with the column still entirely invisible/empty.
      // Only the former is a real surface; the latter is the empty-column
      // case and must use the sentinel to match Rust's encoding.
      heightmap[index] = block && !INVISIBLE_BLOCKS.has(block.name) ? blockPos.y : EMPTY_COLUMN_HEIGHTMAP_SENTINEL
    }
  }
  return heightmap
}

/**
 * Shared `getHeightmap` worker-handler logic.
 *
 * Both `mesher.ts` and `mesherWasm.ts` route their `case 'getHeightmap'` here so
 * the post-message payload (key + heightmap) is computed in exactly one place.
 * Test fixtures (see `wasm-mesher/test-section-boundary.ts`) invoke this helper
 * directly to exercise the real handler path end-to-end.
 */
export function handleGetHeightmap(world: World, x: number, z: number): { key: string; heightmap: Int16Array } {
  const heightmap = computeHeightmap(world, x, z)
  const key = `${Math.floor(x / 16)},${Math.floor(z / 16)}`
  return { key, heightmap }
}
