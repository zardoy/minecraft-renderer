import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import MinecraftData from 'minecraft-data'
import { buildVanillaLightTables1171 } from '../../scripts/generate-light-tables-1171.mjs'
import { buildLightTables1171 } from './lightTables1171'

const mcData = MinecraftData('1.17.1')

function propsAt(block: { minStateId: number; states?: Array<{ name: string; type: string; num_values: number; values?: string[] }> }, stateId: number) {
  let data = stateId - block.minStateId
  const out: Record<string, string | number | boolean> = {}
  const states = block.states ?? []
  for (let i = states.length - 1; i >= 0; i--) {
    const prop = states[i]!
    const idx = data % prop.num_values
    data = Math.floor(data / prop.num_values)
    if (prop.type === 'bool') out[prop.name] = idx === 0
    else if (prop.values) out[prop.name] = prop.values[idx]!
    else out[prop.name] = idx
  }
  return out
}

function idsNamed(name: string) {
  const block = mcData.blocksByName[name]
  expect(block, name).toBeTruthy()
  return block
}

describe('buildLightTables1171', () => {
  it('covers every 1.17.1 stateId from the vanilla Blocks.java dump, not 1.21.7', () => {
    const tables = buildLightTables1171()
    expect(tables.version).toBe('1.17.1')
    expect(tables.source).toBe('vanilla-1.17.1-blocks-java')
    expect(tables.vanillaRegistryComplete).toBe(true)
    expect(tables.vanillaWorldVersion).toBe(2730)

    let maxState = 0
    for (const block of mcData.blocksArray) {
      const hi = block.maxStateId ?? block.defaultState
      if (hi > maxState) maxState = hi
    }
    expect(tables.emission.length).toBe(maxState + 1)
    expect(tables.opacity.length).toBe(maxState + 1)

    for (const block of mcData.blocksArray) {
      const lo = block.minStateId ?? block.defaultState
      const hi = block.maxStateId ?? block.defaultState
      for (let id = lo; id <= hi; id++) {
        expect(tables.emission[id], `${block.name}#${id} emission`).toBeGreaterThanOrEqual(0)
        expect(tables.emission[id], `${block.name}#${id} emission`).toBeLessThanOrEqual(15)
        expect(tables.opacity[id], `${block.name}#${id} opacity`).toBeGreaterThanOrEqual(1)
        expect(tables.opacity[id], `${block.name}#${id} opacity`).toBeLessThanOrEqual(15)
      }
    }
  })

  it('gives vanilla emission for torch, lit furnace, lit lamp, soul lantern, candles', () => {
    const tables = buildLightTables1171()
    expect(tables.emission[idsNamed('torch').defaultState]).toBe(14)

    const furnace = idsNamed('furnace')
    let sawLitFurnace = false
    for (let id = furnace.minStateId; id <= furnace.maxStateId; id++) {
      const lit = propsAt(furnace, id).lit === true
      if (lit) {
        expect(tables.emission[id], `furnace#${id} lit`).toBe(13)
        sawLitFurnace = true
      } else {
        expect(tables.emission[id], `furnace#${id} unlit`).toBe(0)
      }
    }
    expect(sawLitFurnace).toBe(true)

    const lamp = idsNamed('redstone_lamp')
    let sawLitLamp = false
    for (let id = lamp.minStateId; id <= lamp.maxStateId; id++) {
      const lit = propsAt(lamp, id).lit === true
      if (lit) {
        expect(tables.emission[id], `redstone_lamp#${id} on`).toBe(15)
        sawLitLamp = true
      } else {
        expect(tables.emission[id], `redstone_lamp#${id} off`).toBe(0)
      }
    }
    expect(sawLitLamp).toBe(true)

    const soul = idsNamed('soul_lantern')
    for (let id = soul.minStateId; id <= soul.maxStateId; id++) {
      expect(tables.emission[id], `soul_lantern#${id}`).toBe(10)
    }

    const candle = idsNamed('candle')
    let sawLitCandle = false
    for (let id = candle.minStateId; id <= candle.maxStateId; id++) {
      const props = propsAt(candle, id)
      const lit = props.lit === true
      const count = Number(props.candles)
      if (lit) {
        expect(tables.emission[id], `candle#${id} ${count}`).toBe(3 * count)
        sawLitCandle = true
      } else {
        expect(tables.emission[id], `candle#${id} unlit`).toBe(0)
      }
    }
    expect(sawLitCandle).toBe(true)
  })

  it('regenerates the committed artifact from vendored 1.17.1 Blocks.java', () => {
    const java = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../lib/vanilla-1.17.1/Blocks.java'), 'utf8')
    const fresh = buildVanillaLightTables1171(java)
    const tables = buildLightTables1171()
    expect(fresh.vanillaCommit).toBe('72447031d70fca0cfc9087de2704da83bc12fa79')
    expect(fresh.vanillaWorldVersion).toBe(2730)
    expect(fresh.emission).toEqual(tables.emission)
    expect(fresh.opacity).toEqual(tables.opacity)
  })
})
