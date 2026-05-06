#!/usr/bin/env node
/* eslint-disable */
// Generates fixtures for the 1.16 chunk parser.
// Run from minecraft-renderer root:  node dump-poc/generate-fixtures-1.16.cjs
//
// 1.16 chunk_data wire format is byte-identical to 1.17, so the existing
// `parse_chunk_sections_v16_v17` Rust parser is reused as-is. The only
// fixture-side differences vs the 1.17 generator:
//   - `column.getMask()` returns a single number (sectionMask) instead of a
//     long-array — we serialize it as `bitMap_int`.
//   - `column.worldHeight` / `column.numSections` are undefined on 1.16's
//     ChunkColumn, so we hardcode 256 / 16.
//   - biomes are still a flat Array(1024) of ints (4×4×64), same as 1.17.

const fs = require('fs')
const path = require('path')
const ChunkLoader = require('prismarine-chunk')
const MinecraftData = require('minecraft-data')

const VERSION = '1.16.5'
const OUT_DIR = path.join(__dirname, 'fixtures-1.16')

const WORLD_HEIGHT = 256
const NUM_SECTIONS = 16

const mcData = MinecraftData(VERSION)
const Chunk = ChunkLoader(VERSION)
const { Vec3 } = require('vec3')

function newColumn () {
  return new Chunk(undefined)
}

const blockId = (name) => {
  const b = mcData.blocksByName[name]
  if (!b) throw new Error(`unknown block ${name}`)
  return b.defaultState
}

const SCENARIOS = {
  empty () {
    return newColumn()
  },

  single_block_stone () {
    const c = newColumn()
    const stone = blockId('stone')
    for (let x = 0; x < 16; x++) {
      for (let y = 0; y < 16; y++) {
        for (let z = 0; z < 16; z++) {
          c.setBlockStateId(new Vec3(x, y, z), stone)
        }
      }
    }
    return c
  },

  indirect_palette_few_blocks () {
    const c = newColumn()
    const ids = ['stone', 'dirt', 'grass_block', 'sand', 'gravel', 'oak_planks', 'cobblestone'].map(blockId)
    let i = 0
    for (let x = 0; x < 16; x++) {
      for (let y = 0; y < 16; y++) {
        for (let z = 0; z < 16; z++) {
          c.setBlockStateId(new Vec3(x, y, z), ids[(i++) % ids.length])
        }
      }
    }
    return c
  },

  indirect_palette_large_state_ids () {
    const c = newColumn()
    const ids = [
      mcData.blocksByName.spruce_leaves.defaultState,
      mcData.blocksByName.birch_leaves.defaultState,
      mcData.blocksByName.jungle_leaves.defaultState,
      mcData.blocksByName.acacia_leaves.defaultState,
      mcData.blocksByName.dark_oak_leaves.defaultState,
      mcData.blocksByName.glass.defaultState,
    ].filter(id => id != null)
    let i = 0
    for (let x = 0; x < 16; x++) {
      for (let y = 0; y < 16; y++) {
        for (let z = 0; z < 16; z++) {
          c.setBlockStateId(new Vec3(x, y, z), ids[(i++) % ids.length])
        }
      }
    }
    return c
  },

  direct_palette_many_blocks () {
    // > 256 unique state IDs in one section → forces direct (global) palette.
    const c = newColumn()
    const maxId = Object.values(mcData.blocks).reduce((m, b) => Math.max(m, b.maxStateId), 0)
    let id = 1
    for (let x = 0; x < 16; x++) {
      for (let y = 0; y < 16; y++) {
        for (let z = 0; z < 16; z++) {
          c.setBlockStateId(new Vec3(x, y, z), 1 + (id++ % Math.max(1, maxId - 1)))
        }
      }
    }
    return c
  },

  with_light () {
    const c = newColumn()
    const stone = blockId('stone')
    c.setBlockStateId(new Vec3(8, 4, 8), stone)
    for (let i = 0; i < 16; i++) {
      c.setBlockLight(new Vec3(i, 5, 0), i)
      c.setSkyLight(new Vec3(i, 5, 0), 15 - i)
    }
    return c
  },

  light_multi_sections () {
    const c = newColumn()
    const ys = [5, 50, 100, 200]
    for (const y of ys) {
      for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++) {
          c.setBlockLight(new Vec3(x, y, z), (x + z) & 15)
          c.setSkyLight(new Vec3(x, y, z), (15 - ((x + z) & 15)))
        }
      }
    }
    return c
  },

  mixed_biomes () {
    const c = newColumn()
    const biomes = mcData.biomesArray.slice(0, 8).map(b => b.id)
    let i = 0
    for (let y = 0; y < 64; y += 4) {
      for (let x = 0; x < 16; x += 4) {
        for (let z = 0; z < 16; z += 4) {
          c.setBiome(new Vec3(x, y, z), biomes[(i++) % biomes.length])
        }
      }
    }
    return c
  },

  section_boundary () {
    const c = newColumn()
    const stone = blockId('stone')
    // 1.16 worldHeight = 256, sections every 16 → boundaries at 0, 15, 16, 31, ...
    for (const y of [0, 15, 16, 31, 32, 47, 48, 63, 64, 127, 128, 255]) {
      c.setBlockStateId(new Vec3(8, y, 8), stone)
    }
    return c
  },
}

