/**
 * Entry point for the modular playground.
 *
 * Separate from `playground.ts` (which boots the legacy `BasePlaygroundScene` class
 * hierarchy) so the two can coexist while scenes migrate over.
 *
 * Usage: point rsbuild's entry at this file, or load it directly, then
 *   ?scene=webgpuStress&stress=churn
 */

import { PlaygroundRuntime } from './core/runtime'
import type { PlaygroundScene, PlaygroundBackendId } from './core/types'
import webgpuStress from './scenes/webgpuStress'
import { describeCrashIfAny, clearLastRun } from './core/modules/memoryHarness'

const scenes: Record<string, PlaygroundScene> = {
  webgpuStress
}

const qs = new URLSearchParams(globalThis.location?.search ?? '')

/** Minimal always-visible readout — iOS devices have no console worth reading. */
function createOverlay(): HTMLPreElement {
  const el = document.createElement('pre')
  Object.assign(el.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    margin: '0',
    padding: '6px 8px',
    font: '11px/1.35 ui-monospace, Menlo, monospace',
    color: '#e6edf3',
    background: 'rgba(0,0,0,0.66)',
    maxWidth: '100vw',
    maxHeight: '45vh',
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    zIndex: '9999',
    pointerEvents: 'none'
  })
  document.body.append(el)
  return el
}

async function boot(): Promise<void> {
  const sceneName = qs.get('scene') ?? 'webgpuStress'
  const scene = scenes[sceneName]
  if (!scene) {
    throw new Error(`Unknown scene "${sceneName}". Available: ${Object.keys(scenes).join(', ')}`)
  }

  const overlay = createOverlay()
  const lines: string[] = []
  const pushLine = (line: string) => {
    lines.push(line)
    if (lines.length > 40) lines.shift()
    overlay.textContent = lines.join('\n')
  }

  if (qs.has('clearHistory')) clearLastRun()

  const crash = describeCrashIfAny()
  if (crash) {
    pushLine('=== PREVIOUS RUN DIED ===')
    for (const l of crash.split('\n')) pushLine(l)
    pushLine('=========================')
  }

  const backendId = (qs.get('backend') as PlaygroundBackendId | null) ?? 'webgpu'
  const runtime = new PlaygroundRuntime({
    backendId,
    version: globalThis.includedVersions?.at(-1) ?? 'unknown',
    qs,
    onLog(channel, data) {
      pushLine(`${channel} ${JSON.stringify(data)}`)
      console.log(`[playground] ${channel}`, data)
    }
  })

  runtime.add(...scene.modules({ qs, backendId }))

  // Live stats line, refreshed independently of the log.
  let statsLine = ''
  const renderStats = () => {
    const renderer: any = runtime.ctx.get('gpuRenderer')
    if (!renderer) return
    const s = renderer.stats
    const next = `faces ${s.usedFaces.toLocaleString()}/${s.capacityFaces.toLocaleString()} · visible ${s.visibleFaces.toLocaleString()} · sections ${s.sectionCount} · cpu ${s.cpuFrameMs.toFixed(1)}ms`
    if (next !== statsLine) {
      statsLine = next
      overlay.textContent = `${lines.join('\n')}\n${next}`
    }
  }
  setInterval(renderStats, 250)

  globalThis.addEventListener('beforeunload', () => void runtime.teardown())
  ;(globalThis as any).playgroundRuntime = runtime

  pushLine(`booting scene "${sceneName}" on ${backendId}`)
  await runtime.start()
}

void boot().catch(err => {
  console.error(err)
  const el = document.createElement('pre')
  el.style.cssText = 'position:fixed;inset:0;padding:16px;font:13px monospace;color:#ff9aa2;background:#111;z-index:99999;white-space:pre-wrap'
  el.textContent = `Playground failed to boot:\n\n${err?.stack ?? err}`
  document.body.append(el)
})
