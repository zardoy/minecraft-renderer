/**
 * Bench: the per-section `post` phase of `processColumnTick` — the part that
 * runs for EVERY requested section after the WASM call: a 4096-block
 * `world.getBlock` walk feeding VisGraph + block-entity metadata.
 *
 * One dig with the 3x3x3 owner stencil requests 27 sections, so this walk
 * runs 27 times per dig.
 */
import { Vec3 } from 'vec3'
import { getChunk, VERSION } from '../../src/mesher-legacy/test/run/chunk.js'
import { World } from '../../src/mesher-shared/world.js'
import { getBlockMeta } from '../../src/wasm-mesher/bridge/convertChunk.js'
import { VisGraph } from '../../src/mesher-shared/visGraph.js'
import { packVisibilitySet } from '../../src/mesher-shared/visibilitySet.js'
import { collectBlockEntityMetadata } from '../../src/mesher-shared/blockEntityMetadata.js'

const SECTIONS_PER_DIG = 27 // 3x3x3 owner stencil

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

export function benchPostPhase() {
  const world = new World(VERSION)
  world.config = { ...world.config, version: VERSION }
  ;(globalThis as any).world = world
  ;(globalThis as any).Vec3 = Vec3
  for (const dx of [-16, 0, 16]) {
    for (const dz of [-16, 0, 16]) {
      world.addColumn(dx, dz, (getChunk() as any).toJson())
    }
  }
  const { occludingLookup } = getBlockMeta(VERSION)

  // Verbatim copy of the per-section walk in `processColumnTick`.
  const sectionWalk = (sx: number, sy: number, sz: number) => {
    const signs: Record<string, any> = {}
    const heads: Record<string, any> = {}
    const banners: Record<string, any> = {}
    const beTarget = { signs, heads, banners }
    const beOpts = { disableBlockEntityTextures: world.config.disableBlockEntityTextures }
    const visGraph = new VisGraph()
    const cursor = new Vec3(0, 0, 0)
    for (cursor.y = sy; cursor.y < sy + 16; cursor.y++) {
      for (cursor.z = sz; cursor.z < sz + 16; cursor.z++) {
        for (cursor.x = sx; cursor.x < sx + 16; cursor.x++) {
          const b = world.getBlock(cursor)
          if (!b) continue
          if (occludingLookup[b.stateId]) visGraph.setOpaque(cursor.x - sx, cursor.y - sy, cursor.z - sz)
          collectBlockEntityMetadata(b, cursor.x, cursor.y, cursor.z, beTarget, beOpts, world)
        }
      }
    }
    return packVisibilitySet(visGraph.resolve())
  }

  const time = (label: string, fn: () => unknown, runs = 5) => {
    fn()
    const samples: number[] = []
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now()
      fn()
      samples.push(performance.now() - t0)
    }
    const med = median(samples)
    console.log(`  ${label.padEnd(46)} ${med.toFixed(2)}ms  (min ${Math.min(...samples).toFixed(2)} max ${Math.max(...samples).toFixed(2)})`)
    return med
  }

  console.log(`\n=== post phase: per-section world walk (${VERSION} fixture) ===`)
  const tSolid = time('1 section, solid terrain (y=64)', () => sectionWalk(0, 64, 0))
  const tAir = time('1 section, air (y=192)', () => sectionWalk(0, 192, 0))

  console.log(`\n=== ONE DIG (${SECTIONS_PER_DIG} requested sections) ===`)
  console.log(`  world walk, all solid             ${(tSolid * SECTIONS_PER_DIG).toFixed(0)}ms`)
  console.log(`  world walk, all air               ${(tAir * SECTIONS_PER_DIG).toFixed(0)}ms`)
  console.log(`  getBlock calls                    ${((4096 * SECTIONS_PER_DIG) / 1000).toFixed(0)}k`)
  console.log()
}
