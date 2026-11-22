import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  CLIENT_LIGHT_TRACE_BATCH_MS,
  CLIENT_LIGHT_TRACE_BATCH_SIZE,
  CLIENT_LIGHT_TRACE_CAPACITY,
  armClientLightTrace,
  bumpClientLightTraceSessionEpoch,
  clearClientLightTrace,
  comparableNow,
  dumpClientLightTrace,
  enableClientLightTrace,
  flushClientLightTracePosts,
  getClientLightTraceAggregates,
  getClientLightTraceEvents,
  ingestRemoteClientLightTrace,
  ingestRemoteClientLightTraceMessage,
  isClientLightTraceArmed,
  isClientLightTraceEnabled,
  isClientLightTraceMessage,
  maybeEnableClientLightTraceFromLocation,
  nextClientLightEditSeq,
  nextClientLightRequestId,
  postClientLightTrace,
  recordClientLightTrace,
  recordClientLightTraceGpuSample,
  requestClientLightTraceSample
} from './clientLightTrace'

afterEach(() => {
  flushClientLightTracePosts()
  enableClientLightTrace(false)
  clearClientLightTrace()
  vi.useRealTimers()
})

test('clientLightTrace is disabled by default and drops records', () => {
  expect(isClientLightTraceEnabled()).toBe(false)
  recordClientLightTrace({ phase: 'blockChange', sectionKey: '0,64,0' })
  expect(getClientLightTraceEvents()).toEqual([])
})

test('clientLightTrace stores metadata-only events in a bounded ring when enabled', () => {
  enableClientLightTrace(true)
  const first = recordClientLightTrace({
    phase: 'blockChange',
    sectionKey: '0,64,0',
    blockVersion: 3,
    lightVersion: 7
  })
  expect(first).toBeDefined()
  expect(first!.t).toBeGreaterThan(0)
  expect(first!.timeOrigin).toBe(performance.timeOrigin)
  expect(first!.t).toBe(first!.timeOrigin + first!.tLocal)
  const events = getClientLightTraceEvents()
  expect(events).toHaveLength(1)
  expect(events[0]!.phase).toBe('blockChange')
  expect(events[0]!.sectionKey).toBe('0,64,0')
  expect(JSON.stringify(events[0])).not.toMatch(/positions|indices|shaderCubes|chunkJson/)
})

test('clientLightTrace wraps at capacity and keeps the newest events', () => {
  enableClientLightTrace(true)
  for (let i = 0; i < CLIENT_LIGHT_TRACE_CAPACITY + 5; i++) {
    recordClientLightTrace({ phase: 'mesherEnqueue', requestId: i })
  }
  const events = getClientLightTraceEvents()
  expect(events).toHaveLength(CLIENT_LIGHT_TRACE_CAPACITY)
  expect(events[0]!.requestId).toBe(5)
  expect(events[events.length - 1]!.requestId).toBe(CLIENT_LIGHT_TRACE_CAPACITY + 4)
})

test('clientLightTrace comparableNow is timeOrigin plus local now', () => {
  const before = performance.timeOrigin + performance.now()
  const stamped = comparableNow()
  const after = performance.timeOrigin + performance.now()
  expect(stamped).toBeGreaterThanOrEqual(before)
  expect(stamped).toBeLessThanOrEqual(after)
})

test('clientLightTrace increments sessionEpoch, editSeq and requestId', () => {
  enableClientLightTrace(true)
  const epoch0 = bumpClientLightTraceSessionEpoch()
  const epoch1 = bumpClientLightTraceSessionEpoch()
  expect(epoch1).toBe(epoch0 + 1)
  const editA = nextClientLightEditSeq()
  const editB = nextClientLightEditSeq()
  expect(editB).toBe(editA + 1)
  const reqA = nextClientLightRequestId()
  const reqB = nextClientLightRequestId()
  expect(reqB).toBe(reqA + 1)
  recordClientLightTrace({
    phase: 'ownerEnqueue',
    sessionEpoch: epoch1,
    editSeq: editB,
    requestId: reqB
  })
  expect(getClientLightTraceEvents()[0]).toMatchObject({
    sessionEpoch: epoch1,
    editSeq: editB,
    requestId: reqB
  })
})

