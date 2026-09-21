import { describe, expect, it } from 'vitest'
import { faceNeighborKeys, pendingSectionGroups, selectReadySectionFlushes, selectReadySectionUpdates } from '../pendingSectionFlush'

const SECTION_HEIGHT = 16
const MAX_BUFFER_MS = 500

type Scene = {
  pending: Map<string, number>
  outstanding: Set<string>
  visible: Set<string>
}

function select(scene: Scene, now: number) {
  return selectReadySectionUpdates({
    pendingKeys: scene.pending.keys(),
    startedAt: key => scene.pending.get(key),
    now,
    maxBufferMs: MAX_BUFFER_MS,
    sectionHeight: SECTION_HEIGHT,
    isOutstanding: key => scene.outstanding.has(key),
    hasSectionObject: key => scene.visible.has(key)
  })
}

/**
 * The per-key policy this module replaced (worldRendererThree before the group
 * flush): each key waited out its OWN deadline and was released on its own.
 * Kept here so the regression it caused stays pinned by a test.
 */
function selectPerKeyLegacy(scene: Scene, now: number) {
  const ready: string[] = []
  for (const key of scene.pending.keys()) {
    const startedAt = scene.pending.get(key) ?? now
    if (now - startedAt < MAX_BUFFER_MS) {
      const busy = faceNeighborKeys(key, SECTION_HEIGHT).some(
        neighbor => scene.outstanding.has(neighbor) && !scene.pending.has(neighbor) && scene.visible.has(neighbor)
      )
      if (busy) continue
    }
    ready.push(key)
  }
  return ready
}

describe('pendingSectionGroups', () => {
  it('splits buffered sections into face-connected components', () => {
    const groups = pendingSectionGroups(['0,64,0', '0,80,0', '160,64,160'], SECTION_HEIGHT)
    expect(groups).toHaveLength(2)
    expect(groups.find(g => g.length === 2)?.sort()).toEqual(['0,64,0', '0,80,0'])
    expect(groups.find(g => g.length === 1)).toEqual(['160,64,160'])
  })
})

