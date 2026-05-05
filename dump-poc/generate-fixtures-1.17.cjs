#!/usr/bin/env node
/* eslint-disable */
// Generates fixtures for the 1.17 chunk parser.
// Run from minecraft-renderer root:  node dump-poc/generate-fixtures-1.17.cjs
//
// 1.17 chunk packet layout (after stripping headers): we capture three pieces
// separately so the Rust parser receives pre-decoded helpers (the JS bridge
// will do the same in production):
//   - bitMap (long-array sectionMask)
//   - biomes (flat Int32Array, length = 1024)
//   - chunkData bytes (per-section: i16 solidBlockCount + u8 bitsPerBlock +
//     varint[] palette + varint count + long-array packed data)
// Light comes via update_light packet in 1.17 — we stash dumpLight() output
// the same way the worker will receive it.

const fs = require('fs')
const path = require('path')
const ChunkLoader = require('prismarine-chunk')
const MinecraftData = require('minecraft-data')

const VERSION = '1.17.1'
const OUT_DIR = path.join(__dirname, 'fixtures-1.17')

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
    // Pick blocks whose defaultState is large enough to require 2-byte varInt
    // (>= 128) to exercise palette varInt decoding.
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
    // 1.17 worldHeight = 256, sections every 16 → boundaries at 0, 15, 16, 31, ...
    for (const y of [0, 15, 16, 31, 32, 47, 48, 63, 64, 127, 128, 255]) {
      c.setBlockStateId(new Vec3(8, y, 8), stone)
    }
    return c
  },
}

function makeFixture (name, column) {
  const dump = column.dump()                 // per-section blocks bytes (no header)
  const bitMap = column.getMask()            // long-array sectionMask
  const biomesArr = column.dumpBiomes()      // plain Array<int> of 1024

  // Light is parallel to 1.18 dumpLight() shape.
  const lightDump = column.dumpLight()

  const minY = column.minY
  const totalCells = 16 * 16 * column.worldHeight
  const blockStates = new Uint16Array(totalCells)
  const blockLight = new Uint8Array(totalCells)
  const skyLight = new Uint8Array(totalCells)
  // 1.17 biomes are flat 4×4×(worldHeight/4) = 4*4*64 = 1024 cells
  const biomeCells = 4 * 4 * (column.worldHeight / 4)
  const biomes = new Int32Array(biomeCells)

  let idx = 0
  for (let y = minY; y < minY + column.worldHeight; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const p = new Vec3(x, y, z)
        blockStates[idx] = column.getBlockStateId(p)
        blockLight[idx] = column.getBlockLight(p)
        skyLight[idx] = column.getSkyLight(p)
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
      worldHeight: column.worldHeight,
      numSections: column.numSections,
      maxBitsPerBlock: column.maxBitsPerBlock,
    },
    // Inputs that the Rust parser will consume:
    chunkData_b64: dump.toString('base64'),
    bitMap_long: bitMap,                                // Array<[hi, lo]>
    biomes_int_b64: Buffer.from(biomes.buffer).toString('base64'),
    light: {
      skyLight_b64: lightDump.skyLight.map(b => Buffer.from(b).toString('base64')),
      blockLight_b64: lightDump.blockLight.map(b => Buffer.from(b).toString('base64')),
      skyLightMask: lightDump.skyLightMask,
      blockLightMask: lightDump.blockLightMask,
      emptySkyLightMask: lightDump.emptySkyLightMask,
      emptyBlockLightMask: lightDump.emptyBlockLightMask,
    },
    // Ground truth typed-arrays for byte-equal diff:
    reference: {
      blockStates_b64: Buffer.from(blockStates.buffer).toString('base64'),
      blockLight_b64: Buffer.from(blockLight.buffer).toString('base64'),
      skyLight_b64: Buffer.from(skyLight.buffer).toString('base64'),
      biomes_b64: Buffer.from(biomes.buffer).toString('base64'),
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
    console.log(`[ok] ${name}  chunkData=${dumpBytes}B  bitMap=${fix.bitMap_long.length} longs  → ${path.relative(process.cwd(), file)}`)
  }
  fs.writeFileSync(path.join(OUT_DIR, '_summary.json'), JSON.stringify({ version: VERSION, generatedAt: new Date().toISOString(), scenarios: summary }, null, 2))
  console.log(`\nDone. ${summary.length} fixtures written to ${path.relative(process.cwd(), OUT_DIR)}/`)
}

main()
