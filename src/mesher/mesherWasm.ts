import { Vec3 } from 'vec3'
import { convertChunkToWasm } from '../wasm-lib/convertChunk'
import { renderWasmOutputToGeometry, splitColumnWasmOutputToSections } from '../wasm-lib/render-from-wasm'
import { setBlockStatesData as setMesherData } from './models'
import { defaultMesherConfig, type MesherGeometryOutput, IS_FULL_WORLD_SECTION, SECTION_HEIGHT } from './shared'
import { worldColumnKey, World } from './world'
import { handleGetHeightmap } from './computeHeightmap'
import { collectBlockEntityMetadata, type SignMeta, type HeadMeta, type BannerMeta } from './blockEntityMetadata'
import { SectionRequestTracker } from './mesherWasmRequestTracker'
import {
  clearConversionCache,
  getOrConvertColumn,
  invalidateConversion,
} from './mesherWasmConversionCache'

let wasm: typeof import('../../wasm/wasm_mesher.js') | null = null
let wasmInitialized = false

async function initWasm() {
  if (wasmInitialized) return
  try {
    wasmInitialized = true
    wasm = await import('../../wasm/wasm_mesher.js')
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
// Kept in sync with `dirtySections` so column mode can filter outgoing
// geometry/sectionFinished events to only the section keys requested by the
// main thread, even though a full-column WASM call may generate more data.
const requestTracker = new SectionRequestTracker()
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

// Single emit point for `sectionFinished`. Consumes one pending request from
// `requestTracker` and posts via the existing batched `postMessage` queue.
//
// When `wasmColumnMesher` is ON, an emit for a non-requested key is a
// contract violation (`WorldRendererCommon` would throw on the main thread)
// and we surface it via `console.warn` so it shows up in dev/CI without
// killing the worker.
const emitSectionFinished = (payload: { type: 'sectionFinished', key: string } & Record<string, any>) => {
  const consumed = requestTracker.consumeOne(payload.key)
  if (!consumed && (config?.wasmColumnMesher ?? false)) {
    console.warn(`[WASM Mesher] sectionFinished for non-requested key ${payload.key} (column-mode contract violation)`)
  }
  postMessage(payload)
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
    // The main thread waits for a sectionFinished response to dirty=false too.
    // Record + consume it so request accounting stays balanced.
    requestTracker.addRequest(key)
    emitSectionFinished({ type: 'sectionFinished', key, workerIndex })
    return
  }

  // Check if we have the chunk for this section
  const chunk = world?.getColumn(x, z)
  if (chunk?.getSection(pos)) {
    dirtySections.set(key, (dirtySections.get(key) || 0) + 1)
    requestTracker.addRequest(key)
  } else {
    // Missing chunks still owe the main thread a sectionFinished response.
    requestTracker.addRequest(key)
    emitSectionFinished({ type: 'sectionFinished', key, workerIndex })
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
      // Conservative: blockstates/version/world config may have changed.
      clearConversionCache()

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
      // Invalidate BEFORE replacing the column reference so a stale entry
      // can never outlive the old chunk object.
      invalidateConversion(data.x, data.z)
      if (!world) break
      world.addColumn(data.x, data.z, data.chunk)
      if (data.customBlockModels) {
        const chunkKey = `${data.x},${data.z}`
        world.customBlockModels.set(chunkKey, data.customBlockModels)
      }
      break
    }
    case 'unloadChunk': {
      invalidateConversion(data.x, data.z)
      if (!world) break
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

      const chunkX = Math.floor(loc.x / 16) * 16
      const chunkZ = Math.floor(loc.z / 16) * 16
      // In-place mutation preserves chunk identity; explicit invalidation
      // is required so the next tick recomputes from current block state.
      invalidateConversion(chunkX, chunkZ)
      const chunkKey = `${chunkX},${chunkZ}`
      if (data.customBlockModels) {
        world?.customBlockModels.set(chunkKey, data.customBlockModels)
      }
      break
    }
    case 'reset': {
      world = undefined as any
      dirtySections.clear()
      requestTracker.clear()
      clearConversionCache()
      globalVar.mcData = null
      globalVar.loadedData = null
      allDataReady = false
      break
    }
    case 'getHeightmap': {
      if (!world) {
        postMessage({ type: 'heightmap', key: `${data.x},${data.z}`, heightmap: new Int16Array(256) })
        break
      }
      const { key, heightmap } = handleGetHeightmap(world, data.x, data.z)
      postMessage({ type: 'heightmap', key, heightmap }, [heightmap.buffer])

      break
    }
    // Note: getCustomBlockModel not implemented in WASM version
    // as it requires World class functionality
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

// Column-mode variant of `collectChunksForSection`: same 3x3 X/Z neighbor
// set, but Y-agnostic because full-column meshing converts the entire world Y
// range in one go. Kept separate so the per-section path stays unchanged.
function collectChunksForColumn(x: number, z: number) {
  const result = [] as Array<{ x: number, z: number, chunk: any }>
  const target = world.getColumn(x, z)
  if (target) result.push({ x, z, chunk: target })
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
  return result
}

function makeEmptyColumnGeometry(sx: number, sy: number, sz: number, sectionHeight: number, hadErrors: boolean): MesherGeometryOutput {
  return {
    sectionYNumber: (sy - (config?.worldMinY || 0)) >> 4,
    chunkKey: worldColumnKey(sx, sz),
    sectionStartY: sy,
    sectionEndY: sy + sectionHeight,
    sectionStartX: sx,
    sectionEndX: sx + 16,
    sectionStartZ: sz,
    sectionEndZ: sz + 16,
    sx: sx + 8,
    sy: sy + 8,
    sz: sz + 8,
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
    hadErrors,
    blocksCount: 0,
  }
}

// Full-column meshing path. Enabled only by `config.wasmColumnMesher`.
// It groups dirty section keys by chunk column, runs one WASM call per column
// over the full Y range, then splits the column output back into per-section
// geometries. Only requested section keys are emitted back to the main thread.
function processColumnTick() {
  const worldMinY = config?.worldMinY ?? 0
  const worldMaxY = config?.worldMaxY ?? 256
  const columnHeight = worldMaxY - worldMinY
  const sectionHeight = SECTION_HEIGHT

  // Group dirty sections by chunk column (`${x},${z}` in world block
  // coords — the same units used by section keys). This guarantees a
  // single WASM call per column per tick even when multiple section keys
  // of the same column are dirty.
  const groups = new Map<string, { x: number, z: number, sections: Array<{ key: string, x: number, y: number, z: number, count: number }> }>()
  for (const [key, count] of dirtySections) {
    const [sx, sy, sz] = key.split(',').map(v => parseInt(v, 10))
    const colKey = `${sx},${sz}`
    let g = groups.get(colKey)
    if (!g) {
      g = { x: sx, z: sz, sections: [] }
      groups.set(colKey, g)
    }
    g.sections.push({ key, x: sx, y: sy, z: sz, count })
  }
  dirtySections.clear()

  for (const group of groups.values()) {
    const { x, z, sections } = group
    const targetChunk = world.getColumn(x, z)

    let exportedMap: Map<string, import('../three/worldGeometryExport').ExportedSection> | null = null
    let processTime = 0
    let prePhase = 0
    let wasmPhase = 0
    let postPhase = 0
    let preTargetConvert = 0
    let preNeighborConvert = 0
    let preNeighborCount = 0
    let preTypedArrayBuild = 0
    let preOther = 0
    let preCacheHits = 0
    let preCacheMisses = 0
    let hadError = false

    if (targetChunk && wasm) {
      const start = performance.now()
      const t0 = start
      try {
        const chunksToUse = collectChunksForColumn(x, z)
        const chunkCount = chunksToUse.length

        const conversions = chunksToUse.map(({ x: cx, z: cz, chunk }) => {
          const cs = performance.now()
          const { result: conv, hit } = getOrConvertColumn(
            cx,
            cz,
            chunk,
            version,
            worldMinY,
            worldMaxY,
            () => convertChunkToWasm(
              chunk,
              version,
              cx,
              cz,
              worldMinY,
              worldMaxY
              // No sectionY/sectionHeight => full column conversion.
            ),
            chunk
          )
          const ce = performance.now()
          if (hit) preCacheHits++
          else preCacheMisses++
          if (cx === x && cz === z) {
            preTargetConvert += ce - cs
          } else {
            preNeighborConvert += ce - cs
            preNeighborCount++
          }
          return conv
        })

        const {
          invisibleBlocks,
          transparentBlocks,
          noAoBlocks,
          cullIdenticalBlocks,
          occludingBlocks,
        } = conversions[0]

        let wasmResult: any
        let t1: number
        if (chunkCount === 1 || !(wasm as any).generate_geometry_multi) {
          // Single-chunk path: no discrete typed-array build/copy step
          // (the per-chunk arrays from convertChunkToWasm are passed
          // straight through). preTypedArrayBuild stays 0.
          const { blockStates, blockLight, skyLight, biomesArray } = conversions[0]
          t1 = performance.now()
          wasmResult = wasm.generate_geometry(
            x, worldMinY, z, columnHeight,
            worldMinY, worldMaxY,
            worldMinY,
            blockStates, blockLight, skyLight, biomesArray,
            invisibleBlocks, transparentBlocks, noAoBlocks, cullIdenticalBlocks, occludingBlocks,
            config?.enableLighting !== false,
            config?.smoothLighting !== false,
            config?.skyLight || 15
          )
        } else {
          const tBuildStart = performance.now()
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
          preTypedArrayBuild = performance.now() - tBuildStart

          t1 = performance.now()
          wasmResult = (wasm as any).generate_geometry_multi(
            x, worldMinY, z, columnHeight,
            worldMinY, worldMaxY,
            worldMinY,
            xs, zs,
            blockStatesAll, blockLightAll, skyLightAll, biomesAll,
            invisibleBlocks, transparentBlocks, noAoBlocks, cullIdenticalBlocks, occludingBlocks,
            config?.enableLighting !== false,
            config?.smoothLighting !== false,
            config?.skyLight || 15
          )
        }

        const t2 = performance.now()

        // Split full-column output back into per-section ExportedSection
        // entries — only for the section keys the main thread actually
        // requested. Sections in the column that were NOT requested are
        // intentionally skipped (the request tracker would warn if we
        // emitted sectionFinished for them).
        const requestedSectionKeys = sections.map(s => ({ x: s.x, y: s.y, z: s.z }))
        exportedMap = splitColumnWasmOutputToSections(
          wasmResult,
          requestedSectionKeys,
          { version, world, sectionHeight }
        )

        const t3 = performance.now()
        prePhase = t1 - t0
        wasmPhase = t2 - t1
        postPhase = t3 - t2
        preOther = Math.max(0, prePhase - (preTargetConvert + preNeighborConvert + preTypedArrayBuild))
        processTime = performance.now() - start
      } catch (err) {
        console.error(`[WASM Mesher] Error processing column ${x},${z}:`, err)
        hadError = true
      }
    }

    // Emit geometry + sectionFinished for each requested section. Column-
    // level perf metrics are attributed to the first sectionFinished of
    // the first requested section (others get zeros) so totals don't
    // double-count.
    //
    // Coherent chunk appearance:
    // We do NOT need a dedicated `columnFinished` worker message or a
    // `columnGroupId` field on geometry messages. The existing display
    // contract already produces a coherent per-column reveal when the
    // user enables the "Batch Chunks Display" (`_renderByChunks`) option:
    //
    //   1. ChunkMeshManager.addSectionMesh
    //      (src/three/chunkMeshManager.ts ~L266) — when `_renderByChunks`
    //      is on AND `worldRenderer.finishedChunks[chunkKey]` is false,
    //      the freshly created section object is set to
    //      `visible = false` and pushed onto
    //      `waitingChunksToDisplay[chunkKey]`.
    //
    //   2. WorldRendererCommon.handleMessage (sectionFinished branch,
    //      src/lib/worldrendererCommon.ts ~L385–L418) decrements
    //      `sectionsWaiting`, marks `finishedSections[key]`, and once
    //      every expected section key of the column is finished sets
    //      `finishedChunks[chunkKey] = true` and emits `chunkFinished`.
    //
    //   3. WorldRendererThree (src/three/worldRendererThree.ts ~L204
    //      and ~L755) listens for `chunkFinished` and calls
    //      `chunkMeshManager.finishChunkDisplay(chunkKey)`, which flips
    //      visibility on every queued section of that column at once.
    //
    // Because this column-mode loop posts a geometry + sectionFinished
    // pair for each requested section key of the column in a single
    // worker tick, those messages arrive back-to-back on the main thread
    // and step (2) only flips `chunkFinished` once the LAST per-column
    // sectionFinished is processed — at which point step (3) reveals the
    // entire column atomically. We therefore intentionally rely on
    // `_renderByChunks` rather than postMessage batch atomicity (which
    // does not exist between individual messages).
    //
    // Implications:
    //   - When the user has `_renderByChunks` OFF, behavior matches the
    //     legacy per-section path: sections appear as their geometry
    //     arrives. This is acceptable parity, not a regression.
    //   - For block-edit re-meshes where the column was already finished
    //     previously, ChunkMeshManager (L276) correctly bypasses
    //     batching to avoid flicker. Column mode does not change this.
    //   - The request tracker still gates per-section emission, so
    //     `sectionFinished` count on the main thread is exactly the
    //     count the main thread requested.
    let firstEvent = true
    for (const s of sections) {
      const { key, x: sx, y: sy, z: sz, count } = s

      if (exportedMap && !hadError) {
        const exported = exportedMap.get(key)
        // Block entity metadata still needs a per-section world walk
        // (signs/heads/banners), matching the legacy per-section path.
        const signs: Record<string, SignMeta> = {}
        const heads: Record<string, HeadMeta> = {}
        const banners: Record<string, BannerMeta> = {}
        const beTarget = { signs, heads, banners }
        const beOpts = { disableBlockEntityTextures: world.config.disableBlockEntityTextures }
        const cursor = new Vec3(0, 0, 0)
        for (cursor.y = sy; cursor.y < sy + sectionHeight; cursor.y++) {
          for (cursor.z = sz; cursor.z < sz + 16; cursor.z++) {
            for (cursor.x = sx; cursor.x < sx + 16; cursor.x++) {
              const b = world.getBlock(cursor)
              if (!b) continue
              collectBlockEntityMetadata(b, cursor.x, cursor.y, cursor.z, beTarget, beOpts)
            }
          }
        }

        let geometry: MesherGeometryOutput
        let transferable: any[] = []
        if (exported && exported.geometry.indices.length > 0) {
          const maxIndex = exported.geometry.indices.length > 0
            ? Math.max(...exported.geometry.indices)
            : 0
          const using32Array = maxIndex > 65535
          geometry = {
            sectionYNumber: (sy - (config?.worldMinY || 0)) >> 4,
            chunkKey: worldColumnKey(sx, sz),
            sectionStartY: sy,
            sectionEndY: sy + sectionHeight,
            sectionStartX: sx,
            sectionEndX: sx + 16,
            sectionStartZ: sz,
            sectionEndZ: sz + 16,
            sx: sx + 8,
            sy: sy + 8,
            sz: sz + 8,
            positions: new Float32Array(exported.geometry.positions),
            normals: new Float32Array(exported.geometry.normals),
            colors: new Float32Array(exported.geometry.colors),
            uvs: new Float32Array(exported.geometry.uvs),
            indices: using32Array
              ? new Uint32Array(exported.geometry.indices)
              : new Uint16Array(exported.geometry.indices),
            indicesCount: exported.geometry.indices.length,
            using32Array,
            tiles: {},
            heads,
            signs,
            banners,
            hadErrors: false,
            // Column-mode does not propagate per-section block_count
            // (splitColumnWasmOutputToSections returns ExportedSection
            // only). Set to 0; the field is informational.
            blocksCount: 0,
          }
          transferable = [
            geometry.positions?.buffer,
            geometry.normals?.buffer,
            geometry.colors?.buffer,
            geometry.uvs?.buffer,
            //@ts-ignore
            geometry.indices?.buffer,
          ].filter(Boolean)
        } else {
          geometry = makeEmptyColumnGeometry(sx, sy, sz, sectionHeight, false)
          // Still attach block entity metadata so the main thread sees
          // signs/heads/banners even for empty-mesh sections.
          geometry.signs = signs
          geometry.heads = heads
          geometry.banners = banners
        }
        postMessage({ type: 'geometry', key, geometry, workerIndex }, transferable)
      } else if (hadError) {
        const errorGeometry = makeEmptyColumnGeometry(sx, sy, sz, sectionHeight, true)
        postMessage({ type: 'geometry', key, geometry: errorGeometry, workerIndex })
      }
      // No targetChunk and no error: skip geometry message (mirrors
      // legacy behavior for sections whose chunk has been unloaded
      // mid-tick) but still emit sectionFinished below so the main
      // thread's sectionsWaiting counter unblocks.

      const pt = firstEvent ? processTime : 0
      const pre = firstEvent ? prePhase : 0
      const w = firstEvent ? wasmPhase : 0
      const post = firstEvent ? postPhase : 0
      const ptc = firstEvent ? preTargetConvert : 0
      const pnc = firstEvent ? preNeighborConvert : 0
      const pncn = firstEvent ? preNeighborCount : 0
      const ptab = firstEvent ? preTypedArrayBuild : 0
      const po = firstEvent ? preOther : 0
      const pch = firstEvent ? preCacheHits : 0
      const pcm = firstEvent ? preCacheMisses : 0
      let attributed = false
      for (let i = 0; i < count; i++) {
        emitSectionFinished({
          type: 'sectionFinished',
          key,
          workerIndex,
          processTime: !attributed ? pt : 0,
          pre: !attributed ? pre : 0,
          wasm: !attributed ? w : 0,
          post: !attributed ? post : 0,
          preTargetConvert: !attributed ? ptc : 0,
          preNeighborConvert: !attributed ? pnc : 0,
          preNeighborCount: !attributed ? pncn : 0,
          preTypedArrayBuild: !attributed ? ptab : 0,
          preOther: !attributed ? po : 0,
          preCacheHits: !attributed ? pch : 0,
          preCacheMisses: !attributed ? pcm : 0,
        })
        attributed = true
      }
      firstEvent = false
    }
  }
}

setInterval(async () => {
  if (!allDataReady) return

  // Ensure WASM is initialized
  if (!wasmInitialized) {
    await initWasm()
    if (!wasmInitialized) return // Still not initialized, skip this cycle
  }

  if (dirtySections.size === 0) return

  // The legacy per-section loop below remains unchanged when column mode is
  // disabled.
  if (config?.wasmColumnMesher) {
    try {
      processColumnTick()
    } catch (err) {
      console.error('[WASM Mesher] processColumnTick failed:', err)
      // Swallow to avoid breaking the setInterval; individual columns
      // already have their own try/catch.
    }
    return
  }

  const sectionHeight = getSectionHeight()

  for (const key of dirtySections.keys()) {
    // for (const key of [] as string[]) {
    const [x, y, z] = key.split(',').map(v => parseInt(v, 10))
    const chunk = world.getColumn(x, z)

    let processTime = 0
    let prePhase = 0
    let wasmPhase = 0
    let postPhase = 0
    let preTargetConvert = 0
    let preNeighborConvert = 0
    let preNeighborCount = 0
    let preTypedArrayBuild = 0
    let preOther = 0
    if (chunk?.getSection(new Vec3(x, y, z)) && wasm) {
      const start = performance.now()
      const t0 = start

      try {
        // Convert chunk to WASM format (always recompute since section is dirty)
        const worldMinY = config?.worldMinY || 0
        const worldMaxY = config?.worldMaxY || 256

        // Expand the data range by ±1 Y block so WASM can correctly cull faces at section
        // boundaries (without this, the block above/below a section always appears as air).
        // We clamp to world bounds and pass section_data_start_y to WASM so it knows the offset.
        const sectionDataStartY = IS_FULL_WORLD_SECTION ? worldMinY : Math.max(y - 1, worldMinY)
        const sectionDataEndY = IS_FULL_WORLD_SECTION ? worldMaxY : Math.min(y + sectionHeight + 1, worldMaxY)
        const sectionDataHeight = sectionDataEndY - sectionDataStartY

        const convertSectionY = IS_FULL_WORLD_SECTION ? undefined : sectionDataStartY
        const convertSectionHeight = IS_FULL_WORLD_SECTION ? undefined : sectionDataHeight

        // Run WASM mesher for this section
        const chunksToUse = collectChunksForSection(x, y, z)
        const chunkCount = chunksToUse.length

        const conversions = chunksToUse.map(({ x: cx, z: cz, chunk }) => {
          const cs = performance.now()
          const conv = convertChunkToWasm(
            chunk,
            version,
            cx,
            cz,
            worldMinY,
            worldMaxY,
            convertSectionY,
            convertSectionHeight
          )
          const ce = performance.now()
          if (cx === x && cz === z) {
            preTargetConvert += ce - cs
          } else {
            preNeighborConvert += ce - cs
            preNeighborCount++
          }
          return conv
        })

        const {
          invisibleBlocks,
          transparentBlocks,
          noAoBlocks,
          cullIdenticalBlocks,
          occludingBlocks,
        } = conversions[0]

        let wasmResult
        let t1: number
        if (chunkCount === 1 || !(wasm as any).generate_geometry_multi) {
          // Single-chunk path: no discrete typed-array build/copy step.
          const { blockStates, blockLight, skyLight, biomesArray } = conversions[0]
          t1 = performance.now()
          wasmResult = wasm.generate_geometry(
            x, y, z, sectionHeight,
            worldMinY, worldMaxY,
            sectionDataStartY,
            blockStates, blockLight, skyLight, biomesArray,
            invisibleBlocks, transparentBlocks, noAoBlocks, cullIdenticalBlocks, occludingBlocks,
            config?.enableLighting !== false,
            config?.smoothLighting !== false,
            config?.skyLight || 15
          )
        } else {
          const tBuildStart = performance.now()
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
          preTypedArrayBuild = performance.now() - tBuildStart

          t1 = performance.now()
          wasmResult = (wasm as any).generate_geometry_multi(
            x, y, z, sectionHeight,
            worldMinY, worldMaxY,
            sectionDataStartY,
            xs, zs,
            blockStatesAll, blockLightAll, skyLightAll, biomesAll,
            invisibleBlocks, transparentBlocks, noAoBlocks, cullIdenticalBlocks, occludingBlocks,
            config?.enableLighting !== false,
            config?.smoothLighting !== false,
            config?.skyLight || 15
          )
        }

        // Heightmap is now produced by the dedicated 'getHeightmap' handler (full-column,
        // parity with JS mesher). Per-section heightmaps from WASM are intentionally ignored.

        const t2 = performance.now()

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
        const signs: Record<string, SignMeta> = {}
        const heads: Record<string, HeadMeta> = {}
        const banners: Record<string, BannerMeta> = {}
        const beTarget = { signs, heads, banners }
        const beOpts = { disableBlockEntityTextures: world.config.disableBlockEntityTextures }
        const cursor = new Vec3(0, 0, 0)
        for (cursor.y = y; cursor.y < y + sectionHeight; cursor.y++) {
          for (cursor.z = z; cursor.z < z + 16; cursor.z++) {
            for (cursor.x = x; cursor.x < x + 16; cursor.x++) {
              const b = world.getBlock(cursor)
              if (!b) continue
              collectBlockEntityMetadata(b, cursor.x, cursor.y, cursor.z, beTarget, beOpts)
            }
          }
        }

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
          heads,
          signs,
          banners,
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
        const t3 = performance.now()
        prePhase = t1 - t0
        wasmPhase = t2 - t1
        postPhase = t3 - t2
        preOther = Math.max(0, prePhase - (preTargetConvert + preNeighborConvert + preTypedArrayBuild))
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
      // Route through the shared emitter so request accounting stays in
      // lock-step with the legacy `dirtySections` counter.
      emitSectionFinished({
        type: 'sectionFinished',
        key,
        workerIndex,
        processTime,
        pre: prePhase,
        wasm: wasmPhase,
        post: postPhase,
        preTargetConvert,
        preNeighborConvert,
        preNeighborCount,
        preTypedArrayBuild,
        preOther,
      })
      processTime = 0
      prePhase = 0
      wasmPhase = 0
      postPhase = 0
      preTargetConvert = 0
      preNeighborConvert = 0
      preNeighborCount = 0
      preTypedArrayBuild = 0
      preOther = 0
    }
    dirtySections.delete(key)
  }
}, 50)