test('clientLightTrace remote ingest keeps the worker timestamp', () => {
  enableClientLightTrace(true)
  const remoteT = 1_700_000_000_000.5
  ingestRemoteClientLightTrace({
    phase: 'mesherStart',
    t: remoteT,
    tLocal: 12,
    timeOrigin: remoteT - 12,
    sectionKey: '16,64,16',
    requestId: 9
  })
  expect(getClientLightTraceEvents()[0]).toMatchObject({
    phase: 'mesherStart',
    t: remoteT,
    requestId: 9
  })
})

test('clientLightTrace remote ingest is a no-op while disabled', () => {
  ingestRemoteClientLightTrace({
    phase: 'mesherEnd',
    t: 1,
    tLocal: 1,
    timeOrigin: 0
  })
  expect(getClientLightTraceEvents()).toEqual([])
})

test('clientLightTrace aggregates counts by phase without storing meshes', () => {
  enableClientLightTrace(true)
  recordClientLightTrace({ phase: 'gpuDrawn', drawableFaces: 8000, cullReason: 'frustum' })
  recordClientLightTrace({ phase: 'gpuDrawn', drawableFaces: 8000, cullReason: 'occlusion' })
  recordClientLightTrace({ phase: 'reject', sectionKey: '0,64,0' })
  const agg = getClientLightTraceAggregates()
  expect(agg.byPhase.gpuDrawn).toBe(2)
  expect(agg.byPhase.reject).toBe(1)
  expect(agg.count).toBe(3)
  expect(agg.dropped).toBe(0)
})

describe('clientLightTrace enable from location search', () => {
  test('maybeEnableClientLightTraceFromLocation stays off without the query', () => {
    maybeEnableClientLightTraceFromLocation({ search: '?clientLight=1' })
    expect(isClientLightTraceEnabled()).toBe(false)
  })

  test('maybeEnableClientLightTraceFromLocation turns on with clientLightTrace=1', () => {
    maybeEnableClientLightTraceFromLocation({ search: '?clientLight=1&clientLightTrace=1' })
    expect(isClientLightTraceEnabled()).toBe(true)
    expect(isClientLightTraceArmed()).toBe(false)
  })
})

describe('clientLightTrace arm window', () => {
  test('stays disarmed when enabled', () => {
    enableClientLightTrace(true)
    expect(isClientLightTraceEnabled()).toBe(true)
    expect(isClientLightTraceArmed()).toBe(false)
  })

  test('exposes arm and dump on the window host when enabled', () => {
    enableClientLightTrace(true)
    const host = globalThis as typeof globalThis & {
      clientLightTraceArm?: (on?: boolean) => void
      clientLightTraceDump?: () => unknown
    }
    expect(typeof host.clientLightTraceArm).toBe('function')
    expect(typeof host.clientLightTraceDump).toBe('function')
    host.clientLightTraceArm?.()
    expect(isClientLightTraceArmed()).toBe(true)
    recordClientLightTrace({ phase: 'blockChange', sectionKey: '0,64,0' })
    const dumped = host.clientLightTraceDump?.() as { events: unknown[]; aggregates: { count: number } }
    expect(dumped.events).toHaveLength(1)
    expect(dumped.aggregates.count).toBe(1)
  })

  test('disabling also disarms', () => {
    enableClientLightTrace(true)
    armClientLightTrace(true)
    enableClientLightTrace(false)
    expect(isClientLightTraceArmed()).toBe(false)
  })
})

