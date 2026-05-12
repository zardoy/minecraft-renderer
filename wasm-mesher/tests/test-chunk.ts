import { fileURLToPath } from 'url'
import { dirname as pathDirname, join } from 'path'
import * as wasm from '../pkg/wasm_mesher.js'
import { writeFileSync } from 'fs'
import { SNAPSHOT_FILE, VERSION } from '../../src/mesher-legacy/test/run/chunk'
import { compareOrWriteSnapshot } from '../../src/mesher-legacy/test/snapshotUtils'
import { wasmOutputToExportFormat } from '../../src/wasm-mesher/bridge/render-from-wasm'
import { testChunkShared, WORLD_MIN_Y } from './test-chunk-shared'

const filename = typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url)
const dirname = typeof __dirname === 'string' ? __dirname : pathDirname(filename)

const main = async () => {
  const result = await testChunkShared(wasm, true)

  // Compare or write snapshot
  console.log('Comparing with snapshot...')
  try {
    const snapshotPath = join(dirname, '..', '..', SNAPSHOT_FILE)
    compareOrWriteSnapshot(
      result,
      snapshotPath
    )
    console.log('✅ Snapshot test passed!\n')
  } catch (error) {
    console.error('❌ Snapshot test failed:', error.message)
    throw error
  }

  // Generate export file
  console.log('Generating export file...')
  // Section position should match TypeScript mesher: sx + 8, sy + 8, sz + 8
  const sectionX = 0
  const sectionY = WORLD_MIN_Y
  const sectionZ = 0
  // Section key should match TypeScript mesher: worldColumnKey(sx, sz) = `${sx},${sz}`
  const sectionKey = `${sectionX},${sectionZ}` // "0,0" for chunk key format
  const exportData = wasmOutputToExportFormat(
    result,
    VERSION,
    sectionKey,
    { x: sectionX + 8, y: sectionY + 8, z: sectionZ + 8 }, // section position (matching TS mesher)
    { x: 0, y: 0, z: 0 }, // camera position (matching TS test)
    { pitch: 0, yaw: 0 } // camera rotation
  )

  // const exportPath = join(dirname, '..', 'test-snapshots', '1.16.5', 'wasm-chunk.export.json')
  // Debug exports are opt-in (non-deterministic timestamps + large files would otherwise
  // dirty the working tree on every `pnpm test:wasm`). Set EXPORT_WASM_GEOMETRY=1 to enable.
  if (process.env.EXPORT_WASM_GEOMETRY) {
    // dirname = wasm-mesher/tests; repo root public/ is two levels up
    const exportPath = join(dirname, '..', '..', 'public', 'world-geometry.json')
    const exportPath2 = join(dirname, '..', '..', 'public', 'world-geometry-wasm.json')
    writeFileSync(exportPath, JSON.stringify(exportData, null, 2), 'utf-8')
    writeFileSync(exportPath2, JSON.stringify(exportData, null, 2), 'utf-8')
    console.log(`✅ Export file created: ${exportPath}`)
    console.log(`   Sections: ${exportData.sections.length}`)
    console.log(`   Total vertices: ${exportData.sections[0].geometry.positions.length / 3}`)
    console.log(`   Total triangles: ${exportData.sections[0].geometry.indices.length / 3}\n`)
  } else {
    console.log('ℹ️  Skipping debug export (set EXPORT_WASM_GEOMETRY=1 to write public/world-geometry*.json)')
    console.log(`   Sections: ${exportData.sections.length}`)
    console.log(`   Total vertices: ${exportData.sections[0].geometry.positions.length / 3}`)
    console.log(`   Total triangles: ${exportData.sections[0].geometry.indices.length / 3}\n`)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
