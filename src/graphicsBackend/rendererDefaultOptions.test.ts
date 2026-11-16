import { describe, expect, it } from 'vitest'
import {
  detectVisualProfile,
  migrateRendererOptions,
  RENDERER_DEFAULT_OPTIONS,
  RENDERER_EFFECT_OPTION_KEYS,
  RENDERER_OPTIONS_META,
  RENDERER_PERFORMANCE_NOTE,
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
  it.each([false, true])('preserves a saved lighting preference (%s)', value => {
    const saved: Record<string, unknown> = { newVersionsLighting: value }
    migrateRendererOptions(saved)
    expect(saved.newVersionsLighting).toBe(value)
  })

  it('does not migrate old world-lighting settings into entity lighting', () => {
    const saved: Record<string, unknown> = { newVersionsLighting: true }
    migrateRendererOptions(saved)
    expect(saved.newVersionsLighting).toBe(true)
    expect(saved).not.toHaveProperty('entityLighting')
  })

  it('does not invent a stored value when the key was never saved', () => {
    const saved: Record<string, unknown> = {}
    migrateRendererOptions(saved)
    expect(saved).not.toHaveProperty('newVersionsLighting')
    expect(saved).not.toHaveProperty('entityLighting')
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

  it('the default profile is what a fresh install gets', () => {
    for (const key of RENDERER_EFFECT_OPTION_KEYS) expect(RENDERER_VISUAL_PROFILES.default.options[key], key).toBe(RENDERER_DEFAULT_OPTIONS[key])
  })

  it('the vanilla profile leaves no effect on, including effects added later', () => {
    // vanillaLook is the exception by design: vanilla shading is what "vanilla" means. Numbers (shadow distance) are not effects.
    for (const key of RENDERER_EFFECT_OPTION_KEYS.filter(k => k !== 'vanillaLook')) {
      const value = RENDERER_VISUAL_PROFILES.vanilla.options[key]
      if (typeof value === 'number') continue
      expect(value === false || value === 'off', `${key}=${String(value)}`).toBe(true)
    }
  })

  it('every effect option has a short performance note', () => {
    for (const key of RENDERER_EFFECT_OPTION_KEYS) {
      const note = RENDERER_OPTIONS_META[key]?.performance
      expect(note, key).toBeTruthy()
      expect(note!.length, `${key} note is short`).toBeLessThan(120)
    }
    expect(RENDERER_PERFORMANCE_NOTE).toContain('Apple M5')
  })

  it('detects the active profile and reports custom settings as undefined', () => {
    expect(detectVisualProfile(RENDERER_DEFAULT_OPTIONS)).toBe('default')
    expect(detectVisualProfile(RENDERER_VISUAL_PROFILES.vanilla.options)).toBe('vanilla')
    expect(detectVisualProfile(RENDERER_VISUAL_PROFILES.maximum.options)).toBe('maximum')
    expect(detectVisualProfile({ ...RENDERER_VISUAL_PROFILES.maximum.options, bloom: false })).toBeUndefined()
  })
})
