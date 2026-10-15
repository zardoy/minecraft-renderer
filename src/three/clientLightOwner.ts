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
import { buildLightTables1171, LIGHT_TABLES_MC_VERSION } from './lightTables1171'
import {
  comparableNow,
  ingestRemoteClientLightTraceMessage,
  isClientLightTraceEnabled,
  isClientLightTraceMessage,
  recordClientLightTrace
} from '../lib/clientLightTrace'
import {
  shouldAcceptVersionedMesh,
  validateOwnerPublicationMessage,
  type MeshGeometryMode,
  type MeshSectionLightRequirement as VersionedMeshRequirement
} from '../lib/clientLightVersions'

export { packUnpackedLightSection, unpackPackedLightSection } from '../mesher-shared/lightNibblePack'
export { eventsFromParsedUpdateLight } from '../wasm-mesher/worker/updateLightToOwnerEvents'

export const LIGHT_OWNER_WORKER_SCRIPT = 'lightOwnerWorker.js'

export type ClientLightOwnerLifecycle = 'starting' | 'ready' | 'failed'

/** Owner tables are the 1.17.1 registry. Another session version must not start the worker. */
export function shouldSpawnClientLightOwner(config: { enableClientLightOwner?: boolean }, version: string): boolean {
  return config.enableClientLightOwner === true && version === LIGHT_TABLES_MC_VERSION
}

export function clientLightOwnerVersionBlockReason(version: string): string | null {
  if (version === LIGHT_TABLES_MC_VERSION) return null
  return `client light owner supports ${LIGHT_TABLES_MC_VERSION} only (session ${version})`
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
    for (let dx = -16; dx <= 16; dx += 16) {
      for (let dy = -16; dy <= 16; dy += 16) {
        for (let dz = -16; dz <= 16; dz += 16) {
          add(origin.sx + dx, origin.sy + dy, origin.sz + dz)
        }
      }
    }
  }
  return out
}

export type MeshSectionLightRequirement = VersionedMeshRequirement

export function meshSectionKey(sx: number, sy: number, sz: number): string {
  return `${sx},${sy},${sz}`
}

/** Workers that mesh any dirty section; empty means fall back to every worker. */
export function meshWorkerIndexesForDirtySections(
  dirty: Array<{ sx: number; sy: number; sz: number }>,
  workerCount: number,
  indexForSection: (sx: number, sy: number, sz: number) => number
): number[] {
  if (workerCount <= 0 || dirty.length === 0) return []
  const indexes = new Set<number>()
  for (const section of dirty) {
    const index = indexForSection(section.sx, section.sy, section.sz)
    if (index >= 0 && index < workerCount) indexes.add(index)
  }
  return [...indexes]
}

export function raiseRequiredLightRevisions(
  required: Map<string, MeshSectionLightRequirement>,
  dirtyMeshSections: Array<{ sx: number; sy: number; sz: number }>,
  publicationVersion: number,
  worldGeneration: number,
  topologyBySection?: Map<string, number>
): void {
  for (const section of dirtyMeshSections) {
    const key = meshSectionKey(section.sx, section.sy, section.sz)
    const prev = required.get(key)
    const liveTopology = topologyBySection?.get(key)
    const topologyRevision = Math.max(prev?.topologyRevision ?? 0, liveTopology ?? 0) || undefined
    const next: MeshSectionLightRequirement = {
      requiredVersion: prev?.requiredVersion ?? publicationVersion,
      worldGeneration: prev?.worldGeneration ?? worldGeneration,
      ...(topologyRevision != null ? { topologyRevision } : {})
    }
    if (!prev || worldGeneration > prev.worldGeneration) {
      next.requiredVersion = publicationVersion
      next.worldGeneration = worldGeneration
    } else if (worldGeneration === prev.worldGeneration && publicationVersion > prev.requiredVersion) {
      next.requiredVersion = publicationVersion
    }
    if (
      !prev ||
      next.requiredVersion !== prev.requiredVersion ||
      next.worldGeneration !== prev.worldGeneration ||
      next.topologyRevision !== prev.topologyRevision
    ) {
      required.set(key, next)
    }
  }
}

