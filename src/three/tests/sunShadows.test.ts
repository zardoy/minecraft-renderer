import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  computeShadowFrame,
  lightBasis,
  parseSectionKey,
  sectionCastsIntoRange,
  shadowNeedsRerender,
  SHADOW_GEOMETRY_THROTTLE_MS,
  SHADOW_SUN_MIN_INTERVAL_MS,
  sunDirectionFromTime,
  sunShadowStrength
} from '../sunShadowMath'
import { resolveShadowDistance, SunShadowsModule } from '../modules/sunShadows'
import { BlockEffects } from '../blockEffects'
import { defaultWorldRendererConfig } from '../../graphicsBackend/config'
import { RENDERER_DEFAULT_OPTIONS } from '../../graphicsBackend/rendererDefaultOptions'

const frameAt = (focus: { x: number; y: number; z: number }, sunDir = sunDirectionFromTime(3000)) =>
  computeShadowFrame({ sunDir, focus, renderOrigin: { x: 0, y: 0, z: 0 }, distance: 64, mapSize: 2048 })

describe('sun direction and strength', () => {
  it('rises in the east, is overhead at noon and below the horizon at midnight', () => {
    expect(sunDirectionFromTime(6000).y).toBeCloseTo(1)
    expect(sunDirectionFromTime(0).x).toBeGreaterThan(0.9)
    expect(sunDirectionFromTime(18000).y).toBeLessThan(-0.9)
  })

  it('casts no shadows at night or right at the horizon', () => {
    expect(sunShadowStrength(-0.5)).toBe(0)
    expect(sunShadowStrength(0.02)).toBe(0)
    expect(sunShadowStrength(1)).toBe(1)
  })

  it('light basis is orthonormal over the whole day', () => {
    for (const t of [0, 3000, 6000, 9000, 11_999]) {
      const { x, y, z } = lightBasis(sunDirectionFromTime(t))
      expect(x.dot(y)).toBeCloseTo(0)
      expect(x.dot(z)).toBeCloseTo(0)
      expect(new THREE.Vector3().crossVectors(x, y).distanceTo(z)).toBeCloseTo(0)
    }
  })
})

describe('computeShadowFrame', () => {
  it('keeps the same map while the focus moves less than a snap step', () => {
    const a = frameAt({ x: 1000.1, y: 70, z: -500.2 })
    const b = frameAt({ x: 1000.6, y: 70.3, z: -500.5 })
    expect(b.key).toBe(a.key)
    expect(frameAt({ x: 1030, y: 70, z: -500 }).key).not.toBe(a.key)
  })

  it('snaps the center to whole texels in light space (no shimmering)', () => {
    const frame = frameAt({ x: 12_345.67, y: 80.5, z: -9876.54 })
    const { x, y } = lightBasis(sunDirectionFromTime(3000))
    for (const axis of [x, y]) {
      const texels = frame.centerWorld.dot(axis) / frame.texelWorld
      expect(Math.abs(texels - Math.round(texels))).toBeLessThan(1e-6)
    }
  })

  it('maps the focus near the middle of the map and inside the depth range', () => {
    const focus = { x: 100, y: 64, z: 100 }
    const frame = frameAt(focus)
    const p = new THREE.Vector3(focus.x, focus.y, focus.z).applyMatrix4(frame.shadowMatrix)
    expect(p.x).toBeGreaterThan(0.4)
    expect(p.x).toBeLessThan(0.6)
    expect(p.y).toBeGreaterThan(0.4)
    expect(p.y).toBeLessThan(0.6)
    expect(p.z).toBeGreaterThan(0)
    expect(p.z).toBeLessThan(1)
  })

  it('is expressed relative to the render origin', () => {
    const sunDir = sunDirectionFromTime(4000)
    const focus = { x: 70_000, y: 64, z: 70_000 }
    const atZero = computeShadowFrame({ sunDir, focus, renderOrigin: { x: 0, y: 0, z: 0 }, distance: 64, mapSize: 2048 })
    const shifted = computeShadowFrame({ sunDir, focus, renderOrigin: { x: 65_536, y: 0, z: 65_536 }, distance: 64, mapSize: 2048 })
    const world = new THREE.Vector3(70_010, 64, 69_990)
    const a = world.clone().applyMatrix4(atZero.shadowMatrix)
    const b = world
      .clone()
      .sub(new THREE.Vector3(65_536, 0, 65_536))
      .applyMatrix4(shifted.shadowMatrix)
    expect(b.distanceTo(a)).toBeLessThan(1e-6)
  })
})

