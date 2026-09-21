import { describe, expect, test } from 'vitest'
import {
  INITIAL_TOPOLOGY_REVISION,
  nextTopologyRevision,
  shouldAcceptVersionedMesh,
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
    expect(shouldAcceptVersionedMesh({ hadErrors: true, worldGeneration: 1, lightPublicationVersion: 3, topologyRevision: 5 }, required, { ownerManaged: true })).toBe(
      false
    )
    expect(
      shouldAcceptVersionedMesh({ hadErrors: false, worldGeneration: 1, lightPublicationVersion: 3, topologyRevision: 5 }, required, {
        ownerManaged: true
      })
    ).toBe(true)
  })

  test('stale topology with fresh light is rejected', () => {
    expect(
      shouldAcceptVersionedMesh(
        { worldGeneration: 1, lightPublicationVersion: 3, topologyRevision: 4, sessionEpoch: 1 },
        required,
        { ownerManaged: true, sessionEpoch: 1 }
      )
    ).toBe(false)
  })

  test('fresh topology with stale light is accepted so the block can install this frame', () => {
    expect(
      shouldAcceptVersionedMesh(
        { worldGeneration: 1, lightPublicationVersion: 2, topologyRevision: 5, sessionEpoch: 1 },
        required,
        { ownerManaged: true, sessionEpoch: 1 }
      )
    ).toBe(true)
  })

  test('required == null accepts versioned geometry', () => {
    expect(
      shouldAcceptVersionedMesh(
        { worldGeneration: 1, lightPublicationVersion: 1, topologyRevision: 1, sessionEpoch: 1 },
        null,
        { ownerManaged: true, sessionEpoch: 1 }
      )
    ).toBe(true)
  })

  test('legacyBootstrap with a required revision is still rejected', () => {
    expect(shouldAcceptVersionedMesh({ meshMode: 'legacyBootstrap', topologyRevision: 5 }, required, { ownerManaged: true })).toBe(false)
  })

  test('legacyBootstrap without required is accepted', () => {
    expect(shouldAcceptVersionedMesh({ meshMode: 'legacyBootstrap' }, null, { ownerManaged: true })).toBe(true)
  })

  test('legacyBootstrap still has to match the column life', () => {
    expect(
      shouldAcceptVersionedMesh(
        { meshMode: 'legacyBootstrap', sessionEpoch: 1, columnIncarnation: 1 },
        null,
        { ownerManaged: true, sessionEpoch: 2, columnIncarnation: 2 }
      )
    ).toBe(false)
  })

  test('legacyBootstrap with a proven neighbor light version covers the requirement', () => {
    expect(
      shouldAcceptVersionedMesh(
        { meshMode: 'legacyBootstrap', worldGeneration: 1, lightPublicationVersion: 10, sessionEpoch: 1, columnIncarnation: 1 },
        { requiredVersion: 10, worldGeneration: 1 },
        { ownerManaged: true, sessionEpoch: 1, columnIncarnation: 1 }
      )
    ).toBe(true)
    expect(
      shouldAcceptVersionedMesh(
        { meshMode: 'legacyBootstrap', worldGeneration: 1, sessionEpoch: 1, columnIncarnation: 1 },
        { requiredVersion: 10, worldGeneration: 1 },
        { ownerManaged: true, sessionEpoch: 1, columnIncarnation: 1 }
      )
    ).toBe(false)
  })

  test('owner mesh with an older own-column light version stays rejected', () => {
    expect(
      shouldAcceptVersionedMesh(
        { meshMode: 'owner', worldGeneration: 1, lightPublicationVersion: 9, sessionEpoch: 1, columnIncarnation: 1 },
        { requiredVersion: 10, worldGeneration: 1 },
        { ownerManaged: true, sessionEpoch: 1, columnIncarnation: 1 }
      )
    ).toBe(false)
  })

  test('without topology on the requirement, stale light still rejects (old gate)', () => {
    expect(
      shouldAcceptVersionedMesh(
        { worldGeneration: 1, lightPublicationVersion: 2, topologyRevision: 5, sessionEpoch: 1 },
        { requiredVersion: 3, worldGeneration: 1 },
        { ownerManaged: true, sessionEpoch: 1 }
      )
    ).toBe(false)
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

  test('the initial revision is not the first edit', () => {
    expect(INITIAL_TOPOLOGY_REVISION).toBe(0)
    expect(nextTopologyRevision(undefined)).not.toBe(INITIAL_TOPOLOGY_REVISION)
    expect(nextTopologyRevision(INITIAL_TOPOLOGY_REVISION)).toBe(1)
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
