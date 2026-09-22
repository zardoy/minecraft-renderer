/**
 * Dedicated light-owner worker. Mesh workers stay read-only.
 * Protocol: init / setLightTables / setSkyLightEnabled / pushEvent /
 * setUpdateLightV17 / setUpdateLightV16 / step / poll.
 * Messages arriving before init completes are queued.
 */

import type { LightOwnerEvent, LightPublication } from '../../three/lightOwnerHost'
import { eventsFromWasmUpdateLight } from './updateLightToOwnerEvents'
import {
  CLIENT_LIGHT_TRACE_MESSAGE,
  armClientLightTrace,
  enableClientLightTrace,
  isClientLightTraceArmed,
  isClientLightTraceEnabled,
  postClientLightTrace
} from '../../lib/clientLightTrace'

type WasmEngine = {
  setLightTables(emission: Uint8Array, opacity: Uint8Array): void
  setOcclusionTable?(occupancy: Uint8Array): void
  setSkyLightEnabled?(enabled: boolean): void
  pushEvent(event: LightOwnerEvent): void
  step(budgetMs: number): boolean
  pollCompletedPublication(): LightPublication | null
}

let engine: WasmEngine | null = null
let wasm: any = null
let worldMinY = 0
const pending: any[] = []
let localContinue: ReturnType<typeof setTimeout> | null = null
let stepGeneration = 0

const ctx = self as unknown as DedicatedWorkerGlobalScope
const postTrace = (message: { type: typeof CLIENT_LIGHT_TRACE_MESSAGE; events?: unknown; event?: unknown }) => {
  ctx.postMessage(message)
}

function runOwnerStepSlice(budgetMs: number) {
  localContinue = null
  const remaining = engine?.step(budgetMs) ?? false
  const publication = engine?.pollCompletedPublication() ?? null
  ctx.postMessage({ type: 'stepped', remaining, publication, stepGeneration })
  if (publication && isClientLightTraceEnabled() && isClientLightTraceArmed()) {
    postClientLightTrace(postTrace, {
      phase: 'ownerComplete',
      lightVersion: publication.publicationVersion,
      worldGeneration: publication.worldGeneration,
      queueDepth: remaining ? 1 : 0
    })
  }
  if (remaining) {
    localContinue = setTimeout(() => {
      runOwnerStepSlice(budgetMs)
    }, 0)
  }
}

async function handle(data: any) {
  if (!data || typeof data !== 'object') return
  switch (data.type) {
    case 'init': {
      wasm = await import('../runtime-build/wasm_mesher.js')
      await wasm.default('/wasm_mesher_bg.wasm')
      const Engine = (wasm as unknown as { JsLightEngine: new (minY: number, height: number) => WasmEngine }).JsLightEngine
      worldMinY = data.worldMinY ?? 0
      engine = new Engine(worldMinY, data.worldHeight ?? 256)
      ctx.postMessage({ type: 'ready' })
      const queued = pending.splice(0, pending.length)
      for (const message of queued) await handle(message)
      break
    }
    case 'setLightTables': {
      engine?.setLightTables(data.emission, data.opacity)
      if (data.occupancy) engine?.setOcclusionTable?.(data.occupancy)
      ctx.postMessage({ type: 'tablesSet' })
      break
    }
    case 'setSkyLightEnabled': {
      engine?.setSkyLightEnabled?.(Boolean(data.enabled))
      break
    }
    case 'pushEvent': {
      engine?.pushEvent(data.event)
      const event = data.event as LightOwnerEvent | undefined
      const currentColumn =
        event && 'x' in event && typeof event.x === 'number'
          ? `${Math.floor(event.x / 16)},${Math.floor((event as { z: number }).z / 16)}`
          : event && 'sx' in event && typeof event.sx === 'number'
            ? `${event.sx},${(event as { sz: number }).sz}`
            : undefined
      if (isClientLightTraceEnabled() && isClientLightTraceArmed()) {
        postClientLightTrace(postTrace, {
          phase: 'ownerAdmit',
          currentColumn,
          queueDepth: pending.length
        })
      }
      break
    }
    case 'clientLightTraceConfig': {
      enableClientLightTrace(Boolean(data.enabled))
      armClientLightTrace(Boolean(data.armed))
      break
    }
    case 'setUpdateLightV17': {
      if (!wasm || !engine) break
      const parsed = wasm.parseUpdateLightV17(data.rawPacket as Uint8Array, data.numSections as number)
      for (const event of eventsFromWasmUpdateLight(parsed, data.numSections as number, worldMinY)) {
        engine.pushEvent(event)
      }
      break
    }
    case 'setUpdateLightV16': {
      if (!wasm || !engine) break
      const parsed = wasm.parseUpdateLightV17(data.rawPacket as Uint8Array, 16)
      for (const event of eventsFromWasmUpdateLight(parsed, 16, worldMinY)) {
        engine.pushEvent(event)
      }
      break
    }
    case 'step': {
      if (typeof data.stepGeneration === 'number') stepGeneration = data.stepGeneration
      if (localContinue) break
      runOwnerStepSlice(data.budgetMs ?? 5)
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
}

ctx.onmessage = async (message: MessageEvent) => {
  const data = message.data
  if (!data || typeof data !== 'object') return
  try {
    if (!engine && data.type !== 'init') {
      pending.push(data)
      return
    }
    await handle(data)
  } catch (err) {
    ctx.postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) })
  }
}