describe('re-render decisions', () => {
  const sun = sunDirectionFromTime(3000)
  const previous = { key: 'k', sunDir: sun.clone(), geometryVersion: 'g1', renderedAt: 1000 }

  it('renders the first time and when the frame key changes', () => {
    expect(shadowNeedsRerender(undefined, 'k', sun, 'g1', 0)).toBe(true)
    expect(shadowNeedsRerender(previous, 'other', sun, 'g1', 1001)).toBe(true)
    expect(shadowNeedsRerender(previous, 'k', sun, 'g1', 1001)).toBe(false)
  })

  it('ignores tiny sun movement but follows a noticeable one', () => {
    // 1 tick is 0.015 degrees, 8 ticks 0.12
    expect(shadowNeedsRerender(previous, 'k', sunDirectionFromTime(3001), 'g1', 1000 + SHADOW_SUN_MIN_INTERVAL_MS)).toBe(false)
    expect(shadowNeedsRerender(previous, 'k', sunDirectionFromTime(3008), 'g1', 1000 + SHADOW_SUN_MIN_INTERVAL_MS)).toBe(true)
  })

  it('re-renders for the sun at most every SHADOW_SUN_MIN_INTERVAL_MS, however fast time runs', () => {
    const fast = sunDirectionFromTime(3600)
    expect(shadowNeedsRerender(previous, 'k', fast, 'g1', 1000 + SHADOW_SUN_MIN_INTERVAL_MS - 1)).toBe(false)
    expect(shadowNeedsRerender(previous, 'k', fast, 'g1', 1000 + SHADOW_SUN_MIN_INTERVAL_MS)).toBe(true)
  })

  it('stays at about 5 map renders a second at normal day speed (what smooth shadows cost)', () => {
    // 20 ticks per second of real time, a frame every 16 ms
    let state: Parameters<typeof shadowNeedsRerender>[0]
    let renders = 0
    for (let ms = 0; ms < 10_000; ms += 16) {
      const sun = sunDirectionFromTime(3000 + (ms / 1000) * 20)
      if (shadowNeedsRerender(state, 'k', sun, 'g1', ms)) {
        renders++
        state = { key: 'k', sunDir: sun.clone(), geometryVersion: 'g1', renderedAt: ms }
      }
    }
    expect(renders / 10).toBeGreaterThan(3)
    expect(renders / 10).toBeLessThan(7)
  })

  it('throttles geometry changes', () => {
    expect(shadowNeedsRerender(previous, 'k', sun, 'g2', 1000 + SHADOW_GEOMETRY_THROTTLE_MS - 1)).toBe(false)
    expect(shadowNeedsRerender(previous, 'k', sun, 'g2', 1000 + SHADOW_GEOMETRY_THROTTLE_MS)).toBe(true)
  })
})

describe('caster selection', () => {
  it('parses section keys and keeps sections around the focus', () => {
    expect(parseSectionKey('16,-64,32')).toEqual([16, -64, 32])
    expect(parseSectionKey('nope')).toBeUndefined()
    const focus = { x: 8, y: 0, z: 8 }
    expect(sectionCastsIntoRange(0, 0, focus, 64)).toBe(true)
    expect(sectionCastsIntoRange(96, 0, focus, 64)).toBe(true)
    expect(sectionCastsIntoRange(160, 160, focus, 64)).toBe(false)
  })

  it('clamps the distance option', () => {
    expect(resolveShadowDistance(500)).toBe(128)
    expect(resolveShadowDistance(1)).toBe(16)
    expect(resolveShadowDistance(Number.NaN)).toBe(64)
  })
})

describe('SunShadowsModule', () => {
  it('defaults to normal (cheap mode) and does no GPU work while disabled', () => {
    expect(RENDERER_DEFAULT_OPTIONS.sunShadows).toBe('normal')
    expect(RENDERER_DEFAULT_OPTIONS.wavingGrass).toBe(true)
    const blockEffects = new BlockEffects()
    const worldRenderer = { blockEffects, timeOfTheDay: 6000, worldRendererConfig: { ...defaultWorldRendererConfig } }
    const module = new SunShadowsModule(worldRenderer as any)
    expect(module.autoEnableCheck()).toBe(true)
    worldRenderer.worldRendererConfig.sunShadows = 'off'
    expect(module.autoEnableCheck()).toBe(false)
    // never touches the renderer (there is none in this fake) while disabled
    module.update(0)
    expect(module.renderCount).toBe(0)
    expect(blockEffects.getSunShadows()).toBe('off')
    worldRenderer.worldRendererConfig.sunShadows = 'soft'
    expect(module.autoEnableCheck()).toBe(true)
  })
})
