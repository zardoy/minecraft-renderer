import { Vec3 } from 'vec3'
import type { WorldRendererConfig } from '../../graphicsBackend/config'
import type { PlayerStateReactive } from '../../playerState/playerState'
import type { MesherMainEvent } from '../../mesher-shared/shared'
import type { RendererLightCache } from '../cache/rendererLightCache'
import { isClientLightProbeSection, setClientLightProbePositions } from '../debug/clientLightProbe'
import {
  currentClientLightTraceIds,
  isClientLightTraceArmed,
  isClientLightTraceEnabled,
  nextClientLightEditSeq,
  nextClientLightRequestId,
  recordClientLightTrace
} from '../debug/clientLightTrace'
import {
  ClientLightOwnerSession,
  clientLightOwnerVersionBlockReason,
  coveringReplacementForReject,
  meshWorkerIndexesForDirtySections,
  raiseRequiredLightRevisions,
  shouldAcceptMeshGeometry,
  shouldSpawnClientLightOwner,
  skyLightEnabledFromRendererState,
  type OwnerPublicationApplyResult
} from '../owner/clientLightOwner'
import {
  INITIAL_TOPOLOGY_REVISION,
  isOwnerGeometryLightStale,
  nextTopologyRevision,
  shouldDispatchCoveringRemesh,
  validateMeshResultVersions,
  type MeshSectionLightRequirement
} from '../versioning/clientLightVersions'

const CHUNK_SIZE = 16

export type DirtyLightMeta = { lightPublicationVersion?: number; worldGeneration?: number }

/** What the coordinator needs from the world renderer. Getters are read lazily, the renderer replaces `workers` on reset. */
export type ClientLightHost = {
  readonly version: string
  readonly workers: Worker[]
  readonly rendererLightCache: RendererLightCache
  readonly worldRendererConfig: WorldRendererConfig
  readonly worldSizeParams: { minY: number; worldHeight: number }
  readonly playerStateReactive: PlayerStateReactive
  readonly sectionsWaiting: Map<string, number>
  readonly loadedChunks: Record<string, boolean>
  /** Last stored light stamp per section, owned by the renderer's dirty throttle. */
  readonly sectionDirtyLightMeta: Map<string, { lightPublicationVersion: number; worldGeneration?: number }>
  getSectionHeight(): number
  getWorkerNumber(pos: Vec3, updateAction?: boolean): number
  setSectionDirty(pos: Vec3, value?: boolean, useChangeWorker?: boolean): void
  dispatchDirtyImmediate(pos: Vec3, value: boolean, useChangeWorker: boolean): void
  createLightOwnerWorker(onMessage: (data: any) => void): Worker
}

type OwnerGeometryEvent = {
  type?: string
  key?: string
  worldGeneration?: number
  lightPublicationVersion?: number
  topologyRevision?: number
  sessionEpoch?: number
  columnIncarnation?: number
  hadErrors?: boolean
  meshMode?: 'owner' | 'legacyBootstrap'
  geometry?: { hadErrors?: boolean }
}

const columnMatches = (key: string, x: number, z: number) => key.startsWith(`${x},`) && key.endsWith(`,${z}`)

/**
 * Owns the client light owner session and every piece of version bookkeeping that keeps owner-lit meshes
 * consistent: column incarnations, per-section topology revisions, outstanding covering remeshes and
 * player edits waiting for their light. The world renderer only forwards events and stays unaware of the details.
 */
export class ClientLightCoordinator {
  session: ClientLightOwnerSession | null = null
  failureReason: string | null = null
  fence = { sessionEpoch: 1, rejectStaleOwnerMeshes: false }
  readonly columnIncarnationByColumn = new Map<string, number>()
  readonly topologyRevisionBySection = new Map<string, number>()
  readonly pendingTopologyBySection = new Map<string, number>()
  readonly pendingCoveringBySection = new Map<string, MeshSectionLightRequirement>()
  readonly rejectedFinishedBySection = new Map<string, number>()
  /** Stamp applied to the next dirty dispatch; set only while a publication is being turned into remeshes. */
  nextDirtyLightMeta: DirtyLightMeta = {}
  /** Dispatch the next dirty message ahead of the bulk queue. */
  nextDirtyUrgent = false
  /**
   * Player edits whose covering light publication is still outstanding.
   * `lightVersionAtEdit` is the owner version already on screen. Geometry at that
   * version must not clear the edit: the publication for this edit is a newer one.
   */
  readonly interactiveSections = new Map<string, { lightVersionAtEdit: number; editGeneration: number; coveringVersion?: number }>()

