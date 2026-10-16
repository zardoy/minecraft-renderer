/**
 * WebGPU memory / stress scene.
 *
 * Boots the WebGPU renderer with synthetic geometry and nothing else — no world, no
 * assets, no GUI — so it can be pointed at an iOS device as a single URL:
 *
 *   ?scene=webgpuStress&stress=churn&faces=2048&step=60
 *
 * Query params:
 *   stress   grow | churn | sustained   (default grow)
 *   faces    faces per synthetic section (default 1536)
 *   step     ms between allocation steps (default 100)
 *   max      stop after N sections (default 20000)
 *   heap     abort if JS heap exceeds N MB (Chrome only; iOS has no heap API)
 *   nocull   set to disable frustum culling
 *
 * After a crash, reload the same URL: the harness prints the previous run's final sample
 * before starting a new one.
 */

import type { PlaygroundScene, PlaygroundModule } from '../core/types'
import { memoryHarnessModule, describeCrashIfAny } from '../core/modules/memoryHarness'
import { gpuStressModule, type StressScenario } from '../core/modules/gpuStress'
import { webgpuBackendModule, gpuMemoryProbe } from '../core/modules/webgpuBackend'

const num = (qs: URLSearchParams, key: string, fallback: number): number => {
  const raw = qs.get(key)
  const parsed = raw === null ? Number.NaN : Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

const webgpuStress: PlaygroundScene = {
  name: 'webgpuStress',
  description: 'WebGPU allocation stress + crash-survivable memory harness (iOS).',

  modules({ qs }): PlaygroundModule[] {
    const scenario = (qs.get('stress') as StressScenario | null) ?? 'grow'
    const heapLimitMB = qs.has('heap') ? num(qs, 'heap', 1024) : undefined

    // Runs first (order: 10) so it captures any previous crash before the renderer
    // allocates anything. The probe resolves the renderer from the context per sample.
    const harness = memoryHarnessModule({
      heapLimitMB,
      intervalMs: num(qs, 'sample', 500),
      probe: gpuMemoryProbe
    })

    const backend = webgpuBackendModule({
      disableCulling: qs.has('nocull'),
      enableLegacyGeometry: qs.has('legacy')
    })

    const stress = gpuStressModule({
      scenario,
      facesPerSection: num(qs, 'faces', 1536),
      stepIntervalMs: num(qs, 'step', 100),
      maxSections: num(qs, 'max', 20_000),
      sectionsPerStep: num(qs, 'perStep', 8),
      workingSet: num(qs, 'workingSet', 2048)
    })

    return [harness, backend, stress]
  }
}

export { describeCrashIfAny }
export default webgpuStress
