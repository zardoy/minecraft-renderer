import { describe, expect, it } from 'vitest'
import { Vec3 } from 'vec3'
import { World } from './world'

function mockColumn (blockLight: number, skyLight: number, withSection = true) {
  return {
    getBlockLight: () => blockLight,
    getSkyLight: () => skyLight,
  }
}

describe('World.getChannelLightNorm', () => {
  it('returns full-bright when enableLighting is false', () => {
    const world = new World('1.16.5')
    world.config.enableLighting = false
    expect(world.getChannelLightNorm(new Vec3(0, 64, 0))).toEqual({ block: 0, sky: 1 })
  })

  it('returns full-bright when column is missing', () => {
    const world = new World('1.16.5')
    world.config.enableLighting = true
    expect(world.getChannelLightNorm(new Vec3(0, 64, 0))).toEqual({ block: 0, sky: 1 })
  })

  it('returns full-bright when chunk section is missing', () => {
    const world = new World('1.16.5')
    world.config.enableLighting = true
    world.columns['0,0'] = mockColumn(0, 0, false) as any
    expect(world.getChannelLightNorm(new Vec3(8, 64, 8))).toEqual({ block: 0, sky: 1 })
  })

  it('applies +2 brightness floor per channel in 0-15 space', () => {
    const world = new World('1.16.5')
    world.config.enableLighting = true
    const column = mockColumn(0, 0)
    ;(column as any).sections = { 4: {} }
    world.columns['0,0'] = column as any
    const result = world.getChannelLightNorm(new Vec3(8, 64, 8))
    expect(result.block).toBeCloseTo(2 / 15, 5)
    expect(result.sky).toBeCloseTo(2 / 15, 5)
  })

  it('clamps brightened channels at 15', () => {
    const world = new World('1.16.5')
    world.config.enableLighting = true
    const column = mockColumn(14, 14)
    ;(column as any).sections = { 4: {} }
    world.columns['0,0'] = column as any
    const result = world.getChannelLightNorm(new Vec3(8, 64, 8))
    expect(result.block).toBe(1)
    expect(result.sky).toBe(1)
  })
})
