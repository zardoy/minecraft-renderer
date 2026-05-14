#!/usr/bin/env node
/* eslint-disable */
// Genitirt fixtures dlya chunk-packet-fixtures.
// Zapuskat iz kornya minecraft-renderer:  node chunk-packet-fixtures/generate-fixtures.cjs
//
// Idempotent: peregenerit faily v chunk-packet-fixtures/fixtures/ pri kazhdom zapuske.

const fs = require('fs')
const path = require('path')
const ChunkLoader = require('prismarine-chunk')
const MinecraftData = require('minecraft-data')

const VERSION = '1.18.2'
const OUT_DIR = path.join(__dirname, 'fixtures')

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

// Vse stsenarii vozvraschayut zapolnenuyu kolonku.
const SCENARIOS = {
  empty () {
    return newColumn()
  },

  single_block_stone () {
    const c = newColumn()
    // zapolnyaem odnu sekciyu kamnem (single-value palette ozhidaetsya)
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
    // VarInt > 127 v palitre: blocky s bolshimi state IDs, no malo unikalnyh (chtoby ostalsya indirect).
    const c = newColumn()
    const ids = [
      mcData.blocksByName.jungle_leaves.maxStateId,    // 203
      mcData.blocksByName.acacia_leaves.maxStateId,    // 217
      mcData.blocksByName.dark_oak_leaves.maxStateId,  // 231
      mcData.blocksByName.azalea_leaves.maxStateId,    // 245
      mcData.blocksByName.flowering_azalea_leaves.maxStateId,  // 259 — 2-byte varInt
      mcData.blocksByName.glass.defaultState,          // 262
    ]
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
    // Mnogo unikalnyh state'ov — naprimer, vse vozmozhnye state ID v secii
    const c = newColumn()
    let id = 1
    const maxId = Object.values(mcData.blocks).reduce((m, b) => Math.max(m, b.maxStateId), 0)
    for (let x = 0; x < 16; x++) {
      for (let y = 0; y < 16; y++) {
        for (let z = 0; z < 16; z++) {
          // perebiraem state ids po krugu
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
    // raznye urovni
    for (let i = 0; i < 16; i++) {
      c.setBlockLight(new Vec3(i, 5, 0), i)
      c.setSkyLight(new Vec3(i, 5, 0), 15 - i)
    }
    return c
  },

  light_multi_sections () {
    // Svet v neskolkih sekciyah po raznym urovnyam.
    const c = newColumn()
    // Stavim svet na razlichnyh y (chtoby zatronut neskolko sekciy).
    const ys = [-50, 5, 50, 100, 200]
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
    // biomy hranyatsya c shagom 4 v secii — stavim v kazhduyu yacheiku
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
    // bloki na granitsah sekciy: y = -1, 0, 15, 16, 31, 32 ...
    for (const y of [-64, -49, -48, -33, -32, -17, -16, -1, 0, 15, 16, 31, 32, 47, 48]) {
      c.setBlockStateId(new Vec3(8, y, 8), stone)
    }
    return c
  },
}

function makeFixture (name, column) {
  const dump = column.dump()
  const lightDump = column.dumpLight()
  // Snimaem ground-truth: dlya kazhdoi pozicii — blockStateId, blockLight, skyLight, biome.
  // Dlya kompaktnosti pakuem v typed-array i kodiruem v base64.
  const minY = column.minY
  const totalCells = 16 * 16 * column.worldHeight
  const blockStates = new Uint16Array(totalCells)
  const blockLight = new Uint8Array(totalCells)
  const skyLight = new Uint8Array(totalCells)
  // biomes razreshenie 4x4x4 — odna yacheika na 64 bloka
  const biomeCells = 4 * 4 * (column.worldHeight / 4)
  const biomes = new Uint8Array(biomeCells)

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
  let bi = 0
  for (let y = minY; y < minY + column.worldHeight; y += 4) {
    for (let z = 0; z < 16; z += 4) {
      for (let x = 0; x < 16; x += 4) {
        biomes[bi++] = column.getBiome(new Vec3(x, y, z))
      }
    }
  }

  return {
    name,
    version: VERSION,
    meta: {
      minY,
      worldHeight: column.worldHeight,
      numSections: column.numSections,
      maxBitsPerBlock: column.maxBitsPerBlock,
      maxBitsPerBiome: column.maxBitsPerBiome,
    },
    dump_b64: dump.toString('base64'),
    light: {
      // dumpLight() vozvrashchaet { skyLight: Uint8Array[], blockLight: Uint8Array[], *Mask: long[][] }
      skyLight_b64: lightDump.skyLight.map(b => Buffer.from(b).toString('base64')),
      blockLight_b64: lightDump.blockLight.map(b => Buffer.from(b).toString('base64')),
      skyLightMask: lightDump.skyLightMask,
      blockLightMask: lightDump.blockLightMask,
      emptySkyLightMask: lightDump.emptySkyLightMask,
      emptyBlockLightMask: lightDump.emptyBlockLightMask,
    },
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
    summary.push({
      name,
      dumpBytes: Buffer.from(fix.dump_b64, 'base64').length,
    })
    console.log(`[ok] ${name}  dump=${Buffer.from(fix.dump_b64, 'base64').length}B  → ${path.relative(process.cwd(), file)}`)
  }
  fs.writeFileSync(path.join(OUT_DIR, '_summary.json'), JSON.stringify({ version: VERSION, generatedAt: new Date().toISOString(), scenarios: summary }, null, 2))
  console.log(`\nDone. ${summary.length} fixtures written to ${path.relative(process.cwd(), OUT_DIR)}/`)
}

main()
