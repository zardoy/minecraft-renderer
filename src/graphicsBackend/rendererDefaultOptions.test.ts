import { describe, expect, it } from 'vitest'
import {
  migrateRendererOptions,
  resolveEnableLighting,
  upgradeStoredNewVersionsLightingDefault
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

describe('upgradeStoredNewVersionsLightingDefault', () => {
  it('drops a stored false from the old default on first upgrade', () => {
    const saved: Record<string, unknown> = { newVersionsLighting: false }
    expect(upgradeStoredNewVersionsLightingDefault(saved, false)).toBe(true)
    expect(saved).not.toHaveProperty('newVersionsLighting')
  })

  it('keeps an explicit false after the upgrade has already run', () => {
    const saved: Record<string, unknown> = { newVersionsLighting: false }
    expect(upgradeStoredNewVersionsLightingDefault(saved, true)).toBe(true)
    expect(saved.newVersionsLighting).toBe(false)
  })

  it('does not invent a stored value when the key was never saved', () => {
    const saved: Record<string, unknown> = {}
    expect(upgradeStoredNewVersionsLightingDefault(saved, false)).toBe(true)
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
