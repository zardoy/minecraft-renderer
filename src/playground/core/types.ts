/**
 * Modular playground core.
 *
 * The original playground was a single 591-line `BasePlaygroundScene` that owned the
 * world, camera, GUI, backend and render loop at once, with scenes as subclasses. That
 * made it impossible to run one concern in isolation — in particular you couldn't boot a
 * memory-stress run without also dragging in the camera, GUI and orbit controls.
 *
 * Here a playground is a list of independent **modules** over a shared context. Each is
 * opt-in, so a scene can be "world + memory harness" with no UI at all — which is exactly
 * what iOS crash testing needs.
 */

import type { Vec3 } from 'vec3'

export type PlaygroundBackendId = 'threejs' | 'webgpu'

/** Shared state every module can read; modules add their own via `provide`/`get`. */
export interface PlaygroundContext {
  readonly backendId: PlaygroundBackendId
  readonly version: string
  readonly params: Record<string, any>
  readonly qs: URLSearchParams

  /** Wall-clock ms since the runtime started. */
  readonly elapsedMs: number

  /** Publish a value for other modules (e.g. the world module publishes its world). */
  provide<T>(key: string, value: T): void
  get<T>(key: string): T | undefined
  require<T>(key: string): T

  /** Structured log that the memory harness persists across crashes. */
  log(channel: string, data: Record<string, any>): void
}

export interface PlaygroundModule {
  readonly name: string
  /** Modules with a lower order run earlier. Default 100. */
  readonly order?: number
  setup?(ctx: PlaygroundContext): void | Promise<void>
  /** Called once per animation frame. */
  update?(ctx: PlaygroundContext, deltaMs: number): void
  teardown?(ctx: PlaygroundContext): void | Promise<void>
}

/** A scene is just a named set of modules plus config. */
export interface PlaygroundScene {
  readonly name: string
  readonly description?: string
  readonly targetPos?: Vec3
  readonly viewDistance?: number
  modules(ctx: Pick<PlaygroundContext, 'qs' | 'backendId'>): PlaygroundModule[]
}
