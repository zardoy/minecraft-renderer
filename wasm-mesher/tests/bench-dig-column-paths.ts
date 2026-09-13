/**
 * Bench: cost of ONE block edit in a settled 3x3 neighbourhood, split by the
 * column-mesh paths `processColumnTick` can actually take.
 *
 * Mirrors `mesherWasm.ts` exactly:
 *  - a 3x3x3 owner stencil dirties 9 columns (3 sections each),
 *  - `collectChunksForColumnUnion` returns 9 columns per target, so the
 *    `chunkCount === 1` fused single path is unreachable,
 *  - `multi_fused` needs EVERY column of the neighbourhood in a parsed cache,
 *  - `blockUpdate` deletes the edited column's parsed cache, so the edited
 *    neighbourhood falls back to two-step (WASM parse per neighbour + one JS
 *    column walk + typed-array build + generate_geometry_multi).
 */
import { getChunk, VERSION } from '../../src/mesher-legacy/test/run/chunk.js'
import { bitMap, chunkData, biomes } from '../../test-snapshots/1.16.5/chunk.json'
import { convertChunkToWasm, getBlockMeta } from '../../src/wasm-mesher/bridge/convertChunk.js'

const WORLD_MIN_Y = 0
const WORLD_HEIGHT = 256
const NUM_SECTIONS = 16
const MAX_BITS_PER_BLOCK = 15
const DEFAULT_BIOME = 1
const COLUMNS = 9 // 3x3 neighbourhood
const TARGETS = 9 // 3x3x3 owner stencil dirties 9 columns

const OFFSETS: Array<[number, number]> = []
for (const dx of [-16, 0, 16]) for (const dz of [-16, 0, 16]) OFFSETS.push([dx, dz])

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

