/**
 * Production wiring for the dedicated WASM light-owner, behind
 * `enableClientLightOwner` (default OFF).
 *
 * Product forks (matches §10, simpler option):
 * - `ingestBlockSection` is sent from the main thread from prismarine column
 *   JSON in `addColumn`. Mesh workers stay read-only copies; N workers must
 *   not each ingest (would duplicate/reorder). The renderer is the sequencer.
 * - Nether/End sky: `playerStateReactive.lightingDisabled` is already true for
 *   the_nether / the_end / !has_skylight. That drives `setSkyLightEnabled`.
 */

import Chunks from 'prismarine-chunk'
import { Vec3 } from 'vec3'
import { RendererLightCache } from './rendererLightCache'
import { applyLightPublication, sectionIndexToWorldOrigin, type LightOwnerEvent, type LightPublication, type PublicationGate } from './lightOwnerHost'
import { buildLightTables1171 } from './lightTables1171'

export { packUnpackedLightSection, unpackPackedLightSection } from '../mesher-shared/lightNibblePack'
export { eventsFromParsedUpdateLight } from '../wasm-mesher/worker/updateLightToOwnerEvents'

export const LIGHT_OWNER_WORKER_SCRIPT = 'lightOwnerWorker.js'

export type ClientLightOwnerLifecycle = 'starting' | 'ready' | 'failed'

export function shouldSpawnClientLightOwner(config: { enableClientLightOwner?: boolean }): boolean {
  return config.enableClientLightOwner === true
}

/** Sky engine on unless the dimension already reported no skylight (nether/end). */
export function skyLightEnabledFromRendererState(state: { lightingDisabled?: boolean }): boolean {
  return state.lightingDisabled !== true
}

export function blockChangeEvent(x: number, y: number, z: number, stateId: number): LightOwnerEvent {
  return { type: 'blockChange', x, y, z, stateId }
}

export function eventsFromColumnUnload(chunkX: number, chunkZ: number): LightOwnerEvent {
  return { type: 'unloadColumn', sx: Math.floor(chunkX / 16), sz: Math.floor(chunkZ / 16) }
}

export function dirtyMeshSectionsFromChangedLight(
  changed: Array<{ sx: number; sy: number; sz: number }>,
  opts?: { coords?: 'world' | 'section-index' }
): Array<{ sx: number; sy: number; sz: number }> {
  const coords = opts?.coords ?? 'world'
  const keys = new Set<string>()
  const out: Array<{ sx: number; sy: number; sz: number }> = []
  const add = (sx: number, sy: number, sz: number) => {
    const key = `${sx},${sy},${sz}`
    if (keys.has(key)) return
    keys.add(key)
    out.push({ sx, sy, sz })
  }
  for (const section of changed) {
    const origin = coords === 'section-index' ? sectionIndexToWorldOrigin(section.sx, section.sy, section.sz) : section
    add(origin.sx, origin.sy, origin.sz)
    add(origin.sx - 16, origin.sy, origin.sz)
    add(origin.sx + 16, origin.sy, origin.sz)
    add(origin.sx, origin.sy - 16, origin.sz)
    add(origin.sx, origin.sy + 16, origin.sz)
    add(origin.sx, origin.sy, origin.sz - 16)
    add(origin.sx, origin.sy, origin.sz + 16)
  }
  return out
}

export function shouldAcceptMeshGeometry(mesh: { worldGeneration?: number; lightPublicationVersion?: number }, gate: PublicationGate): boolean {
  if (mesh.worldGeneration == null && mesh.lightPublicationVersion == null) return true
  if (mesh.worldGeneration != null && mesh.worldGeneration !== gate.acceptedGeneration) return false
  if (mesh.lightPublicationVersion != null && mesh.lightPublicationVersion < gate.lastVersion) return false
  return true
}

