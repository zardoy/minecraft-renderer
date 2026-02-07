import { Vec3 } from 'vec3'
import { convertChunkToWasm } from '../wasm-lib/convertChunk'
import { renderWasmOutputToGeometry } from '../wasm-lib/render-from-wasm'
import { setBlockStatesData as setMesherData } from './models'
import { defaultMesherConfig, type MesherGeometryOutput, IS_FULL_WORLD_SECTION, SECTION_HEIGHT } from './shared'
import { worldColumnKey, World } from './world'

let wasm: typeof import('../../wasm-mesher/pkg/wasm_mesher.js') | null = null
let wasmInitialized = false

async function initWasm() {
  if (wasmInitialized) return
  try {
    wasmInitialized = true
    wasm = await import('../../wasm-mesher/pkg/wasm_mesher.js')
    await wasm.default('/wasm_mesher_bg.wasm') as any

    // const result = await testChunkShared(wasm)
    // console.log('result', result)
  } catch (err) {
    console.error('Failed to initialize WASM mesher:', err)
    wasmInitialized = true // Don't try to initialize again
    // Don't throw - allow worker to continue without WASM (will fail on first use)
  }
}

globalThis.structuredClone ??= (value) => JSON.parse(JSON.stringify(value))

if (globalThis.module && module.require) {
  // If we are in a node environment, we need to fake some env variables
  const r = module.require
  const { parentPort } = r('worker_threads')
  global.self = parentPort
  global.postMessage = (value, transferList) => { parentPort.postMessage(value, transferList) }
  global.performance = r('perf_hooks').performance
}

let workerIndex = 0
let config = defaultMesherConfig
let version = '1.16.5'
let world: World // chunkKey -> chunk data
let dirtySections = new Map<string, number>()
let allDataReady = false

function sectionKey(x: number, y: number, z: number) {
  return `${x},${y},${z}`
}

const batchMessagesLimit = 100

let queuedMessages: any[] = []
let queueWaiting = false
const postMessage = (data: any, transferList: any[] = []) => {
  queuedMessages.push({ data, transferList })
  if (queuedMessages.length > batchMessagesLimit) {
    drainQueue(0, batchMessagesLimit)
  }
  if (queueWaiting) return
  queueWaiting = true
  setTimeout(() => {
    queueWaiting = false
    drainQueue(0, queuedMessages.length)
  })
}

function drainQueue(from: number, to: number) {
  const messages = queuedMessages.slice(from, to)
  global.postMessage(messages.map(m => m.data), messages.flatMap(m => m.transferList) as unknown as string)
  queuedMessages = queuedMessages.slice(to)
}

let hadDirty = false
function setSectionDirty(pos: Vec3, value = true) {
  if (hadDirty) return

  // hadDirty = true
  const x = Math.floor(pos.x / 16) * 16
  const sectionHeight = getSectionHeight()
  const y = Math.floor(pos.y / sectionHeight) * sectionHeight
  const z = Math.floor(pos.z / 16) * 16
  const key = sectionKey(x, y, z)
  if (!value) {
    dirtySections.delete(key)
    postMessage({ type: 'sectionFinished', key, workerIndex })
    return
  }

  // Check if we have the chunk for this section
  const chunk = world?.getColumn(x, z)
  if (chunk?.getSection(pos)) {
    dirtySections.set(key, (dirtySections.get(key) || 0) + 1)
  } else {
    postMessage({ type: 'sectionFinished', key, workerIndex })
  }
}

const softCleanup = () => {
  world = new World(world.config.version)
  globalThis.world = world
}

const handleMessage = async (data: any) => {
  const globalVar: any = globalThis

  if (data.type === 'mcData') {
    globalVar.mcData = data.mcData
    globalVar.loadedData = data.mcData
  }

  if (data.config) {
    config = { ...config, ...data.config }
    version = config.version || version
    world ??= new World(version)
    world.config = { ...world.config, ...data.config }
    globalThis.world = world
    globalThis.Vec3 = Vec3
  }

  switch (data.type) {
    case 'mesherData': {
      setMesherData(data.blockstatesModels, data.blocksAtlas, data.config.outputFormat === 'webgpu')
      ;(globalThis as any).__wasmBlockModelCache = new Map()

      await initWasm()
      allDataReady = true
      workerIndex = data.workerIndex
      break
    }
    case 'dirty': {
      const loc = new Vec3(data.x, data.y, data.z)
      setSectionDirty(loc, data.value)
      break
    }
    case 'chunk': {
      world.addColumn(data.x, data.z, data.chunk)
      if (data.customBlockModels) {
        const chunkKey = `${data.x},${data.z}`
        world.customBlockModels.set(chunkKey, data.customBlockModels)
      }
      break
    }
    case 'unloadChunk': {
      world.removeColumn(data.x, data.z)
      world.customBlockModels.delete(`${data.x},${data.z}`)
      if (Object.keys(world.columns).length === 0) softCleanup()
      break
    }
    case 'blockUpdate': {
      const loc = new Vec3(data.pos.x, data.pos.y, data.pos.z).floored()
      if (data.stateId !== undefined && data.stateId !== null) {
        world?.setBlockStateId(loc, data.stateId)
      }

      const chunkKey = `${Math.floor(loc.x / 16) * 16},${Math.floor(loc.z / 16) * 16}`
      if (data.customBlockModels) {
        world?.customBlockModels.set(chunkKey, data.customBlockModels)
      }
      break
    }
    case 'reset': {
      world = undefined as any
      dirtySections.clear()
      globalVar.mcData = null
      globalVar.loadedData = null
      allDataReady = false
      break
    }
    // Note: getCustomBlockModel and getHeightmap not implemented in WASM version
    // as they require World class functionality
  }
}

