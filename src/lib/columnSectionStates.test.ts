import { describe, expect, test } from 'vitest'
import Chunks from 'prismarine-chunk'
import MinecraftData from 'minecraft-data'
import { Vec3 } from 'vec3'
import { fillSectionStates, parseColumn } from './columnSectionStates'

// what client light and the camera collision cache read from every arriving column: it must be the column's real blocks
describe('fillSectionStates reads the same blocks as getBlockStateId', () => {
  for (const [version, minY, height] of [
    ['1.20.1', -64, 384],
    ['1.16.5', 0, 256],
    ['1.12.2', 0, 256]
  ] as const) {
    test(version, () => {
      const mc = MinecraftData(version)
      const Chunk = Chunks(version) as any
      const chunk = new Chunk({ minY, worldHeight: height })
      const ids = ['stone', 'dirt', mc.blocksByName.oak_leaves ? 'oak_leaves' : 'leaves', 'water', 'glass', 'torch', 'sand'].map(
        name => mc.blocksByName[name]!.minStateId!
      )
      let seed = 7
      const random = () => (seed = (seed * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff) / 0x7f_ff_ff_ff
      for (let i = 0; i < 4000; i++) {
        chunk.setBlockStateId(new Vec3(Math.floor(random() * 16), minY + Math.floor(random() * 64), Math.floor(random() * 16)), ids[i % ids.length])
      }
      const column = parseColumn(version, chunk.toJson())
      for (let y0 = minY; y0 < minY + 64; y0 += 16) {
        const states = new Uint16Array(4096)
        fillSectionStates(column, y0, states)
        for (let i = 0; i < 4096; i++) {
          const expected = column.getBlockStateId(new Vec3(i & 15, y0 + (i >> 8), (i >> 4) & 15))
          if (states[i] !== expected) expect({ y0, i, got: states[i] }).toEqual({ y0, i, got: expected })
        }
      }
    })
  }
})
