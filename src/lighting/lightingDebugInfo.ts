/**
 * What the F3 debug overlay shows about lighting: where the light of the world comes from and the light at a position.
 * Pure helpers so the overlay (web client) and tests share them; `WorldRendererCommon.getLightingDebugInfo` fills them in.
 */

export type LightingMode = 'disabled' | 'server' | 'client'

export type LightingDebugInfo = {
  mode: LightingMode
  /** Raw 0..15 light at the position, undefined when its section has no light data (yet). */
  block: number | undefined
  sky: number | undefined
  /** The client light engine was requested but is not running (unsupported version, worker failed, ...). */
  clientEngineUnavailableReason: string | null
}

export function resolveLightingMode(enableLighting: boolean, clientEngineRunning: boolean): LightingMode {
  if (!enableLighting) return 'disabled'
  return clientEngineRunning ? 'client' : 'server'
}

export function lightingModeLabel(info: Pick<LightingDebugInfo, 'mode' | 'clientEngineUnavailableReason'>): string {
  switch (info.mode) {
    case 'disabled':
      return 'Lighting Disabled'
    case 'client':
      return 'Client Engine'
    case 'server':
      return info.clientEngineUnavailableReason ? `Server Lighting, client engine off: ${info.clientEngineUnavailableReason}` : 'Server Lighting'
  }
}

/** The F3 line, e.g. `Light: 14 (12 sky) (Client Engine)` */
export function formatLightingLine(info: LightingDebugInfo): string {
  const value = (v: number | undefined) => (v === undefined ? '?' : String(v))
  return `Light: ${value(info.block)} (${value(info.sky)} sky) (${lightingModeLabel(info)})`
}
