/**
 * Bounded causal trace for client lighting delivery.
 * Off by default. Records metadata and aggregates only — never meshes, chunks, or raw packets.
 */

export const CLIENT_LIGHT_TRACE_CAPACITY = 2048
export const CLIENT_LIGHT_TRACE_MESSAGE = '__clientLightTrace' as const
export const CLIENT_LIGHT_TRACE_BATCH_MS = 250
export const CLIENT_LIGHT_TRACE_BATCH_SIZE = 200

export type ClientLightTracePhase =
  | 'inputClick'
  | 'inputHand'
  | 'blockChange'
  | 'ownerEnqueue'
  | 'ownerAdmit'
  | 'ownerComplete'
  | 'mesherEnqueue'
  | 'mesherStart'
  | 'mesherEnd'
  | 'mesherFlush'
  | 'receive'
  | 'reject'
  | 'pending'
  | 'flush'
  | 'gpuStaged'
  | 'gpuUploaded'
  | 'gpuCommitted'
  | 'gpuDrawn'

export type ClientLightTraceEvent = {
  t: number
  tLocal: number
  timeOrigin: number
  phase: ClientLightTracePhase
  sessionEpoch?: number
  editSeq?: number
  requestId?: number
  sectionKey?: string
  blockVersion?: number
  lightVersion?: number
  worldGeneration?: number
  eventAgeMs?: number
  currentColumn?: string
  queueDepth?: number
  txnMs?: number
  displayedStart?: number
  displayedCount?: number
  candidateStart?: number
  candidateCount?: number
  pendingReplace?: boolean
  pendingMove?: boolean
  unuploadedRanges?: number
  drawableFaces?: number
  cullReason?: string
  flushReason?: string
  workerIndex?: number
}

export type ClientLightTracePartial = Omit<ClientLightTraceEvent, 't' | 'tLocal' | 'timeOrigin'> &
  Partial<Pick<ClientLightTraceEvent, 't' | 'tLocal' | 'timeOrigin'>>

export type ClientLightTraceMessage = {
  type: typeof CLIENT_LIGHT_TRACE_MESSAGE
  event?: ClientLightTraceEvent
  events?: ClientLightTraceEvent[]
}

export type ClientLightTraceConfig = {
  enabled: boolean
  armed: boolean
}

type ClientLightTraceConfigListener = (config: ClientLightTraceConfig) => void

let enabled = false
let armed = false
let sessionEpoch = 0
let editSeq = 0
let requestId = 0
let dropped = 0
let start = 0
let count = 0
let sampleRequested = false
let lastGpuDrawnMetric: number | undefined
let lastGpuUploadedMetric: number | undefined
let pendingPost: ((message: ClientLightTraceMessage) => void) | null = null
let pendingEvents: ClientLightTraceEvent[] = []
let pendingTimer: ReturnType<typeof setTimeout> | null = null
let configListener: ClientLightTraceConfigListener | undefined
const ring: Array<ClientLightTraceEvent | undefined> = new Array(CLIENT_LIGHT_TRACE_CAPACITY)

export function isClientLightTraceEnabled(): boolean {
  return enabled
}

export function isClientLightTraceArmed(): boolean {
  return armed
}

export function enableClientLightTrace(on: boolean): void {
  enabled = on
  if (!on) {
    armed = false
    dropPendingPosts()
    resetGpuSampleState()
  }
  attachDebugDump(on)
  notifyConfig()
}

export function armClientLightTrace(on = true): void {
  armed = on
  if (!armed) dropPendingPosts()
  notifyConfig()
}

export function setClientLightTraceConfigListener(listener: ClientLightTraceConfigListener | undefined): void {
  configListener = listener
}

export function maybeEnableClientLightTraceFromLocation(loc: { search?: string } | undefined = typeof location === 'undefined' ? undefined : location): void {
  try {
    if (!loc) return
    if (new URLSearchParams(loc.search ?? '').get('clientLightTrace') === '1') {
      enableClientLightTrace(true)
    }
  } catch {
    // ignore malformed URL in non-browser runtimes
  }
}

export function comparableNow(): number {
  return performance.timeOrigin + performance.now()
}

export function getClientLightTraceSessionEpoch(): number {
  return sessionEpoch
}

export function bumpClientLightTraceSessionEpoch(): number {
  sessionEpoch++
  return sessionEpoch
}

export function nextClientLightEditSeq(): number {
  editSeq++
  return editSeq
}

export function nextClientLightRequestId(): number {
  requestId++
  return requestId
}

export function currentClientLightTraceIds(): { sessionEpoch: number; editSeq: number } {
  return { sessionEpoch, editSeq }
}

export function clearClientLightTrace(): void {
  start = 0
  count = 0
  dropped = 0
  ring.fill(undefined)
  resetGpuSampleState()
}

export function recordClientLightTrace(partial: ClientLightTracePartial): ClientLightTraceEvent | undefined {
  if (!enabled) return undefined
  const tLocal = partial.tLocal ?? performance.now()
  const timeOrigin = partial.timeOrigin ?? performance.timeOrigin
  const event: ClientLightTraceEvent = {
    ...partial,
    t: partial.t ?? timeOrigin + tLocal,
    tLocal,
    timeOrigin,
    sessionEpoch: partial.sessionEpoch ?? sessionEpoch
  }
  pushEvent(event)
  return event
}

export function requestClientLightTraceSample(): void {
  sampleRequested = true
}

