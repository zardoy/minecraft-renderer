import { describe, expect, it } from 'vitest'
import { RendererLightCache } from './cache/rendererLightCache'
import { formatLightingLine, lightingModeLabel, resolveLightingMode } from './lightingDebugInfo'

describe('lighting mode', () => {
  it('disabled wins, then the client engine, otherwise server light', () => {
    expect(resolveLightingMode(false, true)).toBe('disabled')
    expect(resolveLightingMode(true, true)).toBe('client')
    expect(resolveLightingMode(true, false)).toBe('server')
  })

  it('labels match the F3 wording of the original client light engine PR', () => {
    expect(lightingModeLabel({ mode: 'disabled', clientEngineUnavailableReason: null })).toBe('Lighting Disabled')
    expect(lightingModeLabel({ mode: 'client', clientEngineUnavailableReason: null })).toBe('Client Engine')
    expect(lightingModeLabel({ mode: 'server', clientEngineUnavailableReason: null })).toBe('Server Lighting')
  })

  it('says why the client engine is not running when it was requested', () => {
    expect(lightingModeLabel({ mode: 'server', clientEngineUnavailableReason: 'unsupported version 1.20.1' })).toBe(
      'Server Lighting, client engine off: unsupported version 1.20.1'
    )
  })
})

describe('formatLightingLine', () => {
  it('prints block light, sky light and the mode', () => {
    expect(formatLightingLine({ mode: 'client', block: 14, sky: 12, clientEngineUnavailableReason: null })).toBe('Light: 14 (12 sky) (Client Engine)')
  })

  it('shows ? while the section has no light data', () => {
    expect(formatLightingLine({ mode: 'server', block: undefined, sky: undefined, clientEngineUnavailableReason: null })).toBe(
      'Light: ? (? sky) (Server Lighting)'
    )
  })
})

describe('RendererLightCache.getRawLight', () => {
  it('returns raw 0..15 values (not the display normalised ones) and undefined where nothing is loaded', () => {
    const cache = new RendererLightCache('1.17.1')
    cache.setWorldBounds(0, 256)
    expect(cache.getRawLight(5, 70, 5)).toBeUndefined()
    // 4 bits per block, index (ly << 8 | lz << 4 | lx): local (1, 2, 3) = 561 is the high nibble of byte 280
    const blockLight = new Uint8Array(2048)
    const skyLight = new Uint8Array(2048)
    blockLight[280] = 14 << 4
    skyLight[280] = 3 << 4
    cache.ingestPackedSections([{ sx: 0, sy: 64, sz: 0, blockLight, skyLight }])
    expect(cache.getRawLight(1, 66, 3)).toEqual({ block: 14, sky: 3 })
    expect(cache.getRawLight(0, 66, 3)).toEqual({ block: 0, sky: 0 })
    // `getLight` is lifted for display ((raw + 2) / 15), which is not what F3 should print
    expect(cache.getLight(1, 66, 3).sky).toBeCloseTo(5 / 15)
    expect(cache.getRawLight(1, 300, 3)).toBeUndefined()
  })
})
