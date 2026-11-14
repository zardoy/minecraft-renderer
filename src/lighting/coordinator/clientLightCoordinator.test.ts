import { describe, expect, test, vi } from 'vitest'
import { Vec3 } from 'vec3'
import { defaultWorldRendererConfig } from '../../graphicsBackend/config'
import { ClientLightCoordinator, type ClientLightHost } from './clientLightCoordinator'

function createHost(overrides: Partial<ClientLightHost> = {}) {
  const dispatched: Array<{ pos: Vec3; value: boolean; useChangeWorker: boolean }> = []
  const host: ClientLightHost = {
    version: '1.17.1',
    workers: [],
    rendererLightCache: {} as ClientLightHost['rendererLightCache'],
    worldRendererConfig: { ...defaultWorldRendererConfig },
    worldSizeParams: { minY: 0, worldHeight: 256 },
    playerStateReactive: {} as ClientLightHost['playerStateReactive'],
    sectionsWaiting: new Map(),
    loadedChunks: {},
    sectionDirtyLightMeta: new Map(),
    getSectionHeight: () => 16,
    getWorkerNumber: () => 0,
    setSectionDirty: vi.fn(),
    dispatchDirtyImmediate: (pos, value, useChangeWorker) => dispatched.push({ pos, value, useChangeWorker }),
    createLightOwnerWorker: vi.fn(),
    ...overrides
  }
  return { host, dispatched, coordinator: new ClientLightCoordinator(host) }
}

describe('ClientLightCoordinator', () => {
  test('stays inert and accepts geometry while the owner is disabled', () => {
    const { coordinator } = createHost()
    coordinator.maybeSpawn()
    expect(coordinator.isSessionLive()).toBe(false)
    expect(coordinator.hasOwner()).toBe(false)
    expect(coordinator.evaluateOwnerGeometry({ type: 'geometry', key: '0,64,0' })).toEqual({ accepted: true, keepCovering: false })
  })

  test('explains why the owner did not start when the version gate refuses it', () => {
    const { coordinator } = createHost({ version: '1.16.5', worldRendererConfig: { ...defaultWorldRendererConfig, enableClientLightOwner: true } })
    coordinator.maybeSpawn()
    expect(coordinator.isSessionLive()).toBe(false)
    expect(coordinator.getFailureReason()).toContain('1.17 or newer')
  })

  test('a block change bumps the touched section and an edge neighbour, and tracks the edit', () => {
    const { coordinator } = createHost()
    coordinator.noteBlockChange(new Vec3(0, 64, 5), 1, true)
    expect(coordinator.topologyRevisionBySection.has('0,64,0')).toBe(true)
    expect(coordinator.topologyRevisionBySection.has('-16,64,0')).toBe(true)
    expect(coordinator.topologyRevisionBySection.has('16,64,0')).toBe(false)
    expect(coordinator.interactiveSections.has('0,64,0')).toBe(true)
    // neighbours of an interactive section count as interactive work too
    expect(coordinator.sectionTouchesInteractiveWork('16,64,0')).toBe(true)
    expect(coordinator.sectionTouchesInteractiveWork('48,64,0')).toBe(false)
  })

  test('neighbour topology is not bumped when neighbour updates are off', () => {
    const { coordinator } = createHost()
    coordinator.noteBlockChange(new Vec3(0, 64, 5), 1, false)
    expect([...coordinator.topologyRevisionBySection.keys()]).toEqual(['0,64,0'])
  })

  test('removing a column bumps its incarnation and forgets only that column', () => {
    const { coordinator } = createHost()
    coordinator.topologyRevisionBySection.set('0,64,0', 3)
    coordinator.topologyRevisionBySection.set('16,64,0', 3)
    coordinator.pendingCoveringBySection.set('0,32,0', { requiredVersion: 1, worldGeneration: 1 })
    coordinator.pendingTopologyBySection.set('0,32,0', 2)
    coordinator.rejectedFinishedBySection.set('0,32,0', 1)
    const before = coordinator.columnIncarnationFor('0,0')

    coordinator.onColumnRemoved(0, 0)

    expect(coordinator.columnIncarnationFor('0,0')).toBe(before + 1)
    expect(coordinator.columnIncarnationFor('16,0')).toBe(1)
    expect([...coordinator.topologyRevisionBySection.keys()]).toEqual(['16,64,0'])
    expect(coordinator.pendingCoveringBySection.size).toBe(0)
    expect(coordinator.pendingTopologyBySection.size).toBe(0)
    expect(coordinator.rejectedFinishedBySection.size).toBe(0)
  })

  test('rejected finishes are consumed one by one', () => {
    const { coordinator } = createHost()
    coordinator.noteRejectedOwnerGeometry('0,64,0', undefined, { expectLaterFinished: true })
    coordinator.noteRejectedOwnerGeometry('0,64,0', undefined, { expectLaterFinished: true })
    expect(coordinator.consumeRejectedFinish('0,64,0')).toBe(true)
    expect(coordinator.consumeRejectedFinish('0,64,0')).toBe(true)
    expect(coordinator.consumeRejectedFinish('0,64,0')).toBe(false)
  })

  test('dirty stamps carry no owner versions while the owner is off, and urgency is restored', () => {
    const { coordinator } = createHost()
    const { lightMeta, ownerVersions, traceIds } = coordinator.describeDirty(new Vec3(0, 64, 0), '0,64,0')
    expect(lightMeta).toBeUndefined()
    expect(ownerVersions).toEqual({})
    expect(traceIds).toBeUndefined()

    coordinator.nextDirtyUrgent = true
    coordinator.withDirtyUrgency(false, () => expect(coordinator.nextDirtyUrgent).toBe(false))
    expect(coordinator.nextDirtyUrgent).toBe(true)
  })
})
