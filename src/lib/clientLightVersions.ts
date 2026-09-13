/**
 * P-02: explicit mesh versions, covering coalesce, and payload validation.
 * Metadata only — never copies raw meshes or light arrays into logs.
 */

export const OWNER_STATES_PER_SECTION = 4096
export const OWNER_PACKED_LIGHT_BYTES = 2048

export type MeshGeometryMode = 'owner' | 'legacyBootstrap'

export type MeshResultVersions = {
  sessionEpoch: number
  columnIncarnation: number
  requestId: number
  topologyRevision: number
  lightPublicationVersion: number
  worldGeneration: number
  neighborTopologyRevisions: Array<{ key: string; topologyRevision: number }>
  meshMode: MeshGeometryMode
}

export type MeshSectionLightRequirement = {
  requiredVersion: number
  worldGeneration: number
  topologyRevision?: number
}

export function isUnversionedMesh(mesh: {
  worldGeneration?: number
  lightPublicationVersion?: number
  topologyRevision?: number
  sessionEpoch?: number
}): boolean {
  return (
    mesh.worldGeneration == null && mesh.lightPublicationVersion == null && mesh.topologyRevision == null && mesh.sessionEpoch == null
  )
}

export function shouldAcceptVersionedMesh(
  mesh: {
    worldGeneration?: number
    lightPublicationVersion?: number
    topologyRevision?: number
    sessionEpoch?: number
    columnIncarnation?: number
    hadErrors?: boolean
    meshMode?: MeshGeometryMode
  },
  required: MeshSectionLightRequirement | null | undefined,
  opts: { ownerManaged: boolean; sessionEpoch?: number; columnIncarnation?: number }
): boolean {
  if (mesh.hadErrors) return false
  if (opts.ownerManaged) {
    if (mesh.meshMode === 'legacyBootstrap') return required == null
    if (isUnversionedMesh(mesh)) return false
    if (opts.sessionEpoch != null && mesh.sessionEpoch != null && mesh.sessionEpoch !== opts.sessionEpoch) return false
    if (opts.columnIncarnation != null && mesh.columnIncarnation != null && mesh.columnIncarnation !== opts.columnIncarnation) {
      return false
    }
  } else if (isUnversionedMesh(mesh)) {
    return true
  }
  if (required == null) return true
  if (mesh.worldGeneration != null && mesh.worldGeneration !== required.worldGeneration) return false
  if (mesh.lightPublicationVersion != null && mesh.lightPublicationVersion < required.requiredVersion) return false
  if (required.topologyRevision != null && mesh.topologyRevision != null && mesh.topologyRevision < required.topologyRevision) {
    return false
  }
  return true
}

export function shouldCommitPendingGeometry(
  mesh: Parameters<typeof shouldAcceptVersionedMesh>[0] & { hadErrors?: boolean },
  required: MeshSectionLightRequirement | null | undefined,
  opts: { ownerManaged: boolean; sessionEpoch?: number; columnIncarnation?: number }
): 'commit' | 'keep-displayed' | 'commit-empty' {
  if (mesh.hadErrors) return 'keep-displayed'
  if (!shouldAcceptVersionedMesh(mesh, required, opts)) return 'keep-displayed'
  return 'commit'
}

export function shouldDispatchCoveringRemesh(opts: {
  required: MeshSectionLightRequirement
  outstandingCount: number
  pendingCoveringVersion?: number
  pendingCoveringGeneration?: number
}): boolean {
  if (opts.outstandingCount <= 0) return true
  if (opts.pendingCoveringGeneration !== opts.required.worldGeneration) return true
  if ((opts.pendingCoveringVersion ?? -1) < opts.required.requiredVersion) return true
  return false
}

export function nextTopologyRevision(current: number | undefined): number {
  return (current ?? 0) + 1
}

export function snapshotMeshVersions(input: {
  sessionEpoch: number
  columnIncarnation: number
  requestId: number
  topologyRevision: number
  lightPublicationVersion: number
  worldGeneration: number
  neighborTopologyRevisions: Array<{ key: string; topologyRevision: number }>
  meshMode?: MeshGeometryMode
}): MeshResultVersions {
  return {
    sessionEpoch: input.sessionEpoch,
    columnIncarnation: input.columnIncarnation,
    requestId: input.requestId,
    topologyRevision: input.topologyRevision,
    lightPublicationVersion: input.lightPublicationVersion,
    worldGeneration: input.worldGeneration,
    neighborTopologyRevisions: input.neighborTopologyRevisions.map(entry => ({
      key: entry.key,
      topologyRevision: entry.topologyRevision
    })),
    meshMode: input.meshMode ?? 'owner'
  }
}

export function isSafeIntegerId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isSafeInteger(value) && value >= 0
}

export function isSafeCoord(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isSafeInteger(value)
}

export function validateSectionKey(key: unknown): boolean {
  if (typeof key !== 'string') return false
  const parts = key.split(',')
  if (parts.length !== 3) return false
  return parts.every(part => {
    const n = Number(part)
    return Number.isInteger(n) && Number.isFinite(n)
  })
}

export function validateOwnerPackedSection(section: {
  sx?: unknown
  sy?: unknown
  sz?: unknown
  blockLight?: unknown
  skyLight?: unknown
  states?: unknown
}): { ok: true } | { ok: false; reason: string } {
  if (!isSafeCoord(section.sx)) return { ok: false, reason: 'sx' }
  if (!isSafeCoord(section.sy)) return { ok: false, reason: 'sy' }
  if (!isSafeCoord(section.sz)) return { ok: false, reason: 'sz' }
  if (section.blockLight != null) {
    if (!(section.blockLight instanceof Uint8Array) || section.blockLight.length !== OWNER_PACKED_LIGHT_BYTES) {
      return { ok: false, reason: 'blockLight' }
    }
  }
  if (section.skyLight != null) {
    if (!(section.skyLight instanceof Uint8Array) || section.skyLight.length !== OWNER_PACKED_LIGHT_BYTES) {
      return { ok: false, reason: 'skyLight' }
    }
  }
  if (section.states != null) {
    if (!(section.states instanceof Uint16Array) || section.states.length !== OWNER_STATES_PER_SECTION) {
      return { ok: false, reason: 'states' }
    }
  }
  return { ok: true }
}

export function validateMeshResultVersions(data: {
  sessionEpoch?: unknown
  columnIncarnation?: unknown
  requestId?: unknown
  topologyRevision?: unknown
  lightPublicationVersion?: unknown
  worldGeneration?: unknown
  key?: unknown
}): { ok: true } | { ok: false; reason: string } {
  if (data.key != null && !validateSectionKey(data.key)) return { ok: false, reason: 'key' }
  for (const field of ['sessionEpoch', 'columnIncarnation', 'requestId', 'topologyRevision', 'lightPublicationVersion', 'worldGeneration'] as const) {
    if (data[field] == null) continue
    if (!isSafeIntegerId(data[field])) return { ok: false, reason: field }
  }
  return { ok: true }
}

export function validateOwnerPublicationMessage(data: {
  worldGeneration?: unknown
  publicationVersion?: unknown
  sections?: unknown
}): { ok: true } | { ok: false; reason: string } {
  if (!isSafeIntegerId(data.worldGeneration)) return { ok: false, reason: 'worldGeneration' }
  if (!isSafeIntegerId(data.publicationVersion)) return { ok: false, reason: 'publicationVersion' }
  if (!Array.isArray(data.sections)) return { ok: false, reason: 'sections' }
  for (const section of data.sections) {
    const checked = validateOwnerPackedSection(section ?? {})
    if (!checked.ok) return checked
  }
  return { ok: true }
}
