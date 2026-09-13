import { afterEach, describe, expect, test } from 'vitest'
import {
  CLIENT_LIGHT_TRACE_CAPACITY,
  bumpClientLightTraceSessionEpoch,
  clearClientLightTrace,
  comparableNow,
  enableClientLightTrace,
  getClientLightTraceAggregates,
  getClientLightTraceEvents,
  ingestRemoteClientLightTrace,
  isClientLightTraceEnabled,
  maybeEnableClientLightTraceFromLocation,
  nextClientLightEditSeq,
  nextClientLightRequestId,
  recordClientLightTrace
} from './clientLightTrace'

afterEach(() => {
  enableClientLightTrace(false)
  clearClientLightTrace()
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
  })
})
