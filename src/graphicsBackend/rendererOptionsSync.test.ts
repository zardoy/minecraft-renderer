import { describe, expect, it, vi } from 'vitest'

vi.mock('../lib/utils/skins', () => ({ setSkinsConfig: () => {} }))

import { createWorldRendererConfig } from './config'
import { RENDERER_DEFAULT_OPTIONS } from './rendererDefaultOptions'
import { applyRendererOptions, clientLightUrlOverride } from './rendererOptionsSync'

describe('applyRendererOptions entity lighting', () => {
  it.each([false, true])('syncs entityLighting=%s to the runtime config', entityLighting => {
    const inWorldRenderingConfig = createWorldRendererConfig()
    const appViewer = {
      inWorldRenderingConfig,
      config: {},
      currentDisplay: null
    } as any

    applyRendererOptions(appViewer, { ...RENDERER_DEFAULT_OPTIONS, entityLighting })

    expect(inWorldRenderingConfig.enableEntityLighting).toBe(entityLighting)
  })
})

describe('client light URL override', () => {
  const apply = (clientLighting: boolean, search = '') => {
    const inWorldRenderingConfig = createWorldRendererConfig()
    const previous = (globalThis as any).location
    ;(globalThis as any).location = { search }
    try {
      applyRendererOptions({ inWorldRenderingConfig, config: {}, currentDisplay: null } as any, { ...RENDERER_DEFAULT_OPTIONS, clientLighting })
    } finally {
      ;(globalThis as any).location = previous
    }
    return inWorldRenderingConfig.enableClientLight
  }

  it('lets ?clientLight=0|1 in the URL win over the option', () => {
    expect(apply(true, '?clientLight=0')).toBe(false)
    expect(apply(false, '?clientLight=1')).toBe(true)
    expect(apply(false, '?sp=1')).toBe(false)
  })

  it('reads only 0 and 1 as an override', () => {
    expect(clientLightUrlOverride('?clientLight=1')).toBe(true)
    expect(clientLightUrlOverride('?clientLight=0')).toBe(false)
    expect(clientLightUrlOverride('?clientLight=yes')).toBeUndefined()
    expect(clientLightUrlOverride('')).toBeUndefined()
  })
})