  constructor(private readonly host: ClientLightHost) {}

  // --- session lifecycle -------------------------------------------------------------------------------------

  hasOwner(): boolean {
    return this.session?.isReady === true
  }

  isSessionLive(): boolean {
    return this.session != null
  }

  getWorker(): Worker | null {
    return this.session?.worker ?? null
  }

  getFailureReason(): string | null {
    return this.failureReason ?? this.session?.lastFailureReason ?? null
  }

  setProbe(points: Array<[number, number, number]>) {
    setClientLightProbePositions(points)
    for (const worker of this.host.workers) worker.postMessage({ type: 'clientLightProbe', points })
  }

  syncTraceConfig() {
    const message = {
      type: 'clientLightTraceConfig' as const,
      enabled: isClientLightTraceEnabled(),
      armed: isClientLightTraceArmed()
    }
    for (const worker of this.host.workers) {
      worker.postMessage(message)
    }
    this.session?.worker.postMessage(message)
  }

  maybeSpawn() {
    if (this.session) return
    const { worldRendererConfig, version } = this.host
    if (!shouldSpawnClientLightOwner(worldRendererConfig, version)) {
      if (worldRendererConfig.enableClientLightOwner === true) {
        this.failureReason = clientLightOwnerVersionBlockReason(version)
      }
      return
    }
    this.fence = { sessionEpoch: this.fence.sessionEpoch, rejectStaleOwnerMeshes: false }
    this.failureReason = null
    this.session = new ClientLightOwnerSession(this.host.rendererLightCache, {
      createWorker: onMessage => this.host.createLightOwnerWorker(onMessage),
      worldMinY: this.host.worldSizeParams.minY,
      worldHeight: this.host.worldSizeParams.worldHeight,
      skyLightEnabled: skyLightEnabledFromRendererState(this.host.playerStateReactive),
      onApplied: result => this.onPublication(result),
      onFailed: reason => this.onFailed(reason),
      onOwnerIdle: settledEditGeneration => this.releaseInteractiveEditsWithoutCoveringPublication(settledEditGeneration)
    })
    this.postAcceptFence()
    this.syncTraceConfig()
  }

  terminate() {
    if (this.session) {
      this.revertToIncoming('owner-disabled')
    }
    this.session?.terminate()
    this.session = null
    this.nextDirtyLightMeta = {}
  }

  private onFailed(reason: string) {
    this.failureReason = reason
    this.revertToIncoming(reason)
  }

  private revertToIncoming(reason: string) {
    this.fence = {
      sessionEpoch: this.fence.sessionEpoch + 1,
      rejectStaleOwnerMeshes: true
    }
    this.failureReason = reason
    this.interactiveSections.clear()
    this.session?.requiredLightBySection.clear()
    const message = {
      type: 'revertOwnerLightToIncoming' as const,
      sessionEpoch: this.fence.sessionEpoch,
      worldGeneration: this.session?.gate.acceptedGeneration ?? 1
    }
    for (const worker of this.host.workers) {
      worker.postMessage(message)
      worker.postMessage({
        type: 'setOwnerAcceptFence',
        sessionEpoch: this.fence.sessionEpoch,
        rejectOwnerPublications: true
      })
    }
  }

  private postAcceptFence() {
    for (const worker of this.host.workers) {
      worker.postMessage({
        type: 'setOwnerAcceptFence',
        sessionEpoch: this.fence.sessionEpoch,
        rejectOwnerPublications: this.fence.rejectStaleOwnerMeshes
      })
    }
  }