describe('selectReadySectionUpdates', () => {
  it('holds a section while a visible face neighbour is still being re-meshed', () => {
    const scene: Scene = {
      pending: new Map([['0,64,0', 1000]]),
      outstanding: new Set(['16,64,0']),
      visible: new Set(['16,64,0'])
    }
    expect(select(scene, 1050)).toEqual([])
  })

  it('flushes as soon as every neighbour of the group has arrived, without waiting the deadline', () => {
    const scene: Scene = {
      pending: new Map([
        ['0,64,0', 1000],
        ['16,64,0', 1040]
      ]),
      outstanding: new Set(),
      visible: new Set(['0,64,0', '16,64,0'])
    }
    expect(select(scene, 1050).sort()).toEqual(['0,64,0', '16,64,0'])
  })

  it('does not wait on an air neighbour that has no geometry on screen', () => {
    const scene: Scene = {
      pending: new Map([['0,64,0', 1000]]),
      outstanding: new Set(['0,80,0']),
      visible: new Set(['0,64,0'])
    }
    expect(select(scene, 1010)).toEqual(['0,64,0'])
  })

  // The sky-flash regression: the dug section and its face neighbours are
  // buffered at staggered times (they come back on different worker ticks).
  // Releasing the earliest one alone shows the neighbour's still-culled faces
  // as a hole, so the whole group must go out in the same frame.
  it('releases a staggered group in one batch when the deadline expires', () => {
    const scene: Scene = {
      pending: new Map([
        ['0,64,0', 1000],
        ['16,64,0', 1120],
        ['0,80,0', 1180]
      ]),
      outstanding: new Set(['32,64,0']),
      visible: new Set(['0,64,0', '16,64,0', '0,80,0', '32,64,0'])
    }
    expect(select(scene, 1500).sort()).toEqual(['0,64,0', '0,80,0', '16,64,0'])
    // The legacy policy installs 0,64,0 while 16,64,0 keeps the geometry it was
    // meshed with before the edit — the faces between them stay culled on both
    // sides for a frame, which is the hole seen as a sky flash.
    expect(selectPerKeyLegacy(scene, 1500)).not.toContain('16,64,0')
    expect(selectPerKeyLegacy(scene, 1500)).toContain('0,64,0')
  })

  it('measures the deadline from the oldest member so a group cannot be starved', () => {
    const scene: Scene = {
      pending: new Map([
        ['0,64,0', 1000],
        ['16,64,0', 1400]
      ]),
      outstanding: new Set(['32,64,0']),
      visible: new Set(['0,64,0', '16,64,0', '32,64,0'])
    }
    expect(select(scene, 1499)).toEqual([])
    expect(select(scene, 1500).sort()).toEqual(['0,64,0', '16,64,0'])
  })

  it('keeps unrelated groups independent', () => {
    const scene: Scene = {
      pending: new Map([
        ['0,64,0', 1000],
        ['160,64,160', 1000]
      ]),
      outstanding: new Set(['16,64,0']),
      visible: new Set(['0,64,0', '16,64,0', '160,64,160'])
    }
    expect(select(scene, 1010)).toEqual(['160,64,160'])
  })

  it('labels complete groups vs deadline flushes', () => {
    const complete: Scene = {
      pending: new Map([['160,64,160', 1000]]),
      outstanding: new Set(),
      visible: new Set(['160,64,160'])
    }
    expect(selectReadySectionFlushes({
      pendingKeys: complete.pending.keys(),
      startedAt: key => complete.pending.get(key),
      now: 1010,
      maxBufferMs: MAX_BUFFER_MS,
      sectionHeight: SECTION_HEIGHT,
      isOutstanding: key => complete.outstanding.has(key),
      hasSectionObject: key => complete.visible.has(key)
    })).toEqual([{ key: '160,64,160', reason: 'group-complete' }])

    const expired: Scene = {
      pending: new Map([
        ['0,64,0', 1000],
        ['16,64,0', 1120]
      ]),
      outstanding: new Set(['32,64,0']),
      visible: new Set(['0,64,0', '16,64,0', '32,64,0'])
    }
    expect(
      selectReadySectionFlushes({
        pendingKeys: expired.pending.keys(),
        startedAt: key => expired.pending.get(key),
        now: 1500,
        maxBufferMs: MAX_BUFFER_MS,
        sectionHeight: SECTION_HEIGHT,
        isOutstanding: key => expired.outstanding.has(key),
        hasSectionObject: key => expired.visible.has(key)
      }).map(item => item.reason)
    ).toEqual(['deadline', 'deadline'])
  })
})

describe('selectReadySectionFlushes topology vs covering', () => {
  const flushQuery = (scene: Scene, now: number, topologyOutstanding?: Set<string>) =>
    selectReadySectionFlushes({
      pendingKeys: scene.pending.keys(),
      startedAt: key => scene.pending.get(key),
      now,
      maxBufferMs: MAX_BUFFER_MS,
      sectionHeight: SECTION_HEIGHT,
      isOutstanding: key => scene.outstanding.has(key),
      isTopologyOutstanding: topologyOutstanding ? key => topologyOutstanding.has(key) : undefined,
      hasSectionObject: key => scene.visible.has(key)
    })

  it('holds a group while a visible neighbour is topology-outstanding', () => {
    const scene: Scene = {
      pending: new Map([['0,64,0', 1000]]),
      outstanding: new Set(),
      visible: new Set(['0,64,0', '16,64,0'])
    }
    expect(flushQuery(scene, 1050, new Set(['16,64,0'])).map(item => item.key)).toEqual([])
  })

  it('does not hold a group for covering-only outstanding neighbours', () => {
    const scene: Scene = {
      pending: new Map([['0,64,0', 1000]]),
      outstanding: new Set(['16,64,0']),
      visible: new Set(['0,64,0', '16,64,0'])
    }
    expect(flushQuery(scene, 1050, new Set()).map(item => item.key)).toEqual(['0,64,0'])
    expect(flushQuery(scene, 1050, new Set())[0]?.reason).toBe('group-complete')
  })

  it('holds a singleton with a topology-outstanding neighbour until the deadline', () => {
    const scene: Scene = {
      pending: new Map([['0,64,0', 1000]]),
      outstanding: new Set(['16,64,0']),
      visible: new Set(['0,64,0', '16,64,0'])
    }
    expect(flushQuery(scene, 1499, new Set(['16,64,0']))).toEqual([])
    expect(flushQuery(scene, 1500, new Set(['16,64,0']))).toEqual([{ key: '0,64,0', reason: 'deadline' }])
  })
})
