/**
 * Playground runtime: owns the module lifecycle and the frame loop.
 *
 * Deliberately tiny — modules hold the behaviour. The runtime only guarantees ordering,
 * that `setup` completes before the first `update`, and that `teardown` runs in reverse
 * order even when a module throws.
 */

import type { PlaygroundContext, PlaygroundModule, PlaygroundBackendId } from './types'

export type RuntimeOptions = {
  backendId: PlaygroundBackendId
  version: string
  qs?: URLSearchParams
  params?: Record<string, any>
  /** Receives every `ctx.log` call. The memory harness installs a persisting sink. */
  onLog?: (channel: string, data: Record<string, any>) => void
}

export class PlaygroundRuntime {
  private readonly modules: PlaygroundModule[] = []
  private readonly values = new Map<string, unknown>()
  private readonly startedAt = performance.now()
  private rafId: number | undefined
  private lastFrameAt = performance.now()
  private running = false
  private torndown = false

  readonly ctx: PlaygroundContext

  constructor(private readonly options: RuntimeOptions) {
    const self = this
    this.ctx = {
      backendId: options.backendId,
      version: options.version,
      params: options.params ?? {},
      qs: options.qs ?? new URLSearchParams(globalThis.location?.search ?? ''),
      get elapsedMs() {
        return performance.now() - self.startedAt
      },
      provide<T>(key: string, value: T) {
        self.values.set(key, value)
      },
      get<T>(key: string) {
        return self.values.get(key) as T | undefined
      },
      require<T>(key: string) {
        if (!self.values.has(key)) {
          throw new Error(`Playground: no module provided "${key}" (check module order)`)
        }
        return self.values.get(key) as T
      },
      log(channel, data) {
        options.onLog?.(channel, data)
      }
    }
  }

  add(...modules: PlaygroundModule[]): this {
    this.modules.push(...modules)
    return this
  }

  async start(): Promise<void> {
    this.modules.sort((a, b) => (a.order ?? 100) - (b.order ?? 100))

    for (const module of this.modules) {
      try {
        // Sequential on purpose: later modules routinely `require` what earlier ones provide.
        // eslint-disable-next-line no-await-in-loop
        await module.setup?.(this.ctx)
      } catch (err: any) {
        this.ctx.log('error', { module: module.name, phase: 'setup', message: String(err?.message ?? err) })
        throw err
      }
    }

    this.running = true
    this.lastFrameAt = performance.now()
    this.loop()
  }

  private readonly loop = (): void => {
    if (!this.running) return
    this.rafId = requestAnimationFrame(this.loop)

    const now = performance.now()
    const deltaMs = now - this.lastFrameAt
    this.lastFrameAt = now

    for (const module of this.modules) {
      try {
        module.update?.(this.ctx, deltaMs)
      } catch (err: any) {
        this.ctx.log('error', { module: module.name, phase: 'update', message: String(err?.message ?? err) })
      }
    }
  }

  stop(): void {
    this.running = false
    if (this.rafId !== undefined) cancelAnimationFrame(this.rafId)
    this.rafId = undefined
  }

  async teardown(): Promise<void> {
    if (this.torndown) return
    this.torndown = true
    this.stop()
    for (const module of [...this.modules].reverse()) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await module.teardown?.(this.ctx)
      } catch (err: any) {
        this.ctx.log('error', { module: module.name, phase: 'teardown', message: String(err?.message ?? err) })
      }
    }
  }
}
