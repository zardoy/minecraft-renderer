import { describe, expect, it } from 'vitest'
import { migrateRendererOptions, RENDERER_DEFAULT_OPTIONS, resolveEnableLighting } from './rendererDefaultOptions'

describe('migrateRendererOptions', () => {
  it('drops the leaked migration flag so it is not a user option', () => {
    const saved: Record<string, unknown> = {
      newVersionsLighting: false,
      migratedNewVersionsLightingDefault: true
    }
    migrateRendererOptions(saved)
    expect(saved.newVersionsLighting).toBe(false)
    expect(saved).not.toHaveProperty('migratedNewVersionsLightingDefault')
  })
})

describe('newer-version lighting defaults', () => {
  it('keeps lighting opt-in on 1.13+', () => {
    expect(RENDERER_DEFAULT_OPTIONS.newVersionsLighting).toBe(false)
    expect(resolveEnableLighting(RENDERER_DEFAULT_OPTIONS.newVersionsLighting, true)).toBe(false)
  })

  it.each([false, true])('preserves a saved lighting preference (%s)', value => {
    const saved: Record<string, unknown> = { newVersionsLighting: value }
    migrateRendererOptions(saved)
    expect(saved.newVersionsLighting).toBe(value)
  })

  it('does not invent a stored value when the key was never saved', () => {
    const saved: Record<string, unknown> = {}
    migrateRendererOptions(saved)
    expect(saved).not.toHaveProperty('newVersionsLighting')
  })
})

describe('resolveEnableLighting', () => {
  it('follows the option on 1.13+ (blockStateId)', () => {
    expect(resolveEnableLighting(true, true)).toBe(true)
    expect(resolveEnableLighting(false, true)).toBe(false)
  })

  it('always enables lighting on pre-1.13', () => {
    expect(resolveEnableLighting(false, false)).toBe(true)
    expect(resolveEnableLighting(true, false)).toBe(true)
  })

  it('treats a missing protocol probe as pre-1.13 so a menu toggle cannot throw', () => {
    expect(resolveEnableLighting(false, undefined)).toBe(true)
    expect(resolveEnableLighting(true, undefined)).toBe(true)
  })
})