  /** Mesh workers were replaced: their topology revisions belong to the previous mesher lifetime. */
  forgetRequiredTopology() {
    for (const required of this.session?.requiredLightBySection.values() ?? []) {
      delete required.topologyRevision
    }
  }

  /** Drops everything tied to outstanding mesher requests (the workers that owed us answers are gone). */
  clearPendingMesherState() {
    this.pendingCoveringBySection.clear()
    this.pendingTopologyBySection.clear()
    this.rejectedFinishedBySection.clear()
    this.interactiveSections.clear()
  }

  // --- publications ------------------------------------------------------------------------------------------

  onPublication(result: OwnerPublicationApplyResult) {
    const { workers } = this.host
    if (result.workerMessage) {
      const workerMessage = {
        ...result.workerMessage,
        sessionEpoch: this.fence.sessionEpoch
      }
      // A column's own worker needs its light even when nothing there is dirty; a missing section meshes as sky 15.
      const targets = meshWorkerIndexesForDirtySections([...result.dirtyMeshSections, ...workerMessage.sections], workers.length, (sx, sy, sz) =>
        this.host.getWorkerNumber(new Vec3(sx, sy, sz), true)
      )
      const indexes = targets.length ? targets : workers.map((_, index) => index)
      for (const index of indexes) {
        workers[index]?.postMessage(workerMessage)
      }
    }
    this.nextDirtyLightMeta = {
      lightPublicationVersion: result.lastVersion,
      worldGeneration: result.acceptedGeneration
    }
    this.noteCoveringPublication(
      result.lastVersion,
      result.dirtyMeshSections.map(section => `${section.sx},${section.sy},${section.sz}`)
    )
    try {
      if (this.session) {
        raiseRequiredLightRevisions(
          this.session.requiredLightBySection,
          result.dirtyMeshSections,
          result.lastVersion,
          result.acceptedGeneration,
          this.topologyRevisionBySection
        )
      }
      for (const section of result.dirtyMeshSections) {
        const key = `${section.sx},${section.sy},${section.sz}`
        const required = this.session?.requiredLightForSection(key)
        this.pendingCoveringBySection.set(
          key,
          required ?? {
            requiredVersion: result.lastVersion,
            worldGeneration: result.acceptedGeneration
          }
        )
        const urgentCovering = this.sectionTouchesInteractiveWork(key)
        this.nextDirtyUrgent = urgentCovering
        try {
          this.host.setSectionDirty(new Vec3(section.sx, section.sy, section.sz), true, true)
        } finally {
          this.nextDirtyUrgent = false
        }
      }
    } finally {
      this.nextDirtyLightMeta = {}
    }
  }

  // --- mesh results ------------------------------------------------------------------------------------------

  columnIncarnationFor(columnKey: string): number {
    return this.columnIncarnationByColumn.get(columnKey) ?? 1
  }

  evaluateOwnerGeometry(data: OwnerGeometryEvent): { accepted: boolean; keepCovering: boolean } {
    if (data.type !== 'geometry') return { accepted: true, keepCovering: false }
    const ownerManaged = this.session?.isReady === true || this.fence.rejectStaleOwnerMeshes
    if (!ownerManaged && this.session == null) return { accepted: true, keepCovering: false }
    if (data.key) {
      const versions = validateMeshResultVersions({ ...data, key: data.key })
      if (!versions.ok && this.session?.isReady) return { accepted: false, keepCovering: false }
    }
    const required = data.key ? this.session?.requiredLightForSection(data.key) : undefined
    const [x, , z] = (data.key ?? '').split(',').map(Number)
    const accepted = shouldAcceptMeshGeometry(
      {
        worldGeneration: data.worldGeneration,
        lightPublicationVersion: data.lightPublicationVersion,
        topologyRevision: data.topologyRevision,
        sessionEpoch: data.sessionEpoch,
        columnIncarnation: data.columnIncarnation,
        hadErrors: data.hadErrors ?? data.geometry?.hadErrors,
        meshMode: data.meshMode
      },
      this.session?.gate ?? { acceptedGeneration: 1, lastVersion: 0 },
      required,
      {
        ownerManaged,
        sessionEpoch: this.fence.sessionEpoch,
        columnIncarnation: Number.isFinite(x) && Number.isFinite(z) ? this.columnIncarnationFor(`${x},${z}`) : undefined
      }
    )
    return {
      accepted,
      keepCovering: accepted && isOwnerGeometryLightStale(data, required)
    }
  }