// eslint-disable-next-line no-restricted-globals -- TODO
self.onmessage = ({ data }) => {
  if (Array.isArray(data)) {
    // eslint-disable-next-line unicorn/no-array-for-each
    data.forEach(handleMessage)
    return
  }

  handleMessage(data)
}

// Calculate section height based on IS_FULL_WORLD_SECTION
const getSectionHeight = () => {
  if (IS_FULL_WORLD_SECTION && config) {
    return (config.worldMaxY || 256) - (config.worldMinY || 0)
  }
  return SECTION_HEIGHT
}


function collectChunksForSection(x: number, y: number, z: number) {
  const result = [] as Array<{ x: number, z: number, chunk: any }>
  result.push({ x, z, chunk: world.getColumn(x, z) })
  const offsets = [-16, 0, 16]
  for (const dx of offsets) {
    for (const dz of offsets) {
      if (dx === 0 && dz === 0) continue
      const nx = x + dx
      const nz = z + dz
      const c = world.getColumn(nx, nz)
      if (c) result.push({ x: nx, z: nz, chunk: c })
    }
  }
  return result.filter(r => r.chunk)
}

setInterval(async () => {
  if (!allDataReady) return

  // Ensure WASM is initialized
  if (!wasmInitialized) {
    await initWasm()
    if (!wasmInitialized) return // Still not initialized, skip this cycle
  }

  if (dirtySections.size === 0) return

  const sectionHeight = getSectionHeight()

  for (const key of dirtySections.keys()) {
    // for (const key of [] as string[]) {
    const [x, y, z] = key.split(',').map(v => parseInt(v, 10))
    const chunk = world.getColumn(x, z)

    let processTime = 0
    if (chunk?.getSection(new Vec3(x, y, z)) && wasm) {
      const start = performance.now()

      try {
        // Convert chunk to WASM format (always recompute since section is dirty)
        // If IS_FULL_WORLD_SECTION is false, only convert the specific section
        const worldMinY = config?.worldMinY || 0
        const worldMaxY = config?.worldMaxY || 256
        const sectionY = IS_FULL_WORLD_SECTION ? undefined : y
        const convertSectionHeight = IS_FULL_WORLD_SECTION ? undefined : sectionHeight

        // Run WASM mesher for this section
        const chunksToUse = collectChunksForSection(x, y, z)
        const chunkCount = chunksToUse.length

        const conversions = chunksToUse.map(({ x: cx, z: cz, chunk }) => convertChunkToWasm(
          chunk,
          version,
          cx,
          cz,
          worldMinY,
          worldMaxY,
          sectionY,
          convertSectionHeight
        ))

        const {
          invisibleBlocks,
          transparentBlocks,
          noAoBlocks,
          cullIdenticalBlocks,
          occludingBlocks,
        } = conversions[0]

        let wasmResult
        if (chunkCount === 1 || !(wasm as any).generate_geometry_multi) {
          const { blockStates, blockLight, skyLight, biomesArray } = conversions[0]
          wasmResult = wasm.generate_geometry(
            x, y, z, sectionHeight,
            worldMinY, worldMaxY,
            blockStates, blockLight, skyLight, biomesArray,
            invisibleBlocks, transparentBlocks, noAoBlocks, cullIdenticalBlocks, occludingBlocks,
            config?.enableLighting !== false,
            config?.smoothLighting !== false,
            config?.skyLight || 15
          )
        } else {
          const perChunkLen = conversions[0].blockStates.length
          const xs = new Int32Array(chunkCount)
          const zs = new Int32Array(chunkCount)
          const blockStatesAll = new Uint16Array(perChunkLen * chunkCount)
          const blockLightAll = new Uint8Array(perChunkLen * chunkCount)
          const skyLightAll = new Uint8Array(perChunkLen * chunkCount)
          const biomesAll = new Uint8Array(perChunkLen * chunkCount)

          for (let i = 0; i < chunkCount; i++) {
            const c = conversions[i]
            xs[i] = chunksToUse[i].x
            zs[i] = chunksToUse[i].z
            blockStatesAll.set(c.blockStates, perChunkLen * i)
            blockLightAll.set(c.blockLight, perChunkLen * i)
            skyLightAll.set(c.skyLight, perChunkLen * i)
            biomesAll.set(c.biomesArray, perChunkLen * i)
          }

          wasmResult = (wasm as any).generate_geometry_multi(
            x, y, z, sectionHeight,
            worldMinY, worldMaxY,
            xs, zs,
            blockStatesAll, blockLightAll, skyLightAll, biomesAll,
            invisibleBlocks, transparentBlocks, noAoBlocks, cullIdenticalBlocks, occludingBlocks,
            config?.enableLighting !== false,
            config?.smoothLighting !== false,
            config?.skyLight || 15
          )
        }


        // Convert WASM output to MesherGeometryOutput format
        const sectionKeyStr = worldColumnKey(x, z)
        const exportedSection = renderWasmOutputToGeometry(
          wasmResult,
          version,
          sectionKeyStr,
          { x: x + 8, y: y + 8, z: z + 8 },
          world
        )

        // Convert to MesherGeometryOutput format
        // Determine if we need Uint32Array based on max index
        const maxIndex = Math.max(...exportedSection.geometry.indices)
        const using32Array = maxIndex > 65535

        // console.log('exportedSection.geometry', exportedSection.geometry)
        const geometry: MesherGeometryOutput = {
          sectionYNumber: (y - (config?.worldMinY || 0)) >> 4,
          chunkKey: sectionKeyStr,
          sectionStartY: y,
          sectionEndY: y + sectionHeight,
          sectionStartX: x,
          sectionEndX: x + 16,
          sectionStartZ: z,
          sectionEndZ: z + 16,
          sx: x + 8,
          sy: y + 8,
          sz: z + 8,
          positions: new Float32Array(exportedSection.geometry.positions),
          normals: new Float32Array(exportedSection.geometry.normals),
          colors: new Float32Array(exportedSection.geometry.colors),
          uvs: new Float32Array(exportedSection.geometry.uvs),
          indices: using32Array
            ? new Uint32Array(exportedSection.geometry.indices)
            : new Uint16Array(exportedSection.geometry.indices),
          indicesCount: exportedSection.geometry.indices.length,
          using32Array,
          tiles: {},
          heads: {},
          signs: {},
          banners: {},
          hadErrors: false,
          blocksCount: wasmResult.block_count,
        }

        const transferable = [
          geometry.positions?.buffer,
          geometry.normals?.buffer,
          geometry.colors?.buffer,
          geometry.uvs?.buffer,
          //@ts-ignore
          geometry.indices?.buffer,
        ].filter(Boolean)

        postMessage({ type: 'geometry', key, geometry, workerIndex }, transferable)
        processTime = performance.now() - start
      } catch (err) {
        console.error(`[WASM Mesher] Error processing section ${key}:`, err)
        // Send error geometry
        const errorGeometry: MesherGeometryOutput = {
          sectionYNumber: (y - (config?.worldMinY || 0)) >> 4,
          chunkKey: worldColumnKey(x, z),
          sectionStartY: y,
          sectionEndY: y + sectionHeight,
          sectionStartX: x,
          sectionEndX: x + 16,
          sectionStartZ: z,
          sectionEndZ: z + 16,
          sx: x + 8,
          sy: y + 8,
          sz: z + 8,
          positions: new Float32Array(0),
          normals: new Float32Array(0),
          colors: new Float32Array(0),
          uvs: new Float32Array(0),
          indices: new Uint32Array(0),
          indicesCount: 0,
          using32Array: false,
          tiles: {},
          heads: {},
          signs: {},
          banners: {},
          hadErrors: true,
          blocksCount: 0,
        }
        postMessage({ type: 'geometry', key, geometry: errorGeometry, workerIndex })
      }
    }

    const dirtyTimes = dirtySections.get(key)
    if (!dirtyTimes) throw new Error('dirtySections.get(key) is falsy')
    for (let i = 0; i < dirtyTimes; i++) {
      postMessage({ type: 'sectionFinished', key, workerIndex, processTime })
      processTime = 0
    }
    dirtySections.delete(key)
  }
}, 50)
