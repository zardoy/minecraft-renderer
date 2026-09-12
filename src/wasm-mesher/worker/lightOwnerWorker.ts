/**
 * Dedicated light-owner worker. Mesh workers stay read-only.
 * Protocol: init / setLightTables / pushEvent / step / poll.
 */

import type { LightOwnerEvent, LightPublication } from '../../three/lightOwnerHost'

type WasmEngine = {
  setLightTables(emission: Uint8Array, opacity: Uint8Array): void
  pushEvent(event: LightOwnerEvent): void
  step(budgetMs: number): boolean
  pollCompletedPublication(): LightPublication | null
}

let engine: WasmEngine | null = null

const ctx = self as unknown as DedicatedWorkerGlobalScope

ctx.onmessage = async (message: MessageEvent) => {
  const data = message.data
  if (!data || typeof data !== 'object') return
  try {
    switch (data.type) {
      case 'init': {
        const wasm = await import('../runtime-build/wasm_mesher.js')
        await wasm.default('/wasm_mesher_bg.wasm')
        const Engine = (wasm as unknown as { JsLightEngine: new (minY: number, height: number) => WasmEngine }).JsLightEngine
        engine = new Engine(data.worldMinY ?? 0, data.worldHeight ?? 256)
        ctx.postMessage({ type: 'ready' })
        break
      }
      case 'setLightTables': {
        engine?.setLightTables(data.emission, data.opacity)
        ctx.postMessage({ type: 'tablesSet' })
        break
      }
      case 'pushEvent': {
        engine?.pushEvent(data.event)
        break
      }
      case 'step': {
        const remaining = engine?.step(data.budgetMs ?? 5) ?? false
        ctx.postMessage({ type: 'stepped', remaining })
        break
      }
      case 'poll': {
        const publication = engine?.pollCompletedPublication() ?? null
        ctx.postMessage({ type: 'publication', publication })
        break
      }
      default:
        break
    }
  } catch (err) {
    ctx.postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) })
  }
}
