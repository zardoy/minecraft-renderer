import { describe, expect, it } from 'vitest'
import {
  detectVisualProfile,
  migrateRendererOptions,
  RENDERER_DEFAULT_OPTIONS,
  RENDERER_EFFECT_OPTION_KEYS,
  RENDERER_OPTIONS_META,
  RENDERER_VISUAL_PROFILES,
  resolveEnableLighting
} from './rendererDefaultOptions'

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

describe('visual profiles', () => {
  it('every profile sets exactly the effect options, with valid values', () => {
    for (const profile of Object.values(RENDERER_VISUAL_PROFILES)) {
      expect(Object.keys(profile.options).sort()).toEqual([...RENDERER_EFFECT_OPTION_KEYS].sort())
      for (const key of RENDERER_EFFECT_OPTION_KEYS) {
        const allowed = RENDERER_OPTIONS_META[key]?.possibleValues
        if (!allowed) continue
        const values = allowed.map(v => (Array.isArray(v) ? v[0] : v))
        expect(values, `${key}=${String(profile.options[key])}`).toContain(profile.options[key])
      }
    }
  })

  it('default is what a fresh install gets, vanilla turns everything off', () => {
    for (const key of RENDERER_EFFECT_OPTION_KEYS) expect(RENDERER_VISUAL_PROFILES.default.options[key]).toBe(RENDERER_DEFAULT_OPTIONS[key])
    const vanilla = RENDERER_VISUAL_PROFILES.vanilla.options
    expect([vanilla.wavingGrass, vanilla.bloom, vanilla.godRays, vanilla.vignette, vanilla.motionBlur]).toEqual([false, false, false, false, false])
    expect([vanilla.sunShadows, vanilla.antialiasing, vanilla.colorGrading]).toEqual(['off', 'off', 'off'])
  })

  it('maximum turns on the heavy effects except motion blur', () => {
    const max = RENDERER_VISUAL_PROFILES.maximum.options
    expect([max.bloom, max.godRays, max.vignette]).toEqual([true, true, true])
    expect([max.sunShadows, max.antialiasing]).toEqual(['soft', 'fxaa'])
    expect(max.motionBlur).toBe(false)
  })

  it('detects the active profile and reports custom settings as undefined', () => {
    expect(detectVisualProfile(RENDERER_DEFAULT_OPTIONS)).toBe('default')
    expect(detectVisualProfile(RENDERER_VISUAL_PROFILES.vanilla.options)).toBe('vanilla')
    expect(detectVisualProfile(RENDERER_VISUAL_PROFILES.maximum.options)).toBe('maximum')
    expect(detectVisualProfile({ ...RENDERER_VISUAL_PROFILES.maximum.options, bloom: false })).toBeUndefined()
  })
})