export function coveringReplacementForReject(opts: {
  accepted: boolean
  required?: MeshSectionLightRequirement | null
}): { lightPublicationVersion: number; worldGeneration: number } | null {
  if (opts.accepted || opts.required == null) return null
  return { lightPublicationVersion: opts.required.requiredVersion, worldGeneration: opts.required.worldGeneration }
}

export function shouldAcceptMeshGeometry(
  mesh: {
    worldGeneration?: number
    lightPublicationVersion?: number
    topologyRevision?: number
    sessionEpoch?: number
    columnIncarnation?: number
    hadErrors?: boolean
    meshMode?: MeshGeometryMode
  },
  _gate: PublicationGate,
  required?: MeshSectionLightRequirement | null,
  opts?: { ownerManaged?: boolean; sessionEpoch?: number; columnIncarnation?: number }
): boolean {
  return shouldAcceptVersionedMesh(mesh, required, {
    ownerManaged: opts?.ownerManaged === true,
    sessionEpoch: opts?.sessionEpoch,
    columnIncarnation: opts?.columnIncarnation
  })
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
  const worldMaxY = opts.worldMinY + opts.worldHeight
  for (let y0 = opts.worldMinY; y0 < worldMaxY; y0 += 16) {
    const states = new Uint16Array(4096)
    fillSectionStates(column, y0, states)
    const sy = Math.floor(y0 / 16)
    events.push({ type: 'ingestBlockSection', sx, sy, sz, states })
    events.push({ type: 'setAvailability', sx, sy, sz, availability: 'loaded' })
  }
  return events
}

type SectionLike = {
  palette?: number[] | null
  data?: { get: (index: number) => number }
  isEmpty?: () => boolean
  getBlock?: (pos: { x: number; y: number; z: number }) => number
}

function sectionAt(column: object, y0: number): SectionLike | null | undefined {
  const withGet = column as { getSection?: (pos: { x: number; y: number; z: number }) => SectionLike | null }
  if (typeof withGet.getSection === 'function') {
    return withGet.getSection({ x: 0, y: y0, z: 0 })
  }
  const withArray = column as { sections?: Array<SectionLike | null>; minY?: number }
  if (Array.isArray(withArray.sections)) {
    return withArray.sections[(y0 - (withArray.minY ?? 0)) >> 4]
  }
  return undefined
}

function fillSectionStates(column: { getBlockStateId: (pos: Vec3) => number }, y0: number, states: Uint16Array) {
  const section = sectionAt(column, y0)
  if (section === null) {
    return
  }
  if (section && typeof section.isEmpty === 'function' && section.isEmpty()) {
    return
  }
  if (section && Array.isArray(section.palette) && section.palette.length === 1) {
    const only = section.palette[0] || 0
    if (only !== 0) states.fill(only)
    return
  }
  if (section?.data && typeof section.data.get === 'function') {
    const palette = section.palette
    for (let i = 0; i < 4096; i++) {
      let stateId = section.data.get(i)
      if (palette) stateId = palette[stateId]
      states[i] = stateId || 0
    }
    return
  }
  const pos = new Vec3(0, y0, 0)
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
}

