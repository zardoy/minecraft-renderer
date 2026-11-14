import { describe, expect, it } from 'vitest'
import MinecraftData from 'minecraft-data'
import { buildLightTables, compareMcVersions, statePropsAt, supportsRuntimeLightTables, type LightBlockData } from './lightTablesRuntime'
import { createHash } from 'node:crypto'

const blocksOf = (version: string) => MinecraftData(version).blocksArray as unknown as LightBlockData[]

/** Table value of the state with the given properties (others default), or of the default state. */
function lookup(version: string, table: Uint8Array, name: string, props: Record<string, string | number | boolean> = {}): number {
  const block = blocksOf(version).find(b => b.name === name)
  if (!block) throw new Error(`${name} does not exist in ${version}`)
  const lo = block.minStateId ?? block.defaultState!
  const hi = block.maxStateId ?? block.defaultState!
  for (let id = lo; id <= hi; id++) {
    const stateProps = statePropsAt(block, id)
    if (Object.entries(props).every(([k, v]) => String(stateProps[k]) === String(v))) return table[id]!
  }
  throw new Error(`no state of ${name} matches ${JSON.stringify(props)}`)
}

describe('compareMcVersions', () => {
  it('compares numerically, not as text', () => {
    expect(compareMcVersions('1.9', '1.17.1')).toBeLessThan(0)
    expect(compareMcVersions('1.20.1', '1.20')).toBeGreaterThan(0)
    expect(compareMcVersions('1.17.1', '1.17.1')).toBe(0)
  })
})

describe('buildLightTables for 1.17.1', () => {
  const runtime = buildLightTables('1.17.1', blocksOf('1.17.1'))

  it('is exactly the vanilla 1.17.1 tables', () => {
    // sha256 of emission + opacity + occupancy. Verified equal, for every one of the 20342 state ids, to the tables
    // generated from vanilla's Blocks.java (commit 72447031d70fca0cfc9087de2704da83bc12fa79, world version 2730) before
    // that artifact and its generator were removed. A different hash means the light data changed: check it on purpose.
    const hash = createHash('sha256').update(runtime.emission).update(runtime.opacity).update(runtime.occupancy).digest('hex')
    expect(runtime.emission.length).toBe(20342)
    expect(hash).toBe('69c69b28757ade56bad59d3b645c1b1c1a6c7f23acc12932c8f78bc40e2fda60')
  })

  it('lit blocks that vanilla defines with Properties.copy() emit like the block they copy', () => {
    expect(lookup('1.17.1', runtime.emission, 'deepslate_redstone_ore', { lit: true })).toBe(9)
    expect(lookup('1.17.1', runtime.emission, 'deepslate_redstone_ore', { lit: false })).toBe(0)
    for (const colour of [
      'white',
      'orange',
      'magenta',
      'light_blue',
      'yellow',
      'lime',
      'pink',
      'gray',
      'light_gray',
      'cyan',
      'purple',
      'blue',
      'brown',
      'green',
      'red',
      'black'
    ]) {
      expect(lookup('1.17.1', runtime.emission, `${colour}_candle_cake`, { lit: true }), `${colour}_candle_cake`).toBe(3)
      expect(lookup('1.17.1', runtime.emission, `${colour}_candle_cake`, { lit: false }), `${colour}_candle_cake unlit`).toBe(0)
    }
  })

  it('every candle count emits 3 per candle when lit', () => {
    for (let candles = 1; candles <= 4; candles++) {
      expect(lookup('1.17.1', runtime.emission, 'candle', { candles, lit: true })).toBe(3 * candles)
    }
  })

  it('soul lanterns, soul fire and soul campfires emit 10', () => {
    expect(lookup('1.17.1', runtime.emission, 'soul_lantern', { hanging: true })).toBe(10)
    expect(lookup('1.17.1', runtime.emission, 'soul_fire')).toBe(10)
    expect(lookup('1.17.1', runtime.emission, 'soul_campfire', { lit: true })).toBe(10)
    expect(lookup('1.17.1', runtime.emission, 'soul_campfire', { lit: false })).toBe(0)
  })

  it('stores raw getLightBlock opacity, slabs and stairs depend on state', () => {
    const { opacity, occupancy } = runtime
    expect(lookup('1.17.1', opacity, 'tinted_glass')).toBe(15)
    expect(lookup('1.17.1', opacity, 'barrier')).toBe(1)
    expect(lookup('1.17.1', opacity, 'snow', { layers: 8 })).toBe(15)
    expect(lookup('1.17.1', opacity, 'snow', { layers: 3 })).toBe(0)
    expect(lookup('1.17.1', opacity, 'piston', { extended: true })).toBe(0)
    // slab: bottom / top half, 0xf0 = upper four octants
    expect(lookup('1.17.1', occupancy, 'oak_slab', { type: 'bottom', waterlogged: false })).toBe(0x0f)
    expect(lookup('1.17.1', occupancy, 'oak_slab', { type: 'top', waterlogged: false })).toBe(0xf0)
    expect(lookup('1.17.1', occupancy, 'oak_slab', { type: 'double', waterlogged: false })).toBe(0)
    expect(lookup('1.17.1', occupancy, 'oak_stairs', { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: false })).toBe(0x3f)
    expect(lookup('1.17.1', occupancy, 'oak_stairs', { facing: 'north', half: 'top', shape: 'straight', waterlogged: false })).toBe(0xf3)
    expect(lookup('1.17.1', occupancy, 'snow', { layers: 8 })).toBe(0xff)
    for (const name of ['stone', 'glass', 'air', 'oak_leaves']) expect(lookup('1.17.1', occupancy, name), name).toBe(0)
  })
})