describe('clientLightTrace worker post batching', () => {
  test('bulk events without arm send zero inter-thread messages', () => {
    enableClientLightTrace(true)
    const posts: unknown[] = []
    for (let i = 0; i < 50; i++) {
      postClientLightTrace(message => posts.push(message), { phase: 'mesherEnqueue', requestId: i })
    }
    flushClientLightTracePosts()
    expect(posts).toEqual([])
    expect(getClientLightTraceEvents()).toHaveLength(50)
  })

  test('armed posts batch so messages are far fewer than events and every event is delivered', () => {
    vi.useFakeTimers()
    enableClientLightTrace(true)
    armClientLightTrace(true)
    const posts: Array<{ type?: string; events?: Array<{ requestId?: number }> }> = []
    const eventCount = 50
    for (let i = 0; i < eventCount; i++) {
      postClientLightTrace(message => posts.push(message), { phase: 'mesherEnqueue', requestId: i })
    }
    expect(posts).toEqual([])
    vi.advanceTimersByTime(CLIENT_LIGHT_TRACE_BATCH_MS)
    expect(posts).toHaveLength(1)
    expect(posts[0]!.events).toHaveLength(eventCount)
    expect(posts[0]!.events!.map(event => event.requestId)).toEqual([...Array(eventCount).keys()])
    expect(isClientLightTraceMessage(posts[0])).toBe(true)

    enableClientLightTrace(false)
    clearClientLightTrace()
    enableClientLightTrace(true)
    for (const post of posts) ingestRemoteClientLightTraceMessage(post)
    expect(getClientLightTraceEvents()).toHaveLength(eventCount)
  })

  test('armed posts flush immediately at the batch size', () => {
    enableClientLightTrace(true)
    armClientLightTrace(true)
    const posts: Array<{ events?: unknown[] }> = []
    for (let i = 0; i < CLIENT_LIGHT_TRACE_BATCH_SIZE + 3; i++) {
      postClientLightTrace(message => posts.push(message), { phase: 'ownerAdmit', requestId: i })
    }
    expect(posts).toHaveLength(1)
    expect(posts[0]!.events).toHaveLength(CLIENT_LIGHT_TRACE_BATCH_SIZE)
    flushClientLightTracePosts()
    expect(posts).toHaveLength(2)
    expect(posts[1]!.events).toHaveLength(3)
  })
})

describe('clientLightTrace gpu sampling', () => {
  test('1000 unchanged gpuDrawn frames record at most one event until a sample is requested', () => {
    enableClientLightTrace(true)
    for (let i = 0; i < 1000; i++) {
      recordClientLightTraceGpuSample('gpuDrawn', 8000, { phase: 'gpuDrawn', drawableFaces: 8000 })
    }
    expect(getClientLightTraceEvents().filter(event => event.phase === 'gpuDrawn')).toHaveLength(1)
    requestClientLightTraceSample()
    recordClientLightTraceGpuSample('gpuDrawn', 8000, { phase: 'gpuDrawn', drawableFaces: 8000 })
    expect(getClientLightTraceEvents().filter(event => event.phase === 'gpuDrawn')).toHaveLength(2)
    recordClientLightTraceGpuSample('gpuDrawn', 9000, { phase: 'gpuDrawn', drawableFaces: 9000 })
    expect(getClientLightTraceEvents().filter(event => event.phase === 'gpuDrawn')).toHaveLength(3)
  })

  test('gpuUploaded records only when the sampled metric changes', () => {
    enableClientLightTrace(true)
    recordClientLightTraceGpuSample('gpuUploaded', 128, { phase: 'gpuUploaded', unuploadedRanges: 4, drawableFaces: 128 })
    recordClientLightTraceGpuSample('gpuUploaded', 128, { phase: 'gpuUploaded', unuploadedRanges: 3, drawableFaces: 128 })
    recordClientLightTraceGpuSample('gpuUploaded', 256, { phase: 'gpuUploaded', unuploadedRanges: 2, drawableFaces: 256 })
    const uploaded = getClientLightTraceEvents().filter(event => event.phase === 'gpuUploaded')
    expect(uploaded).toHaveLength(2)
    expect(uploaded[0]!.drawableFaces).toBe(128)
    expect(uploaded[1]!.drawableFaces).toBe(256)
  })
})

test('dumpClientLightTrace requests a gpu sample for the next draw', () => {
  enableClientLightTrace(true)
  recordClientLightTraceGpuSample('gpuDrawn', 10, { phase: 'gpuDrawn', drawableFaces: 10 })
  dumpClientLightTrace()
  recordClientLightTraceGpuSample('gpuDrawn', 10, { phase: 'gpuDrawn', drawableFaces: 10 })
  expect(getClientLightTraceEvents().filter(event => event.phase === 'gpuDrawn')).toHaveLength(2)
})
