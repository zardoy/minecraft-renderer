/**
 * iOS memory-crash harness.
 *
 * The problem this solves: when iOS Safari runs out of memory it kills the tab outright —
 * no `error`, no `visibilitychange`, no `beforeunload`, and the console is gone with it.
 * Anything held only in memory (or only printed) dies with the page, so you learn nothing
 * about the state that killed it.
 *
 * So every sample is written **synchronously to localStorage** as it is taken. A run is
 * marked `finished` only on clean teardown; if the next boot finds an unfinished run, the
 * tab died, and the last persisted sample is the post-mortem.
 *
 * Samples are kept small and the interval modest (default 500 ms) because localStorage
 * writes are synchronous and would otherwise show up in frame times.
 */

import type { PlaygroundContext, PlaygroundModule } from '../types'
import { detectWebGpuSupport } from '../../../webgpu/capabilities'

const STORAGE_KEY = 'mcr.memoryHarness.v1'
const MAX_SAMPLES = 240

export type MemorySample = {
  /** ms since run start */
  t: number
  /** JS heap MB, when the browser exposes it (Chrome only; absent on iOS Safari). */
  heapMB?: number
  /** CPU-side bytes held by our own GPU-mirroring buffers, MB. */
  bufferMB?: number
  /** Faces resident vs capacity — the number that actually drives allocation. */
  faces?: number
  capacity?: number
  sections?: number
  visible?: number
  fps?: number
  /** Free-form marker, e.g. the stress phase that was active. */
  phase?: string
}

export type MemoryRunRecord = {
  runId: string
  startedAt: number
  userAgent: string
  finished: boolean
  /** Set when the run ends cleanly or a limit is hit. */
  verdict?: string
  adapter?: string
  limits?: Record<string, number>
  samples: MemorySample[]
  events: Array<{ t: number; message: string }>
}

/** Reads the previous run without starting a new one. Safe to call at any time. */
export function readLastRun(): MemoryRunRecord | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as MemoryRunRecord) : undefined
  } catch {
    return undefined
  }
}

export function clearLastRun(): void {
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY)
  } catch {
    /* storage disabled (private mode) — nothing to clear */
  }
}

/**
 * Formats the previous run as a short post-mortem. Returns undefined when the last run
 * ended cleanly, so callers can surface this only when it matters.
 */
export function describeCrashIfAny(): string | undefined {
  const last = readLastRun()
  if (!last || last.finished) return undefined
  const final = last.samples.at(-1)
  if (!final) return `Previous run ${last.runId} died before its first sample.`
  return [
    `Previous run ${last.runId} did not finish — the tab was killed (likely OOM).`,
    `Last sample at ${(final.t / 1000).toFixed(1)}s:`,
    final.heapMB === undefined ? undefined : `  JS heap: ${final.heapMB.toFixed(1)} MB`,
    final.bufferMB === undefined ? undefined : `  Renderer buffers: ${final.bufferMB.toFixed(1)} MB`,
    final.faces === undefined ? undefined : `  Faces: ${final.faces.toLocaleString()} / ${final.capacity?.toLocaleString() ?? '?'}`,
    final.sections === undefined ? undefined : `  Sections: ${final.sections}`,
    final.phase ? `  Phase: ${final.phase}` : undefined,
    `  UA: ${last.userAgent}`
  ]
    .filter(Boolean)
    .join('\n')
}

export type MemoryHarnessOptions = {
  intervalMs?: number
  /**
   * Reports buffer/face figures. Receives the context and is called per sample, so it can
   * resolve a backend that is provided by a module set up *after* this one.
   */
  probe?: (ctx: PlaygroundContext) => Pick<MemorySample, 'bufferMB' | 'faces' | 'capacity' | 'sections' | 'visible'>
  /** Aborts the run when JS heap exceeds this, so you get a verdict instead of a crash. */
  heapLimitMB?: number
  onVerdict?: (verdict: string, record: MemoryRunRecord) => void
}

export function memoryHarnessModule(options: MemoryHarnessOptions = {}): PlaygroundModule {
  const intervalMs = options.intervalMs ?? 500

  let record: MemoryRunRecord
  let lastSampleAt = 0
  let frames = 0
  let framesSince = 0
  let phase = 'idle'
  let stopped = false

  const persist = (): void => {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(record))
    } catch {
      // Quota or private mode: keep rendering, just without post-mortem data.
    }
  }

  const heapMB = (): number | undefined => {
    const mem = (performance as any).memory
    return mem?.usedJSHeapSize === undefined ? undefined : mem.usedJSHeapSize / 1_048_576
  }

  return {
    name: 'memoryHarness',
    order: 10,

    async setup(ctx: PlaygroundContext) {
      const previous = describeCrashIfAny()
      if (previous) {
        console.warn(`[memoryHarness]\n${previous}`)
        ctx.log('memory.previousCrash', { report: previous })
      }

      record = {
        runId: Math.random().toString(36).slice(2, 8),
        startedAt: Date.now(),
        userAgent: globalThis.navigator?.userAgent ?? 'unknown',
        finished: false,
        samples: [],
        events: []
      }

      const support = await detectWebGpuSupport()
      if (support.supported) {
        record.adapter = `${support.adapterInfo.vendor} ${support.adapterInfo.architecture} ${support.adapterInfo.device}`.trim()
        record.limits = {
          maxStorageBufferBindingSizeMB: support.limits.maxStorageBufferBindingSize / 1_048_576,
          maxBufferSizeMB: support.limits.maxBufferSize / 1_048_576
        }
      } else {
        record.events.push({ t: 0, message: `WebGPU unavailable: ${support.reason}` })
      }
      persist()

      ctx.provide('memoryHarness', {
        setPhase(next: string) {
          phase = next
          record.events.push({ t: Math.round(ctx.elapsedMs), message: `phase: ${next}` })
          persist()
        },
        mark(message: string) {
          record.events.push({ t: Math.round(ctx.elapsedMs), message })
          persist()
        },
        get record() {
          return record
        }
      })
    },

    update(ctx: PlaygroundContext) {
      if (stopped) return
      frames++
      framesSince++

      const t = ctx.elapsedMs
      if (t - lastSampleAt < intervalMs) return

      const fps = (framesSince * 1000) / (t - lastSampleAt)
      lastSampleAt = t
      framesSince = 0

      const probed = options.probe?.(ctx) ?? {}
      const sample: MemorySample = {
        t: Math.round(t),
        heapMB: heapMB(),
        fps: Math.round(fps),
        phase,
        ...probed
      }

      record.samples.push(sample)
      // Ring-buffer: keep the run bounded so the synchronous write stays cheap.
      if (record.samples.length > MAX_SAMPLES) record.samples.splice(0, record.samples.length - MAX_SAMPLES)
      persist()

      if (options.heapLimitMB !== undefined && sample.heapMB !== undefined && sample.heapMB > options.heapLimitMB) {
        stopped = true
        const verdict = `Heap limit exceeded: ${sample.heapMB.toFixed(1)} MB > ${options.heapLimitMB} MB at ${(t / 1000).toFixed(1)}s (phase: ${phase})`
        record.verdict = verdict
        record.finished = true
        persist()
        console.error(`[memoryHarness] ${verdict}`)
        options.onVerdict?.(verdict, record)
      }
    },

    teardown() {
      record.finished = true
      record.verdict ??= `Clean shutdown after ${record.samples.length} samples, ${frames} frames.`
      persist()
    }
  }
}
