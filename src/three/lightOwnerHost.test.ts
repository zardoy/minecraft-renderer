import { describe, expect, it } from 'vitest'
import { RendererLightCache } from './rendererLightCache'
import { applyLightPublication, LightOwnerHost, type LightPublication } from './lightOwnerHost'

function packedNibble(value: number): Uint8Array {
  const n = value & 0x0f
  return new Uint8Array(2048).fill(n | (n << 4))
}

describe('LightOwnerHost publications', () => {
  it('writes packed block-only sections without baking missing sky as 15', () => {
    const cache = new RendererLightCache('1.17.1')
    cache.setWorldBounds(0, 256)
    const pub: LightPublication = {
      worldGeneration: 1,
      publicationVersion: 1,
      sections: [{ sx: 0, sy: 64, sz: 0, blockLight: packedNibble(9) }]
    }
    const result = applyLightPublication(cache, pub, { acceptedGeneration: 1, lastVersion: 0 })
    expect(result.applied).toBe(true)
    expect(cache.getLight(0, 64, 0).block).toBeCloseTo(11 / 15, 5)
    expect(cache.getLight(0, 64, 0).sky).toBeCloseTo(2 / 15, 5)
  })

  it('discards a stale publication version', () => {
    const cache = new RendererLightCache('1.17.1')
    cache.setWorldBounds(0, 256)
    const stale: LightPublication = {
      worldGeneration: 1,
      publicationVersion: 3,
      sections: [{ sx: 0, sy: 64, sz: 0, blockLight: packedNibble(4) }]
    }
    const result = applyLightPublication(cache, stale, { acceptedGeneration: 1, lastVersion: 4 })
    expect(result.applied).toBe(false)
    expect(cache.getLight(0, 64, 0)).toEqual({ block: 0, sky: 1 })
  })

  it('steps an in-process owner and publishes increasing versions', async () => {
    const cache = new RendererLightCache('1.17.1')
    cache.setWorldBounds(0, 256)
    const host = await LightOwnerHost.createInProcess(cache, { worldMinY: 0, worldHeight: 256 })
    host.setLightTables({
      emission: Uint8Array.of(0, 0, 14),
      opacity: Uint8Array.of(0, 15, 0)
    })
    host.pushEvent({ type: 'ingestBlockSection', sx: 0, sy: 4, sz: 0, states: new Uint16Array(4096) })
    host.pushEvent({ type: 'blockChange', x: 8, y: 64, z: 8, stateId: 2 })
    const first = await host.stepUntilIdle(16)
    expect(first?.publicationVersion).toBeGreaterThan(0)
    host.pushEvent({ type: 'blockChange', x: 8, y: 64, z: 8, stateId: 0 })
    const second = await host.stepUntilIdle(16)
    expect(second?.publicationVersion).toBeGreaterThan(first!.publicationVersion)
    expect(cache.getLight(8, 64, 8).block).toBeCloseTo(2 / 15, 5)
  })

  it('publishes sky so an opaque roof darkens the column', async () => {
    const cache = new RendererLightCache('1.17.1')
    cache.setWorldBounds(0, 256)
    const host = await LightOwnerHost.createInProcess(cache, { worldMinY: 0, worldHeight: 256 })
    host.setLightTables({
      emission: Uint8Array.of(0, 0, 14),
      opacity: Uint8Array.of(0, 15, 0)
    })
    host.pushEvent({ type: 'ingestBlockSection', sx: 0, sy: 15, sz: 0, states: new Uint16Array(4096) })
    await host.stepUntilIdle(32)
    expect(cache.getLight(8, 255, 8).sky).toBeCloseTo(1, 5)
    expect(cache.getLight(8, 249, 8).sky).toBeCloseTo(1, 5)
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        host.pushEvent({ type: 'blockChange', x, y: 250, z, stateId: 1 })
      }
    }
    await host.stepUntilIdle(64)
    expect(cache.getLight(8, 251, 8).sky).toBeCloseTo(1, 5)
    expect(cache.getLight(8, 249, 8).sky).toBeCloseTo(2 / 15, 5)
  })
})
