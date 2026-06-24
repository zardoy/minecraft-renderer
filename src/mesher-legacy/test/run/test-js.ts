import ChunkLoader from 'prismarine-chunk'
import { setup } from '../mesherTester'
import { compareOrWriteSnapshot } from '../snapshotUtils'
import { getChunk, VERSION } from './chunk'
import { mesherGeometryToExportFormat } from '../../../wasm-mesher/bridge/render-from-wasm'
import fs from 'fs'
import { join } from 'path'

const chunk = getChunk()
const { getGeometry } = setup(VERSION, [], { chunkOverride: chunk, noDebugTiles: true })

getGeometry()
console.time('getGeometry')
globalThis.a = 0
const { attr } = getGeometry()
console.log('attr.positions', attr.positions)
debugger
console.timeEnd('getGeometry')
console.log(globalThis.a)

fs.writeFileSync(join(__dirname, '../../../../public/world-geometry.json'), JSON.stringify(mesherGeometryToExportFormat(attr, VERSION), null, 2))
fs.writeFileSync(join(__dirname, '../../../../public/world-geometry-js.json'), JSON.stringify(mesherGeometryToExportFormat(attr, VERSION), null, 2))

// Compare or write snapshot
compareOrWriteSnapshot(attr, 'b.snapshot.json')
