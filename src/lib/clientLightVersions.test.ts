import { describe, expect, test } from 'vitest'
import {
  nextTopologyRevision,
  shouldAcceptVersionedMesh,
  shouldCommitPendingGeometry,
  shouldDispatchCoveringRemesh,
  snapshotMeshVersions,
  validateMeshResultVersions,
  validateOwnerPackedSection,
  validateOwnerPublicationMessage
} from './clientLightVersions'

describe('shouldAcceptVersionedMesh', () => {
  const required = { requiredVersion: 3, worldGeneration: 1, topologyRevision: 5 }

  test('legacy bootstrap still accepts unversioned geometry', () => {
    expect(shouldAcceptVersionedMesh({}, required, { ownerManaged: false })).toBe(true)
  })

  test('owner-managed path rejects unversioned geometry as current', () => {
    expect(shouldAcceptVersionedMesh({}, required, { ownerManaged: true })).toBe(false)
    expect(shouldAcceptVersionedMesh({ meshMode: 'legacyBootstrap' }, required, { ownerManaged: true })).toBe(false)
  })

  test('fast A→B→C drops B when C is required', () => {
    expect(
      shouldAcceptVersionedMesh(
        { worldGeneration: 1, lightPublicationVersion: 2, topologyRevision: 4, sessionEpoch: 1 },
        required,
        { ownerManaged: true, sessionEpoch: 1 }
      )
    ).toBe(false)
    expect(
      shouldAcceptVersionedMesh(
        { worldGeneration: 1, lightPublicationVersion: 3, topologyRevision: 5, sessionEpoch: 1 },
        required,
        { ownerManaged: true, sessionEpoch: 1 }
      )
    ).toBe(true)
  })

  test('late reply from a previous incarnation is dropped', () => {
    expect(
      shouldAcceptVersionedMesh(
        { worldGeneration: 1, lightPublicationVersion: 3, topologyRevision: 5, sessionEpoch: 1, columnIncarnation: 1 },
        required,
        { ownerManaged: true, sessionEpoch: 1, columnIncarnation: 2 }
      )
    ).toBe(false)
  })

  test('hadErrors is never a successful empty commit', () => {
    expect(shouldCommitPendingGeometry({ hadErrors: true, worldGeneration: 1, lightPublicationVersion: 3 }, required, { ownerManaged: true })).toBe(
      'keep-displayed'
    )
    expect(
      shouldCommitPendingGeometry({ hadErrors: false, worldGeneration: 1, lightPublicationVersion: 3, topologyRevision: 5 }, required, {
        ownerManaged: true
      })
    ).toBe('commit')
  })
})

describe('shouldDispatchCoveringRemesh', () => {
  const required = { requiredVersion: 4, worldGeneration: 1 }

  test('dispatches when nothing is outstanding', () => {
    expect(shouldDispatchCoveringRemesh({ required, outstandingCount: 0 })).toBe(true)
  })

  test('does not add another remesh when pending already covers the requirement', () => {
    expect(
      shouldDispatchCoveringRemesh({
        required,
        outstandingCount: 1,
        pendingCoveringVersion: 4,
        pendingCoveringGeneration: 1
      })
    ).toBe(false)
  })

  test('dispatches when the outstanding remesh is behind the new requirement', () => {
    expect(
      shouldDispatchCoveringRemesh({
        required,
        outstandingCount: 2,
        pendingCoveringVersion: 3,
        pendingCoveringGeneration: 1
      })
    ).toBe(true)
  })
})

describe('snapshotMeshVersions', () => {
  test('freezes neighbor revisions with the task snapshot, not a later live map', () => {
    const neighbors = [{ key: '16,64,0', topologyRevision: 2 }]
    const snap = snapshotMeshVersions({
      sessionEpoch: 1,
      columnIncarnation: 3,
      requestId: 9,
      topologyRevision: 4,
      lightPublicationVersion: 7,
      worldGeneration: 1,
      neighborTopologyRevisions: neighbors
    })
    neighbors[0]!.topologyRevision = 99
    expect(snap.neighborTopologyRevisions[0]!.topologyRevision).toBe(2)
    expect(snap.meshMode).toBe('owner')
  })
})

describe('nextTopologyRevision', () => {
  test('increments from zero', () => {
    expect(nextTopologyRevision(undefined)).toBe(1)
    expect(nextTopologyRevision(1)).toBe(2)
  })
})

describe('payload validation', () => {
  test('rejects NaN and non-integer revision ids', () => {
    expect(validateMeshResultVersions({ sessionEpoch: 1.5 })).toEqual({ ok: false, reason: 'sessionEpoch' })
    expect(validateMeshResultVersions({ requestId: -1 })).toEqual({ ok: false, reason: 'requestId' })
    expect(validateMeshResultVersions({ key: '0,64,0', requestId: 3 })).toEqual({ ok: true })
  })

  test('rejects packed light that is not 2048 bytes per channel', () => {
    expect(
      validateOwnerPackedSection({
        sx: 0,
        sy: 64,
        sz: 0,
        blockLight: new Uint8Array(16)
      })
    ).toEqual({ ok: false, reason: 'blockLight' })
    expect(
      validateOwnerPackedSection({
        sx: -16,
        sy: 64,
        sz: 32,
        blockLight: new Uint8Array(2048)
      })
    ).toEqual({ ok: true })
  })

  test('rejects a foreign publication with bad section payload', () => {
    expect(
      validateOwnerPublicationMessage({
        worldGeneration: 1,
        publicationVersion: 2,
        sections: [{ sx: 0, sy: 64, sz: 0, blockLight: new Uint8Array(8) }]
      })
    ).toEqual({ ok: false, reason: 'blockLight' })
  })
})