export function recordClientLightTraceGpuSample(
  phase: 'gpuDrawn' | 'gpuUploaded',
  metric: number,
  partial: ClientLightTracePartial | (() => ClientLightTracePartial)
): ClientLightTraceEvent | undefined {
  if (!enabled) return undefined
  const last = phase === 'gpuDrawn' ? lastGpuDrawnMetric : lastGpuUploadedMetric
  if (last === metric && !sampleRequested) return undefined
  if (phase === 'gpuDrawn') lastGpuDrawnMetric = metric
  else lastGpuUploadedMetric = metric
  sampleRequested = false
  return recordClientLightTrace(typeof partial === 'function' ? partial() : partial)
}

export function ingestRemoteClientLightTrace(event: ClientLightTraceEvent | undefined): void {
  if (!enabled || !event || typeof event.t !== 'number' || !event.phase) return
  pushEvent(event)
}

export function ingestRemoteClientLightTraceMessage(message: ClientLightTraceMessage | { type?: unknown; event?: unknown; events?: unknown }): void {
  if (!isClientLightTraceMessage(message)) return
  const events = message.events ?? (message.event ? [message.event] : [])
  for (const event of events) ingestRemoteClientLightTrace(event)
}

export function postClientLightTrace(post: (message: ClientLightTraceMessage) => void, partial: ClientLightTracePartial): void {
  const event = recordClientLightTrace(partial)
  if (!event || !armed) return
  pendingPost = post
  pendingEvents.push(event)
  if (pendingEvents.length >= CLIENT_LIGHT_TRACE_BATCH_SIZE) {
    flushClientLightTracePosts()
    return
  }
  if (pendingTimer == null) {
    pendingTimer = setTimeout(() => {
      pendingTimer = null
      flushClientLightTracePosts()
    }, CLIENT_LIGHT_TRACE_BATCH_MS)
  }
}

export function flushClientLightTracePosts(): void {
  if (pendingTimer != null) {
    clearTimeout(pendingTimer)
    pendingTimer = null
  }
  if (!pendingPost || pendingEvents.length === 0) {
    pendingEvents = []
    pendingPost = null
    return
  }
  const events = pendingEvents
  const post = pendingPost
  pendingEvents = []
  pendingPost = null
  post({ type: CLIENT_LIGHT_TRACE_MESSAGE, events })
}

export function isClientLightTraceMessage(data: unknown): data is ClientLightTraceMessage {
  if (!data || typeof data !== 'object') return false
  const message = data as { type?: unknown; event?: unknown; events?: unknown }
  if (message.type !== CLIENT_LIGHT_TRACE_MESSAGE) return false
  if (Array.isArray(message.events)) return true
  return !!message.event && typeof message.event === 'object'
}

export function getClientLightTraceEvents(): ClientLightTraceEvent[] {
  const out: ClientLightTraceEvent[] = []
  for (let i = 0; i < count; i++) {
    const event = ring[(start + i) % CLIENT_LIGHT_TRACE_CAPACITY]
    if (event) out.push(event)
  }
  return out
}

export function getClientLightTraceAggregates(): { count: number; dropped: number; byPhase: Partial<Record<ClientLightTracePhase, number>> } {
  const byPhase: Partial<Record<ClientLightTracePhase, number>> = {}
  for (const event of getClientLightTraceEvents()) {
    byPhase[event.phase] = (byPhase[event.phase] ?? 0) + 1
  }
  return { count: count, dropped, byPhase }
}

export function dumpClientLightTrace(): {
  events: ClientLightTraceEvent[]
  aggregates: ReturnType<typeof getClientLightTraceAggregates>
} {
  requestClientLightTraceSample()
  return {
    events: getClientLightTraceEvents(),
    aggregates: getClientLightTraceAggregates()
  }
}

function dropPendingPosts(): void {
  if (pendingTimer != null) {
    clearTimeout(pendingTimer)
    pendingTimer = null
  }
  pendingEvents = []
  pendingPost = null
}

function resetGpuSampleState(): void {
  sampleRequested = false
  lastGpuDrawnMetric = undefined
  lastGpuUploadedMetric = undefined
}

function notifyConfig(): void {
  configListener?.({ enabled, armed })
}

function pushEvent(event: ClientLightTraceEvent): void {
  if (count === CLIENT_LIGHT_TRACE_CAPACITY) {
    ring[start] = event
    start = (start + 1) % CLIENT_LIGHT_TRACE_CAPACITY
    dropped++
    return
  }
  ring[(start + count) % CLIENT_LIGHT_TRACE_CAPACITY] = event
  count++
}

function attachDebugDump(on: boolean): void {
  if (typeof globalThis === 'undefined') return
  const host = globalThis as typeof globalThis & {
    getClientLightTrace?: typeof getClientLightTraceEvents
    getClientLightTraceAggregates?: typeof getClientLightTraceAggregates
    clientLightTraceArm?: (on?: boolean) => void
    clientLightTraceDump?: typeof dumpClientLightTrace
  }
  if (on) {
    host.getClientLightTrace = getClientLightTraceEvents
    host.getClientLightTraceAggregates = getClientLightTraceAggregates
    host.clientLightTraceArm = (next = true) => {
      armClientLightTrace(next !== false)
    }
    host.clientLightTraceDump = dumpClientLightTrace
  } else {
    delete host.getClientLightTrace
    delete host.getClientLightTraceAggregates
    delete host.clientLightTraceArm
    delete host.clientLightTraceDump
  }
}
