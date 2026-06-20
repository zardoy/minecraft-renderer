// Test WASM mesher with real chunk data from test-snapshots
import { compareOrWriteSnapshot } from '../../src/mesher-legacy/test/snapshotUtils.js'
import { getChunk, SNAPSHOT_FILE, VERSION } from '../../src/mesher-legacy/test/run/chunk.js'
import { convertChunkToWasm } from '../../src/wasm-mesher/bridge/convertChunk.js'
import { wasmOutputToExportFormat } from '../../src/wasm-mesher/bridge/render-from-wasm.js'

export const WORLD_MIN_Y = 0

export async function testChunkShared(wasm: typeof import('../pkg/wasm_mesher.js'), doWarmup = false) {
  console.log('Loading chunk...\n')

  // Get chunk using the shared chunk loader
  const chunk = getChunk()

  // console.log('Converting chunk to WASM format...')
  // const convertStart = performance.now()

  // // Convert chunk to WASM format using the shared function
  const WORLD_HEIGHT = 256
  const conversionResult = convertChunkToWasm(chunk, VERSION, 0, 0, WORLD_MIN_Y, WORLD_HEIGHT)

  // const convertEnd = performance.now()
  // const convertTime = convertEnd - convertStart

  // console.log(`✅ Conversion completed in ${convertTime.toFixed(2)}ms`)
  // console.log(`   Total blocks: ${conversionResult.blockStates.length.toLocaleString()}`)
  // console.log(`   Non-air blocks: ${conversionResult.blockCount.toLocaleString()}\n`)

  const { blockStates, blockLight, skyLight, biomesArray, invisibleBlocks, transparentBlocks, noAoBlocks, cullIdenticalBlocks, occludingBlocks } =
    conversionResult

  // Run WASM mesher
  console.log('Running WASM mesher...')

  const mesherStart = performance.now()

  if (doWarmup) {
    wasm.generate_geometry(
      0,
      WORLD_MIN_Y,
      0,
      WORLD_HEIGHT,
      WORLD_MIN_Y,
      WORLD_MIN_Y + WORLD_HEIGHT,
      WORLD_MIN_Y,
      blockStates,
      blockLight,
      skyLight,
      biomesArray,
      invisibleBlocks,
      transparentBlocks,
      noAoBlocks,
      cullIdenticalBlocks,
      occludingBlocks,
      true,
      false,
      15
    )
  }

  const result = wasm.generate_geometry(
    0,
    WORLD_MIN_Y,
    0,
    WORLD_HEIGHT,
    WORLD_MIN_Y,
    WORLD_MIN_Y + WORLD_HEIGHT,
    WORLD_MIN_Y,
    blockStates,
    blockLight,
    skyLight,
    biomesArray,
    invisibleBlocks,
    transparentBlocks,
    noAoBlocks,
    cullIdenticalBlocks,
    occludingBlocks,
    true,
    false,
    15
  )

  // Check for non-zero block states
  const nonZeroBlocks = Array.from(blockStates).filter(b => b !== 0).length
  console.log(`  Non-zero block states: ${nonZeroBlocks.toLocaleString()}`)

  const mesherEnd = performance.now()
  const mesherTime = mesherEnd - mesherStart

  console.log(`✅ WASM mesher completed in ${mesherTime.toFixed(2)}ms`)
  console.log(`   Block iterations: ${result.block_iterations.toLocaleString()}`)
  if (result.debug_blocks_found !== undefined) {
    console.log(`   Debug - Blocks found (non-air): ${result.debug_blocks_found.toLocaleString()}`)
  }
  if (result.debug_blocks_with_faces !== undefined) {
    console.log(`   Debug - Blocks with visible faces (before serialization): ${result.debug_blocks_with_faces.toLocaleString()}`)
  }
  console.log(`   Blocks with visible faces: ${result.block_count.toLocaleString()}`)
  console.log(`   Total faces: ${result.blocks.reduce((acc, b) => acc + b.ao_data.length, 0).toLocaleString()}`)
  console.log(`   Result blocks array length: ${result.blocks.length}`)
  if (result.blocks.length > 0) {
    console.log(
      `   First block: state=${result.blocks[0].block_state_id}, faces=${result.blocks[0].visible_faces}, ao_data.length=${result.blocks[0].ao_data.length}`
    )
  }
  console.log()

  // Summary
  // console.log('--- Summary ---')
  // console.log(`Conversion time: ${convertTime.toFixed(2)}ms`)
  // console.log(`Meshing time: ${mesherTime.toFixed(2)}ms`)
  // console.log(`Total time: ${(convertTime + mesherTime).toFixed(2)}ms`)

  return result
}