  acknowledgeAcceptedTopology(data: { key?: string; topologyRevision?: number }) {
    if (!data.key || data.topologyRevision == null) return
    const pending = this.pendingTopologyBySection.get(data.key)
    if (pending != null && data.topologyRevision >= pending) {
      this.pendingTopologyBySection.delete(data.key)
    }
  }

  maybeDispatchCoveringRemesh(key: string, required?: MeshSectionLightRequirement | null) {
    required ??= this.session?.requiredLightForSection(key)
    if (required == null) return
    const outstandingCount = this.host.sectionsWaiting.get(key) ?? 0
    const pending = this.pendingCoveringBySection.get(key)
    if (
      !shouldDispatchCoveringRemesh({
        required,
        outstandingCount,
        pendingCoveringVersion: pending?.requiredVersion,
        pendingCoveringGeneration: pending?.worldGeneration
      })
    ) {
      return
    }
    const replacement = coveringReplacementForReject({ accepted: false, required })
    const [x, y, z] = key.split(',').map(Number)
    if (replacement && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) && this.host.loadedChunks[`${x},${z}`]) {
      this.pendingCoveringBySection.set(key, {
        requiredVersion: replacement.lightPublicationVersion,
        worldGeneration: replacement.worldGeneration,
        topologyRevision: required.topologyRevision
      })
      this.host.sectionDirtyLightMeta.set(key, replacement)
      this.nextDirtyLightMeta = replacement
      this.nextDirtyUrgent = this.sectionTouchesInteractiveWork(key)
      try {
        this.host.dispatchDirtyImmediate(new Vec3(x, y, z), true, true)
      } finally {
        this.nextDirtyLightMeta = {}
        this.nextDirtyUrgent = false
      }
    }
  }

  noteRejectedOwnerGeometry(key: string, required: MeshSectionLightRequirement | null | undefined, opts?: { expectLaterFinished?: boolean }) {
    if (opts?.expectLaterFinished !== false) {
      this.rejectedFinishedBySection.set(key, (this.rejectedFinishedBySection.get(key) ?? 0) + 1)
      return
    }
    this.maybeDispatchCoveringRemesh(key, required)
  }

  /** Returns true when the geometry must be dropped. */
  rejectStaleOwnerGeometry(data: MesherMainEvent & OwnerGeometryEvent): boolean {
    if (data.type !== 'geometry') return false
    const decision = this.evaluateOwnerGeometry(data)
    if (isClientLightProbeSection(data.key)) {
      console.log('[lightProbe:mesh]', {
        time: Date.now(),
        key: data.key,
        lightPublicationVersion: data.lightPublicationVersion,
        required: this.session?.requiredLightForSection(data.key),
        accepted: decision.accepted,
        keepCovering: decision.keepCovering
      })
    }
    if (!decision.accepted) {
      this.noteRejectedOwnerGeometry(data.key, this.session?.requiredLightForSection(data.key), {
        expectLaterFinished: true
      })
      return true
    }
    this.acknowledgeAcceptedTopology(data)
    if (decision.keepCovering) this.maybeDispatchCoveringRemesh(data.key)
    else this.releaseInteractiveSectionIfLightCommitted(data)
    return false
  }

  /** `sectionFinished` arrived: true when it answers a geometry we rejected (so the section is not finished yet). */
  consumeRejectedFinish(key: string): boolean {
    const rejectedFinishes = this.rejectedFinishedBySection.get(key) ?? 0
    if (rejectedFinishes <= 0) return false
    const nextRejected = rejectedFinishes - 1
    if (nextRejected === 0) this.rejectedFinishedBySection.delete(key)
    else this.rejectedFinishedBySection.set(key, nextRejected)
    return true
  }

  forgetCovering(key: string) {
    this.pendingCoveringBySection.delete(key)
  }

  // --- dirty dispatch ----------------------------------------------------------------------------------------

  /** Version stamps for a dirty message of section `key`; the caller spreads them into the message. */
  describeDirty(pos: Vec3, key: string) {
    const lightMeta = this.nextDirtyLightMeta.lightPublicationVersion != null ? this.nextDirtyLightMeta : this.host.sectionDirtyLightMeta.get(key)
    const ownerManaged = this.session != null || this.fence.rejectStaleOwnerMeshes
    const requestId = ownerManaged || isClientLightTraceEnabled() ? nextClientLightRequestId() : undefined
    const traceIds = isClientLightTraceEnabled() ? { ...currentClientLightTraceIds(), requestId } : undefined
    const ownerVersions = ownerManaged
      ? {
          sessionEpoch: this.fence.sessionEpoch,
          columnIncarnation: this.columnIncarnationFor(`${Math.floor(pos.x / CHUNK_SIZE) * CHUNK_SIZE},${Math.floor(pos.z / CHUNK_SIZE) * CHUNK_SIZE}`),
          requestId,
          topologyRevision: this.topologyRevisionBySection.get(key) ?? INITIAL_TOPOLOGY_REVISION,
          neighborTopologyRevisions: this.snapshotNeighborTopology(key)
        }
      : {}
    return { lightMeta, ownerVersions, traceIds }
  }

  /** Runs `fn` with the urgent flag temporarily set from a deferred dispatch. */
  withDirtyUrgency(urgent: boolean, fn: () => void) {
    const previousUrgent = this.nextDirtyUrgent
    this.nextDirtyUrgent = urgent
    try {
      fn()
    } finally {
      this.nextDirtyUrgent = previousUrgent
    }
  }

  // --- block edits and columns -------------------------------------------------------------------------------

  /** A block changed: forward it to the owner, bump topology (also of touched neighbours) and track the player edit. */
  noteBlockChange(pos: Vec3, stateId: number | undefined, neighborUpdates: boolean) {
    const sectionHeight = this.host.getSectionHeight()
    if (stateId !== undefined) {
      this.session?.onBlockChange(pos.x, pos.y, pos.z, stateId)
    }
    this.bumpTopologyRevision(pos)
    if (neighborUpdates) {
      if ((pos.x & 15) === 0) this.bumpTopologyRevision(pos.offset(-CHUNK_SIZE, 0, 0))
      if ((pos.x & 15) === 15) this.bumpTopologyRevision(pos.offset(CHUNK_SIZE, 0, 0))
      if ((pos.y & (sectionHeight - 1)) === 0) this.bumpTopologyRevision(pos.offset(0, -sectionHeight, 0))
      if ((pos.y & (sectionHeight - 1)) === sectionHeight - 1) this.bumpTopologyRevision(pos.offset(0, sectionHeight, 0))
      if ((pos.z & 15) === 0) this.bumpTopologyRevision(pos.offset(0, 0, -CHUNK_SIZE))
      if ((pos.z & 15) === 15) this.bumpTopologyRevision(pos.offset(0, 0, CHUNK_SIZE))
    }
    if (isClientLightTraceEnabled()) {
      recordClientLightTrace({
        phase: 'blockChange',
        editSeq: nextClientLightEditSeq(),
        sectionKey: this.sectionKeyFor(pos.x, pos.y, pos.z),
        blockVersion: stateId
      })
    }
    this.noteInteractiveSection(pos)
  }

  onColumnRemoved(x: number, z: number, opts?: { preserveClientLight?: boolean }) {
    if (opts?.preserveClientLight && this.session?.isReady) {
      this.session.onGeometryReload(x, z)
    } else {
      this.session?.onUnload(x, z)
    }
    const columnKey = `${x},${z}`
    this.columnIncarnationByColumn.set(columnKey, this.columnIncarnationFor(columnKey) + 1)
    for (const map of [this.topologyRevisionBySection, this.pendingCoveringBySection, this.pendingTopologyBySection, this.rejectedFinishedBySection]) {
      for (const key of [...map.keys()]) {
        if (columnMatches(key, x, z)) map.delete(key)
      }
    }
  }

  forgetInteractiveSection(key: string) {
    this.interactiveSections.delete(key)
  }

  // --- internals ---------------------------------------------------------------------------------------------

  private sectionKeyFor(x: number, y: number, z: number): string {
    const sectionHeight = this.host.getSectionHeight()
    return `${Math.floor(x / CHUNK_SIZE) * CHUNK_SIZE},${Math.floor(y / sectionHeight) * sectionHeight},${Math.floor(z / CHUNK_SIZE) * CHUNK_SIZE}`
  }

  private noteInteractiveSection(pos: Vec3) {
    const key = this.sectionKeyFor(pos.x, pos.y, pos.z)
    const requiredVersion = this.session?.requiredLightForSection(key)?.requiredVersion ?? 0
    const gateVersion = this.session?.gate.lastVersion ?? 0
    const prev = this.interactiveSections.get(key)
    this.interactiveSections.set(key, {
      lightVersionAtEdit: Math.max(prev?.lightVersionAtEdit ?? 0, requiredVersion, gateVersion),
      editGeneration: this.session?.notePlayerEdit() ?? 0,
      coveringVersion: undefined
    })
  }

  sectionTouchesInteractiveWork(key: string): boolean {
    if (this.interactiveSections.has(key)) return true
    const [x, y, z] = key.split(',').map(Number)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false
    const sectionHeight = this.host.getSectionHeight()
    for (let dx = -16; dx <= 16; dx += 16) {
      for (let dy = -sectionHeight; dy <= sectionHeight; dy += sectionHeight) {
        for (let dz = -16; dz <= 16; dz += 16) {
          if (this.interactiveSections.has(`${x + dx},${y + dy},${z + dz}`)) return true
        }
      }
    }
    return false
  }

  private noteCoveringPublication(version: number, dirtyKeys: Iterable<string>) {
    const dirty = new Set(dirtyKeys)
    for (const [key, edit] of this.interactiveSections) {
      if (!dirty.has(key) || version <= edit.lightVersionAtEdit) continue
      this.interactiveSections.set(key, {
        lightVersionAtEdit: edit.lightVersionAtEdit,
        editGeneration: edit.editGeneration,
        coveringVersion: Math.max(edit.coveringVersion ?? 0, version)
      })
    }
  }

  private releaseInteractiveEditsWithoutCoveringPublication(settledEditGeneration: number) {
    for (const [key, edit] of this.interactiveSections) {
      if (edit.coveringVersion == null && edit.editGeneration <= settledEditGeneration) this.interactiveSections.delete(key)
    }
  }

  private releaseInteractiveSectionIfLightCommitted(data: { key?: string; lightPublicationVersion?: number }) {
    if (!data.key || data.lightPublicationVersion == null) return
    const edit = this.interactiveSections.get(data.key)
    if (edit?.coveringVersion == null || data.lightPublicationVersion < edit.coveringVersion) return
    this.interactiveSections.delete(data.key)
  }

  private bumpTopologyRevision(pos: Vec3) {
    const key = this.sectionKeyFor(pos.x, pos.y, pos.z)
    const next = nextTopologyRevision(this.topologyRevisionBySection.get(key))
    this.topologyRevisionBySection.set(key, next)
    if (this.session != null) {
      this.pendingTopologyBySection.set(key, next)
    }
  }

  private snapshotNeighborTopology(key: string): Array<{ key: string; topologyRevision: number }> {
    const [x, y, z] = key.split(',').map(Number)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return []
    const sectionHeight = this.host.getSectionHeight()
    const out: Array<{ key: string; topologyRevision: number }> = []
    for (let dx = -16; dx <= 16; dx += 16) {
      for (let dy = -sectionHeight; dy <= sectionHeight; dy += sectionHeight) {
        for (let dz = -16; dz <= 16; dz += 16) {
          const neighborKey = `${x + dx},${y + dy},${z + dz}`
          const topologyRevision = this.topologyRevisionBySection.get(neighborKey)
          if (topologyRevision != null) out.push({ key: neighborKey, topologyRevision })
        }
      }
    }
    return out
  }
}