export function eventsFromColumnLoad(opts: {
  chunkX: number
  chunkZ: number
  chunkJson: unknown
  version: string
  worldMinY: number
  worldHeight: number
}): LightOwnerEvent[] {
  const Chunk = Chunks(opts.version) as ReturnType<typeof Chunks>
  let column: { getBlockStateId: (pos: Vec3) => number }
  try {
    if (opts.chunkJson && typeof (opts.chunkJson as { getBlockStateId?: unknown }).getBlockStateId === 'function') {
      column = opts.chunkJson as { getBlockStateId: (pos: Vec3) => number }
    } else {
      column = Chunk.fromJson(opts.chunkJson as Parameters<ReturnType<typeof Chunks>['fromJson']>[0]) as unknown as {
        getBlockStateId: (pos: Vec3) => number
      }
    }
  } catch {
    return []
  }

  const sx = Math.floor(opts.chunkX / 16)
  const sz = Math.floor(opts.chunkZ / 16)
  const events: LightOwnerEvent[] = []
  const pos = new Vec3(0, 0, 0)
  const worldMaxY = opts.worldMinY + opts.worldHeight
  for (let y0 = opts.worldMinY; y0 < worldMaxY; y0 += 16) {
    const states = new Uint16Array(4096)
    for (let ly = 0; ly < 16; ly++) {
      pos.y = y0 + ly
      for (let lz = 0; lz < 16; lz++) {
        pos.z = lz
        for (let lx = 0; lx < 16; lx++) {
          pos.x = lx
          let stateId = 0
          try {
            stateId = column.getBlockStateId(pos) || 0
          } catch {
            stateId = 0
          }
          states[lx + lz * 16 + ly * 256] = stateId
        }
      }
    }
    const sy = Math.floor(y0 / 16)
    events.push({ type: 'ingestBlockSection', sx, sy, sz, states })
    events.push({ type: 'setAvailability', sx, sy, sz, availability: 'loaded' })
  }
  return events
}

export type OwnerWorkerLightMessage = {
  type: 'applyOwnerLightPublication'
  worldGeneration: number
  publicationVersion: number
  sections: Array<{ sx: number; sy: number; sz: number; blockLight: Uint8Array; skyLight?: Uint8Array }>
}

export type OwnerPublicationApplyResult = {
  applied: boolean
  lastVersion: number
  acceptedGeneration: number
  dirtyMeshSections: Array<{ sx: number; sy: number; sz: number }>
  workerMessage: OwnerWorkerLightMessage | null
}

export function applyOwnerPublicationToRenderer(
  cache: RendererLightCache,
  publication: LightPublication,
  gate: PublicationGate,
  coords: 'world' | 'section-index' = 'section-index'
): OwnerPublicationApplyResult {
  const result = applyLightPublication(cache, publication, gate, coords)
  if (!result.applied) {
    return {
      applied: false,
      lastVersion: result.lastVersion,
      acceptedGeneration: result.acceptedGeneration,
      dirtyMeshSections: [],
      workerMessage: null
    }
  }
  const worldSections = publication.sections.map(section => {
    const origin = coords === 'section-index' ? sectionIndexToWorldOrigin(section.sx, section.sy, section.sz) : section
    return {
      sx: origin.sx,
      sy: origin.sy,
      sz: origin.sz,
      blockLight: section.blockLight,
      skyLight: section.skyLight
    }
  })
  return {
    applied: true,
    lastVersion: result.lastVersion,
    acceptedGeneration: result.acceptedGeneration,
    dirtyMeshSections: dirtyMeshSectionsFromChangedLight(worldSections, { coords: 'world' }),
    workerMessage: {
      type: 'applyOwnerLightPublication',
      worldGeneration: publication.worldGeneration,
      publicationVersion: publication.publicationVersion,
      sections: worldSections
    }
  }
}

export function loadDefaultOwnerLightTables(): { emission: Uint8Array; opacity: Uint8Array; occupancy: Uint8Array } {
  const tables = buildLightTables1171()
  return { emission: tables.emission, opacity: tables.opacity, occupancy: tables.occupancy }
}

