import { describe, expect, it, vi } from 'vitest'

vi.mock('../lib/utils/skins', () => ({ setSkinsConfig: () => {} }))

import { createWorldRendererConfig } from './config'
import { RENDERER_DEFAULT_OPTIONS } from './rendererDefaultOptions'
import { applyRendererOptions } from './rendererOptionsSync'

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