function makeFixture (name, column) {
  const dump = column.dump()                 // per-section blocks bytes (no header)
  const bitMapInt = column.getMask() | 0     // single number sectionMask
  const biomesArr = column.dumpBiomes()      // plain Array<int> of 1024

  const minY = column.minY | 0               // 1.16 = 0
  const worldHeight = WORLD_HEIGHT
  const numSections = NUM_SECTIONS
  const maxBitsPerBlock = column.maxBitsPerBlock

  const totalCells = 16 * 16 * worldHeight
  const blockStates = new Uint16Array(totalCells)
  const blockLight = new Uint8Array(totalCells)
  const skyLight = new Uint8Array(totalCells)
  const biomesPerBlock = new Uint8Array(totalCells)
  const biomeCells = 4 * 4 * (worldHeight / 4)
  const biomes = new Int32Array(biomeCells)

  let idx = 0
  for (let y = minY; y < minY + worldHeight; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const p = new Vec3(x, y, z)
        blockStates[idx] = column.getBlockStateId(p)
        blockLight[idx] = column.getBlockLight(p)
        skyLight[idx] = column.getSkyLight(p)
        biomesPerBlock[idx] = column.getBiome(p) & 0xFF
        idx++
      }
    }
  }
  for (let i = 0; i < biomeCells; i++) {
    biomes[i] = biomesArr[i] | 0
  }

  return {
    name,
    version: VERSION,
    meta: {
      minY,
      worldHeight,
      numSections,
      maxBitsPerBlock,
    },
    chunkData_b64: dump.toString('base64'),
    bitMap_int: bitMapInt,
    biomes_int_b64: Buffer.from(biomes.buffer).toString('base64'),
    reference: {
      blockStates_b64: Buffer.from(blockStates.buffer).toString('base64'),
      blockLight_b64: Buffer.from(blockLight.buffer).toString('base64'),
      skyLight_b64: Buffer.from(skyLight.buffer).toString('base64'),
      biomes_b64: Buffer.from(biomes.buffer).toString('base64'),
      biomesPerBlock_b64: Buffer.from(biomesPerBlock.buffer).toString('base64'),
    },
  }
}

function main () {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const summary = []
  for (const [name, factory] of Object.entries(SCENARIOS)) {
    const col = factory()
    const fix = makeFixture(name, col)
    const file = path.join(OUT_DIR, `${name}.json`)
    fs.writeFileSync(file, JSON.stringify(fix, null, 2))
    const dumpBytes = Buffer.from(fix.chunkData_b64, 'base64').length
    summary.push({ name, dumpBytes })
    console.log(`[ok] ${name}  chunkData=${dumpBytes}B  bitMap=0x${(fix.bitMap_int >>> 0).toString(16)}  → ${path.relative(process.cwd(), file)}`)
  }
  fs.writeFileSync(path.join(OUT_DIR, '_summary.json'), JSON.stringify({ version: VERSION, generatedAt: new Date().toISOString(), scenarios: summary }, null, 2))
  console.log(`\nDone. ${summary.length} fixtures written to ${path.relative(process.cwd(), OUT_DIR)}/`)
}

main()
