import type { EventEmitter } from 'events'
import type { WorldViewEvents } from '../worldView/types'
import type { WorldViewWorker } from '../worldView'

/**
 * Register an EventEmitter listener removed when `signal` aborts.
 * Safe for shared emitters (e.g. worldView) — only removes this handler.
 */
export function bindAbortableListener<E extends keyof WorldViewEvents>(
  emitter: Pick<WorldViewWorker, 'on' | 'off'>,
  event: E,
  handler: (...args: Parameters<WorldViewEvents[E]>) => void,
  signal: AbortSignal
): void {
  emitter.on(event, handler as (...args: any[]) => void)
  if (signal.aborted) {
    emitter.off(event, handler as (...args: any[]) => void)
    return
  }
  signal.addEventListener('abort', () => {
    emitter.off(event, handler as (...args: any[]) => void)
  }, { once: true })
}

/** Same pattern for plain EventEmitters (e.g. resourcesManager). */
export function bindAbortableEmitterListener(
  emitter: Pick<EventEmitter, 'on' | 'off'>,
  event: string,
  handler: (...args: any[]) => void,
  signal: AbortSignal
): void {
  emitter.on(event, handler)
  if (signal.aborted) {
    emitter.off(event, handler)
    return
  }
  signal.addEventListener('abort', () => {
    emitter.off(event, handler)
  }, { once: true })
}