export async function benchDigColumnPaths(wasm: typeof import('../pkg/wasm_mesher.js')) {
  const chunk = getChunk()
  const meta = getBlockMeta(VERSION)
  const chunkBytes = new Uint8Array(Buffer.from(chunkData.data))
  const biomesCells = new Int32Array(biomes ?? [])
  const bitMapLoHi1 = new Uint32Array([bitMap >>> 0, 0])

  const chunkXs = new Int32Array(COLUMNS)
  const chunkZs = new Int32Array(COLUMNS)
  const bitMapLoHiAll = new Uint32Array(COLUMNS * 2)
  const numSectionsList = new Uint32Array(COLUMNS)
  const chunkDataList: Uint8Array[] = []
  const biomesList: Int32Array[] = []
  const skyLightList: Uint8Array[] = []
  const blockLightList: Uint8Array[] = []
  for (let i = 0; i < COLUMNS; i++) {
    chunkXs[i] = OFFSETS[i][0]
    chunkZs[i] = OFFSETS[i][1]
    bitMapLoHiAll[i * 2] = bitMap >>> 0
    bitMapLoHiAll[i * 2 + 1] = 0
    numSectionsList[i] = NUM_SECTIONS
    chunkDataList.push(chunkBytes)
    biomesList.push(biomesCells)
    skyLightList.push(new Uint8Array(0))
    blockLightList.push(new Uint8Array(0))
  }

  const fusedMulti = () =>
    (wasm as any).generateGeometryFromParsedV16V17Multi(
      chunkDataList, bitMapLoHiAll, numSectionsList, MAX_BITS_PER_BLOCK, biomesList, DEFAULT_BIOME,
      skyLightList, blockLightList, chunkXs, chunkZs,
      0, WORLD_MIN_Y, 0, WORLD_HEIGHT, WORLD_MIN_Y, WORLD_MIN_Y + WORLD_HEIGHT, WORLD_MIN_Y,
      meta.invisibleBlocks, meta.transparentBlocks, meta.noAoBlocks, meta.cullIdenticalBlocks, meta.occludingBlocks,
      true, false, 15
    )

  const wasmParseOne = () =>
    (wasm as any).parseChunkSectionsV16V17(chunkBytes, bitMapLoHi1, NUM_SECTIONS, MAX_BITS_PER_BLOCK, biomesCells, DEFAULT_BIOME)

  // --- two-step: 8 neighbour WASM parses + 1 cached edited column + build + mesh
  const jsWalk = () => convertChunkToWasm(chunk, VERSION, 0, 0, WORLD_MIN_Y, WORLD_HEIGHT)
  const editedConversion = jsWalk() // conversion cache holds this after the first walk

  const twoStepMulti = () => {
    const conversions: any[] = []
    for (let i = 0; i < COLUMNS - 1; i++) {
      const parsed = wasmParseOne()
      conversions.push({
        blockStates: parsed.blockStates,
        blockLight: new Uint8Array(parsed.blockStates.length),
        skyLight: new Uint8Array(parsed.blockStates.length).fill(15),
        biomesArray: parsed.biomes
      })
    }
    conversions.push(editedConversion) // cache hit for the edited column

    const perChunkLen = conversions[0].blockStates.length
    const xs = new Int32Array(COLUMNS)
    const zs = new Int32Array(COLUMNS)
    const blockStatesAll = new Uint16Array(perChunkLen * COLUMNS)
    const blockLightAll = new Uint8Array(perChunkLen * COLUMNS)
    const skyLightAll = new Uint8Array(perChunkLen * COLUMNS)
    const biomesAll = new Uint8Array(perChunkLen * COLUMNS)
    for (let i = 0; i < COLUMNS; i++) {
      xs[i] = OFFSETS[i][0]
      zs[i] = OFFSETS[i][1]
      blockStatesAll.set(conversions[i].blockStates, perChunkLen * i)
      blockLightAll.set(conversions[i].blockLight, perChunkLen * i)
      skyLightAll.set(conversions[i].skyLight, perChunkLen * i)
      biomesAll.set(conversions[i].biomesArray, perChunkLen * i)
    }
    return (wasm as any).generate_geometry_multi(
      0, WORLD_MIN_Y, 0, WORLD_HEIGHT, WORLD_MIN_Y, WORLD_MIN_Y + WORLD_HEIGHT, WORLD_MIN_Y,
      xs, zs, blockStatesAll, blockLightAll, skyLightAll, biomesAll,
      meta.invisibleBlocks, meta.transparentBlocks, meta.noAoBlocks, meta.cullIdenticalBlocks, meta.occludingBlocks,
      true, false, 15
    )
  }

  // --- same neighbourhood, but only the Y range the 3x3x3 stencil dirtied.
  // `Mesher::generate_with_world` iterates `section_y..section_y+section_height`,
  // so the WASM entry already supports a narrow Y window.
  const buildTwoStepArrays = () => {
    const conversions: any[] = []
    for (let i = 0; i < COLUMNS - 1; i++) {
      const parsed = wasmParseOne()
      conversions.push({
        blockStates: parsed.blockStates,
        blockLight: new Uint8Array(parsed.blockStates.length),
        skyLight: new Uint8Array(parsed.blockStates.length).fill(15),
        biomesArray: parsed.biomes
      })
    }
    conversions.push(editedConversion)
    const perChunkLen = conversions[0].blockStates.length
    const xs = new Int32Array(COLUMNS)
    const zs = new Int32Array(COLUMNS)
    const blockStatesAll = new Uint16Array(perChunkLen * COLUMNS)
    const blockLightAll = new Uint8Array(perChunkLen * COLUMNS)
    const skyLightAll = new Uint8Array(perChunkLen * COLUMNS)
    const biomesAll = new Uint8Array(perChunkLen * COLUMNS)
    for (let i = 0; i < COLUMNS; i++) {
      xs[i] = OFFSETS[i][0]
      zs[i] = OFFSETS[i][1]
      blockStatesAll.set(conversions[i].blockStates, perChunkLen * i)
      blockLightAll.set(conversions[i].blockLight, perChunkLen * i)
      skyLightAll.set(conversions[i].skyLight, perChunkLen * i)
      biomesAll.set(conversions[i].biomesArray, perChunkLen * i)
    }
    return { xs, zs, blockStatesAll, blockLightAll, skyLightAll, biomesAll }
  }
  const prebuilt = buildTwoStepArrays()

  const meshYRange = (sectionY: number, height: number) =>
    (wasm as any).generate_geometry_multi(
      0, sectionY, 0, height, WORLD_MIN_Y, WORLD_MIN_Y + WORLD_HEIGHT, WORLD_MIN_Y,
      prebuilt.xs, prebuilt.zs, prebuilt.blockStatesAll, prebuilt.blockLightAll, prebuilt.skyLightAll, prebuilt.biomesAll,
      meta.invisibleBlocks, meta.transparentBlocks, meta.noAoBlocks, meta.cullIdenticalBlocks, meta.occludingBlocks,
      true, false, 15
    )

  const time = (label: string, fn: () => unknown, runs = 5) => {
    fn() // warmup
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

  console.log(`\n=== one-column primitives (${VERSION} fixture, ${WORLD_HEIGHT} height) ===`)
  const tParse = time('parseChunkSectionsV16V17 (1 column)', wasmParseOne)
  const tJsWalk = time('convertChunkToWasm JS walk (1 column)', jsWalk)

  console.log(`\n=== per target column, 9-column neighbourhood ===`)
  const tFused = time('multi_fused  generateGeometryFrom...Multi', fusedMulti)
  const tTwoStep = time('two_step_multi (8 parses+build+mesh)', twoStepMulti)

  console.log(`\n=== mesh Y-window (same 9-column neighbourhood, prebuilt arrays) ===`)
  const tFullY = time('full column   Y=0..256 (what the tick does)', () => meshYRange(WORLD_MIN_Y, WORLD_HEIGHT))
  const tY48 = time('3 sections    Y=48..96  (stencil window)', () => meshYRange(48, 48))
  const tY16 = time('1 section     Y=64..80', () => meshYRange(64, 16))

  const perChunkLen = 16 * 16 * WORLD_HEIGHT
  const bytesPerBuild = perChunkLen * COLUMNS * (2 + 1 + 1 + 1)

  console.log(`\n=== ONE DIG (3x3x3 stencil -> ${TARGETS} dirty columns) ===`)
  console.log(`  multi_fused everywhere            ${(tFused * TARGETS).toFixed(0)}ms`)
  console.log(`  two_step_multi everywhere         ${(tTwoStep * TARGETS + tJsWalk).toFixed(0)}ms`)
  console.log(`  slowdown factor                   ${((tTwoStep * TARGETS + tJsWalk) / (tFused * TARGETS)).toFixed(1)}x`)
  console.log(`  redundant WASM parses per dig     ${(COLUMNS - 1) * TARGETS} (${(tParse * (COLUMNS - 1) * TARGETS).toFixed(0)}ms)`)
  console.log(`  typed-array copies per dig        ${((bytesPerBuild * TARGETS) / 1024 / 1024).toFixed(1)}MB`)
  console.log(`  blocks visited by the mesher      ${((perChunkLen * COLUMNS * TARGETS) / 1e6).toFixed(1)}M`)
  console.log(`  full-Y mesh x ${TARGETS} columns          ${(tFullY * TARGETS).toFixed(0)}ms`)
  console.log(`  stencil-Y mesh x ${TARGETS} columns       ${(tY48 * TARGETS).toFixed(0)}ms  (${(tFullY / tY48).toFixed(1)}x cheaper)`)
  console.log(`  1-section-Y mesh x ${TARGETS} columns     ${(tY16 * TARGETS).toFixed(0)}ms  (${(tFullY / tY16).toFixed(1)}x cheaper)`)
  console.log()
}