describe('supportsRuntimeLightTables', () => {
  it('starts at 1.17, where minecraft-data light fields match vanilla', () => {
    expect(supportsRuntimeLightTables('1.16.5')).toBe(false)
    expect(supportsRuntimeLightTables('1.8.8')).toBe(false)
    expect(['1.17', '1.17.1', '1.18.2', '1.20.1', '1.21.4'].every(supportsRuntimeLightTables)).toBe(true)
  })
})

describe('buildLightTables across versions', () => {
  // structural checks run for 1.16.5 as well; light values are only asserted for supported versions
  const versions = ['1.16.5', '1.17.1', '1.18.2', '1.19.4', '1.20.1', '1.21.4'].filter(v => v === '1.16.5' || supportsRuntimeLightTables(v))
  const supported = versions.filter(supportsRuntimeLightTables)

  it.each(versions)('%s: covers every state, light values stay in 0..15', version => {
    const blocks = blocksOf(version)
    const tables = buildLightTables(version, blocks)
    let maxState = 0
    for (const block of blocks) maxState = Math.max(maxState, block.maxStateId ?? block.defaultState!)
    for (const table of [tables.emission, tables.opacity, tables.occupancy]) expect(table.length).toBe(maxState + 1)
    expect(Math.max(...tables.emission)).toBeLessThanOrEqual(15)
    expect(Math.max(...tables.opacity)).toBeLessThanOrEqual(15)
  })

  it.each(supported)('%s: well known blocks', version => {
    const { emission, opacity } = buildLightTables(version, blocksOf(version))
    expect(lookup(version, emission, 'torch')).toBe(14)
    expect(lookup(version, emission, 'glowstone')).toBe(15)
    expect(lookup(version, emission, 'lava', { level: 0 })).toBe(15)
    expect(lookup(version, emission, 'stone')).toBe(0)
    expect(lookup(version, opacity, 'stone')).toBe(15)
    expect(lookup(version, opacity, 'air')).toBe(0)
    expect(lookup(version, opacity, 'glass')).toBe(0)
    expect(lookup(version, opacity, 'oak_leaves', { persistent: true })).toBe(1)
    expect(lookup(version, opacity, 'water', { level: 0 })).toBe(1)
  })

  it.each(supported)('%s: state dependent light', version => {
    const { emission, opacity } = buildLightTables(version, blocksOf(version))
    expect(lookup(version, emission, 'furnace', { lit: true })).toBe(13)
    expect(lookup(version, emission, 'furnace', { lit: false })).toBe(0)
    expect(lookup(version, emission, 'redstone_lamp', { lit: true })).toBe(15)
    expect(lookup(version, emission, 'redstone_lamp', { lit: false })).toBe(0)
    expect(lookup(version, opacity, 'oak_slab', { type: 'double', waterlogged: false })).toBe(15)
    expect(lookup(version, opacity, 'oak_slab', { type: 'bottom', waterlogged: true })).toBe(1)
    expect(lookup(version, opacity, 'oak_slab', { type: 'bottom', waterlogged: false })).toBe(0)
  })

  it.each(supported)('%s: candles, light block, glow lichen', version => {
    const { emission } = buildLightTables(version, blocksOf(version))
    expect(lookup(version, emission, 'candle', { candles: 3, lit: true })).toBe(9)
    expect(lookup(version, emission, 'red_candle', { candles: 1, lit: true })).toBe(3)
    expect(lookup(version, emission, 'candle', { candles: 4, lit: false })).toBe(0)
    expect(lookup(version, emission, 'light', { level: 11 })).toBe(11)
    expect(lookup(version, emission, 'glow_lichen', { north: true })).toBe(7)
  })
})

describe('overrides', () => {
  const stone = { name: 'stone', minStateId: 1, maxStateId: 1, filterLight: 15 } satisfies LightBlockData
  const base = { emissionRules: {}, emissionRuleSuffixes: {}, overrides: [] }

  it('applies per-block overrides inside their version range only', () => {
    const overrides = { ...base, overrides: [{ block: 'stone', minVersion: '1.14', maxVersion: '1.16.5', emission: 5, lightBlock: 2 }] }
    const inside = buildLightTables('1.15.2', [stone], overrides)
    expect([inside.emission[1], inside.opacity[1]]).toEqual([5, 2])
    expect(buildLightTables('1.17.1', [stone], overrides).emission[1]).toBe(0)
    expect(buildLightTables('1.13.2', [stone], overrides).emission[1]).toBe(0)
  })

  it('clamps and takes block data from minecraft-data when nothing overrides it', () => {
    const torch = { name: 'torch', minStateId: 2, maxStateId: 2, emitLight: 99, filterLight: 0 } satisfies LightBlockData
    expect(buildLightTables('1.20.1', [stone, torch], base).emission[2]).toBe(15)
    expect(buildLightTables('1.20.1', [stone, torch], base).opacity[1]).toBe(15)
  })
})
