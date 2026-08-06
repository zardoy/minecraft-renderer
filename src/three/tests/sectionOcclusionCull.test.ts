import { test, expect, vi, describe, beforeEach, afterEach } from 'vitest'
import { SectionOcclusionCull, OCCLUSION_REBUILD_INTERVAL_MS } from '../occlusion/sectionOcclusionCull'
import { computeSectionVisibilitySet } from '../../mesher-shared/visGraph'

const ALL_OPEN = computeSectionVisibilitySet(16, () => false)
const SOLID = computeSectionVisibilitySet(16, () => true)

const UPDATE_PARAMS = {
  smartCull: true,
  cameraWorldX: 8,
  cameraWorldY: 8,
  cameraWorldZ: 8,
  viewDistance: 4,
  sectionHeight: 16,
  worldMinY: 0,
  worldMaxY: 256
}

test('isSectionVisible fails closed for unregistered sections when smart cull on', () => {
  const cull = new SectionOcclusionCull()
  cull.registerSection('0,0,0', ALL_OPEN, 16)
  cull.onSmartCullEnabled()
  cull.update(UPDATE_PARAMS)
  expect(cull.isSectionVisible('64,0,64')).toBe(false)
})

test('isSectionVisible fails open for unregistered sections when smart cull off', () => {
  const cull = new SectionOcclusionCull()
  cull.registerSection('0,0,0', ALL_OPEN, 16)
  cull.update({ ...UPDATE_PARAMS, smartCull: false })
  expect(cull.isSectionVisible('64,0,64')).toBe(true)
})

test('smart cull off returns empty visible set and runs no BFS work', () => {
  const cull = new SectionOcclusionCull()
  cull.registerSection('0,0,0', ALL_OPEN, 16)
  cull.registerSection('64,0,0', SOLID, 16)
  const visible = cull.update({ ...UPDATE_PARAMS, smartCull: false })
  expect(visible.size).toBe(0)
  expect(cull.getVersion()).toBe(0)
})

test('notifySmartCullChanged via onSmartCullEnabled rebuilds immediately', () => {
  const cull = new SectionOcclusionCull()
  cull.registerSection('0,0,0', ALL_OPEN, 16)
  cull.update({ ...UPDATE_PARAMS, smartCull: false })
  cull.onSmartCullEnabled()
  cull.update(UPDATE_PARAMS)
  expect(cull.isSectionVisible('0,0,0')).toBe(true)
  expect(cull.getVersion()).toBeGreaterThan(0)
})

describe('occlusion rebuild throttling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('registration does not rebuild immediately within throttle window', () => {
    const cull = new SectionOcclusionCull()
    cull.onSmartCullEnabled()
    cull.update(UPDATE_PARAMS)
    const versionAfterFirst = cull.getVersion()

    cull.registerSection('16,0,0', ALL_OPEN, 16)
    cull.update(UPDATE_PARAMS)
    cull.registerSection('32,0,0', ALL_OPEN, 16)
    cull.update(UPDATE_PARAMS)

    expect(cull.getVersion()).toBe(versionAfterFirst)
    expect(cull.isRebuildPending()).toBe(true)
  })

  test('deferred rebuild raises callback after interval with no further activity', () => {
    let dirty = false
    const cull = new SectionOcclusionCull(() => {
      dirty = true
    })
    cull.onSmartCullEnabled()
    cull.update(UPDATE_PARAMS)

    cull.registerSection('16,0,0', ALL_OPEN, 16)
    cull.update(UPDATE_PARAMS)
    expect(dirty).toBe(false)

    vi.advanceTimersByTime(OCCLUSION_REBUILD_INTERVAL_MS)
    expect(dirty).toBe(true)

    dirty = false
    cull.update(UPDATE_PARAMS)
    expect(cull.getVersion()).toBeGreaterThan(1)
    expect(cull.isRebuildPending()).toBe(false)
  })

  test('continuous registration still rebuilds on schedule (throttle not debounce)', () => {
    const cull = new SectionOcclusionCull()
    cull.onSmartCullEnabled()
    cull.update(UPDATE_PARAMS)
    const versionAfterFirst = cull.getVersion()

    for (let i = 0; i < 5; i++) {
      cull.registerSection(`${(i + 1) * 16},0,0`, ALL_OPEN, 16)
      cull.update(UPDATE_PARAMS)
      vi.advanceTimersByTime(OCCLUSION_REBUILD_INTERVAL_MS / 5)
    }

    vi.advanceTimersByTime(OCCLUSION_REBUILD_INTERVAL_MS)
    cull.update(UPDATE_PARAMS)
    expect(cull.getVersion()).toBeGreaterThan(versionAfterFirst)
  })

  test('camera move always rebuilds immediately inside throttle window', () => {
    const cull = new SectionOcclusionCull()
    cull.onSmartCullEnabled()
    cull.update(UPDATE_PARAMS)
    const versionAfterFirst = cull.getVersion()

    cull.registerSection('16,0,0', ALL_OPEN, 16)
    cull.update(UPDATE_PARAMS)

    cull.update({ ...UPDATE_PARAMS, cameraWorldX: 24 })
    expect(cull.getVersion()).toBeGreaterThan(versionAfterFirst)
    expect(cull.isRebuildPending()).toBe(false)
  })

  test('off means idle — no timer and no BFS until enabled', () => {
    let dirty = false
    const cull = new SectionOcclusionCull(() => {
      dirty = true
    })
    cull.registerSection('0,0,0', ALL_OPEN, 16)
    cull.update({ ...UPDATE_PARAMS, smartCull: false })
    expect(cull.getVersion()).toBe(0)

    vi.advanceTimersByTime(OCCLUSION_REBUILD_INTERVAL_MS * 2)
    expect(dirty).toBe(false)

    cull.onSmartCullEnabled()
    cull.update(UPDATE_PARAMS)
    expect(cull.getVersion()).toBe(1)
  })

  test('repeated registerSection with same visibilitySet is idempotent', () => {
    let dirty = false
    const cull = new SectionOcclusionCull(() => {
      dirty = true
    })
    cull.registerSection('0,0,0', ALL_OPEN, 16)
    cull.onSmartCullEnabled()
    cull.update(UPDATE_PARAMS)
    const versionAfterRebuild = cull.getVersion()

    cull.registerSection('0,0,0', ALL_OPEN, 16)
    expect(cull.isStructuralDirty()).toBe(false)
    expect(cull.isRebuildPending()).toBe(false)
    expect(cull.getVersion()).toBe(versionAfterRebuild)

    cull.registerSection('0,0,0', undefined, 16)
    expect(cull.isStructuralDirty()).toBe(false)

    cull.update(UPDATE_PARAMS)
    expect(cull.isRebuildPending()).toBe(false)
    vi.advanceTimersByTime(OCCLUSION_REBUILD_INTERVAL_MS)
    expect(dirty).toBe(false)
  })

  test('registerSection with changed visibilitySet marks pending rebuild', () => {
    const cull = new SectionOcclusionCull()
    cull.registerSection('0,0,0', ALL_OPEN, 16)
    cull.onSmartCullEnabled()
    cull.update(UPDATE_PARAMS)

    cull.registerSection('0,0,0', SOLID, 16)
    expect(cull.isStructuralDirty()).toBe(true)
    cull.update(UPDATE_PARAMS)
    expect(cull.isRebuildPending()).toBe(true)
    expect(cull.getGraph().getSection('0,0,0')?.visibilitySet).toBe(SOLID)
  })
})