export class ClientLightOwnerSession {
  readonly worker: Worker
  gate: PublicationGate = { acceptedGeneration: 1, lastVersion: 0 }
  private stepScheduled = false
  private lifecycle: ClientLightOwnerLifecycle = 'starting'

  constructor(
    private readonly cache: RendererLightCache,
    opts: {
      createWorker: (onMessage: (data: any) => void) => Worker
      worldMinY: number
      worldHeight: number
      skyLightEnabled: boolean
      onApplied: (result: OwnerPublicationApplyResult) => void
    }
  ) {
    this.onApplied = opts.onApplied
    this.worker = opts.createWorker(data => this.onMessage(data))
    this.worker.onerror = event => {
      this.fail(event?.message || 'light owner worker error')
    }
    this.worker.postMessage({ type: 'init', worldMinY: opts.worldMinY, worldHeight: opts.worldHeight })
    const tables = loadDefaultOwnerLightTables()
    this.worker.postMessage({ type: 'setLightTables', emission: tables.emission, opacity: tables.opacity, occupancy: tables.occupancy })
    this.worker.postMessage({ type: 'setSkyLightEnabled', enabled: opts.skyLightEnabled })
  }

  get state(): ClientLightOwnerLifecycle {
    return this.lifecycle
  }

  get isReady(): boolean {
    return this.lifecycle === 'ready'
  }

  private readonly onApplied: (result: OwnerPublicationApplyResult) => void

  pushEvent(event: LightOwnerEvent) {
    if (this.lifecycle === 'failed') return
    this.worker.postMessage({ type: 'pushEvent', event })
    this.scheduleStep()
  }

  pushRawUpdateLight(kind: 'setUpdateLightV17' | 'setUpdateLightV16', payload: Record<string, unknown>) {
    if (this.lifecycle === 'failed') return
    this.worker.postMessage({ type: kind, ...payload })
    this.scheduleStep()
  }

  setSkyLightEnabled(enabled: boolean) {
    if (this.lifecycle === 'failed') return
    this.worker.postMessage({ type: 'setSkyLightEnabled', enabled })
    this.scheduleStep()
  }

  ingestColumn(opts: Parameters<typeof eventsFromColumnLoad>[0]) {
    for (const event of eventsFromColumnLoad(opts)) this.pushEvent(event)
  }

  onBlockChange(x: number, y: number, z: number, stateId: number) {
    this.pushEvent(blockChangeEvent(x, y, z, stateId))
  }

  onUnload(chunkX: number, chunkZ: number) {
    this.pushEvent(eventsFromColumnUnload(chunkX, chunkZ))
  }

  terminate() {
    this.worker.terminate()
  }

  private fail(_reason: string) {
    if (this.lifecycle === 'failed') return
    this.lifecycle = 'failed'
    this.stepScheduled = false
  }

  private scheduleStep() {
    if (this.stepScheduled || this.lifecycle === 'failed') return
    this.stepScheduled = true
    setTimeout(() => {
      this.stepScheduled = false
      if (this.lifecycle === 'failed') return
      this.worker.postMessage({ type: 'step', budgetMs: 5 })
    }, 0)
  }

  private onMessage(data: any) {
    if (!data || typeof data !== 'object') return
    if (data.type === 'error') {
      this.fail(typeof data.error === 'string' ? data.error : 'light owner worker error')
      return
    }
    if (this.lifecycle === 'failed') return
    if (data.type === 'ready' || data.type === 'tablesSet') {
      this.lifecycle = 'ready'
    }
    if (data.type === 'stepped') {
      if (data.publication) this.applyPublication(data.publication)
      if (data.remaining) this.scheduleStep()
    }
    if (data.type === 'publication' && data.publication) this.applyPublication(data.publication)
  }

  private applyPublication(publication: LightPublication) {
    if (this.lifecycle !== 'ready') return
    const result = applyOwnerPublicationToRenderer(this.cache, publication, this.gate, 'section-index')
    if (!result.applied) return
    this.gate = { acceptedGeneration: result.acceptedGeneration, lastVersion: result.lastVersion }
    this.onApplied(result)
  }
}
