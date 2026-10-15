import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RendererLightCache } from '../../three/rendererLightCache'
import { applyLightPublication } from '../../three/lightOwnerHost'
import { isLightSectionPresent, mergeUpdateLight, parsedUpdateLightFromWasm, worldSectionMaskBit } from './mesherWasmLightMerge'

const NUM_SECTIONS = 16

function packedNibble(value: number): Uint8Array {
  const n = value & 0x0f
  return new Uint8Array(2048).fill(n | (n << 4))
}

describe('1.17.1 fixture owner path (scenario б)', () => {
  it('keeps an omitted neighbor after the captured empty-block packet', async () => {
    const wasmDir = dirname(fileURLToPath(import.meta.url))
    const wasmModule = await import('../runtime-build/wasm_mesher.js')
    const wasmBytes = readFileSync(join(wasmDir, '../runtime-build/wasm_mesher_bg.wasm'))
    try {
      wasmModule.initSync(wasmBytes)
    } catch {
      // already initialized
    }

    const fixture = readFileSync(join(wasmDir, '../../../chunk-packet-fixtures/fixtures/map_chunk/1.17.1/5_0.update_light.bin'))
    const parsed = parsedUpdateLightFromWasm((wasmModule as any).parseUpdateLightV17(fixture, NUM_SECTIONS), NUM_SECTIONS)
    expect(parsed.x).toBe(7)
    expect(parsed.z).toBe(0)

    const seed = mergeUpdateLight(undefined, {
      ...parsed,
      blockLightMask: new Uint32Array([1 << 7, 0]),
      emptyBlockLightMask: new Uint32Array(2),
      blockLight: (() => {
        const column = new Uint8Array(NUM_SECTIONS * 4096)
        column.fill(7, 6 * 4096, 7 * 4096)
        return column
      })()
    })
    expect(isLightSectionPresent(seed.blockPresent, worldSectionMaskBit(6))).toBe(true)

    const merged = mergeUpdateLight(seed, parsed)
    expect(isLightSectionPresent(merged.blockPresent, worldSectionMaskBit(6))).toBe(true)
    expect(merged.blockLight[6 * 4096]).toBe(7)
    expect(isLightSectionPresent(merged.blockPresent, worldSectionMaskBit(0))).toBe(true)
    expect(merged.blockLight[0]).toBe(0)

    const cache = new RendererLightCache('1.17.1')
    cache.setWorldBounds(0, 256)
    applyLightPublication(
      cache,
      {
        worldGeneration: 1,
        publicationVersion: 1,
        sections: [
          { sx: 112, sy: 96, sz: 0, blockLight: packedNibble(7) },
          { sx: 112, sy: 0, sz: 0, blockLight: packedNibble(0) }
        ]
      },
      { acceptedGeneration: 1, lastVersion: 0 }
    )
    expect(cache.getLight(112, 96, 0).block).toBeCloseTo(9 / 15, 5)
    expect(cache.getLight(112, 0, 0).block).toBeCloseTo(2 / 15, 5)
  })
})