export type OwnerWorkerLightMessage = {
  type: 'applyOwnerLightPublication'
  worldGeneration: number
  publicationVersion: number
  sessionEpoch?: number
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
  const checked = validateOwnerPublicationMessage(publication)
  if (!checked.ok) {
    return {
      applied: false,
      lastVersion: gate.lastVersion,
      acceptedGeneration: gate.acceptedGeneration,
      dirtyMeshSections: [],
      workerMessage: null
    }
  }
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
  readonly requiredLightBySection = new Map<string, MeshSectionLightRequirement>()
  private stepScheduled = false
  private latestEditGeneration = 0
  private lifecycle: ClientLightOwnerLifecycle = 'starting'
  private lastOwnerEnqueueAt = 0
  private failureReason: string | null = null

  constructor(
    private readonly cache: RendererLightCache,
    opts: {
      createWorker: (onMessage: (data: any) => void) => Worker
      worldMinY: number
      worldHeight: number
      skyLightEnabled: boolean
      onApplied: (result: OwnerPublicationApplyResult) => void
      onFailed?: (reason: string) => void
      onOwnerIdle?: (settledEditGeneration: number) => void
    }
  ) {
    this.onApplied = opts.onApplied
    this.onFailed = opts.onFailed
    this.onOwnerIdle = opts.onOwnerIdle
    this.worker = opts.createWorker(data => this.onMessage(data))
    this.worker.onerror = event => {
      this.fail(event?.message || 'light owner worker error')
    }
    this.worker.postMessage({ type: 'init', worldMinY: opts.worldMinY, worldHeight: opts.worldHeight })
    // 1.17.1 state ids. `shouldSpawnClientLightOwner` refuses every other session version before this runs.
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

  get lastFailureReason(): string | null {
    return this.failureReason
  }

  private readonly onApplied: (result: OwnerPublicationApplyResult) => void
  private readonly onFailed?: (reason: string) => void
  private readonly onOwnerIdle?: (settledEditGeneration: number) => void

  notePlayerEdit(): number {
    this.latestEditGeneration += 1
    return this.latestEditGeneration
  }

  pushEvent(event: LightOwnerEvent) {
    if (this.lifecycle === 'failed') return
    this.worker.postMessage({ type: 'pushEvent', event })
    this.scheduleStep()
    this.lastOwnerEnqueueAt = comparableNow()
    if (isClientLightTraceEnabled()) {
      const currentColumn =
        'x' in event && typeof event.x === 'number'
          ? `${Math.floor(event.x / 16)},${Math.floor((event as { z: number }).z / 16)}`
          : 'sx' in event && typeof event.sx === 'number'
            ? `${event.sx},${(event as { sz: number }).sz}`
            : undefined
      recordClientLightTrace({
        phase: 'ownerEnqueue',
        currentColumn,
        eventAgeMs: 0
      })
    }
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

  requiredLightForSection(key: string): MeshSectionLightRequirement | undefined {
    return this.requiredLightBySection.get(key)
  }

  onUnload(chunkX: number, chunkZ: number) {
    this.pushEvent(eventsFromColumnUnload(chunkX, chunkZ))
    for (const key of [...this.requiredLightBySection.keys()]) {
      const [sx, , sz] = key.split(',').map(Number)
      if (sx === chunkX && sz === chunkZ) this.requiredLightBySection.delete(key)
    }
  }

  terminate() {
    this.worker.terminate()
  }

  private fail(reason: string) {
    if (this.lifecycle === 'failed') return
    this.lifecycle = 'failed'
    this.failureReason = reason
    this.stepScheduled = false
    this.onFailed?.(reason)
  }

  private scheduleStep() {
    if (this.stepScheduled || this.lifecycle === 'failed') return
    this.stepScheduled = true
    setTimeout(() => {
      this.stepScheduled = false
      if (this.lifecycle === 'failed') return
      this.worker.postMessage({ type: 'step', budgetMs: 5, stepGeneration: this.latestEditGeneration })
    }, 0)
  }

  private onMessage(data: any) {
    if (!data || typeof data !== 'object') return
    if (isClientLightTraceMessage(data)) {
      ingestRemoteClientLightTraceMessage(data)
      return
    }
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
      if (data.remaining !== true && typeof data.stepGeneration === 'number') this.onOwnerIdle?.(data.stepGeneration)
    }
    if (data.type === 'publication' && data.publication) this.applyPublication(data.publication)
  }

  private applyPublication(publication: LightPublication) {
    if (this.lifecycle !== 'ready') return
    const result = applyOwnerPublicationToRenderer(this.cache, publication, this.gate, 'section-index')
    if (!result.applied) return
    this.gate = { acceptedGeneration: result.acceptedGeneration, lastVersion: result.lastVersion }
    raiseRequiredLightRevisions(this.requiredLightBySection, result.dirtyMeshSections, result.lastVersion, result.acceptedGeneration)
    this.onApplied(result)
    if (isClientLightTraceEnabled()) {
      recordClientLightTrace({
        phase: 'ownerComplete',
        lightVersion: result.lastVersion,
        worldGeneration: result.acceptedGeneration,
        queueDepth: result.dirtyMeshSections.length,
        txnMs: this.lastOwnerEnqueueAt ? comparableNow() - this.lastOwnerEnqueueAt : undefined
      })
    }
  }
}
