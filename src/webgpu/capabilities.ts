/**
 * WebGPU capability probing.
 *
 * Kept dependency-free and side-effect-free so the playground / harness can call it
 * before deciding which backend to load (and so iOS crash-testing can report exactly
 * which limits the device reported).
 */

export type WebGpuLimitsReport = {
  maxStorageBufferBindingSize: number
  maxBufferSize: number
  maxComputeWorkgroupSizeX: number
  maxComputeInvocationsPerWorkgroup: number
  maxStorageBuffersPerShaderStage: number
}

export type WebGpuSupport =
  | { supported: false; reason: string }
  | {
      supported: true
      adapterInfo: { vendor: string; architecture: string; device: string; description: string }
      features: string[]
      limits: WebGpuLimitsReport
      /** True when the adapter reports itself as a fallback (software) adapter. */
      isFallbackAdapter: boolean
    }

/** Maximum faces addressable given a storage-buffer binding limit (16 B per face). */
export const BYTES_PER_FACE = 16

export function maxFacesForLimits(limits: WebGpuLimitsReport): number {
  return Math.floor(limits.maxStorageBufferBindingSize / BYTES_PER_FACE)
}

let cached: Promise<WebGpuSupport> | undefined

export function detectWebGpuSupport(force = false): Promise<WebGpuSupport> {
  if (!cached || force) cached = probe()
  return cached
}

async function probe(): Promise<WebGpuSupport> {
  const nav = globalThis.navigator as Navigator & { gpu?: GPU }
  if (!nav?.gpu) {
    return { supported: false, reason: 'navigator.gpu is unavailable (no WebGPU in this browser/context)' }
  }

  let adapter: GPUAdapter | null = null
  try {
    adapter = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' })
  } catch (err: any) {
    return { supported: false, reason: `requestAdapter threw: ${err?.message ?? err}` }
  }

  if (!adapter) {
    return { supported: false, reason: 'requestAdapter returned null (no compatible GPU adapter)' }
  }

  // `requestAdapterInfo` was removed in favour of the `info` getter; support both.
  const rawInfo: any = (adapter as any).info ?? (await (adapter as any).requestAdapterInfo?.()) ?? {}

  const l = adapter.limits
  return {
    supported: true,
    adapterInfo: {
      vendor: rawInfo.vendor ?? 'unknown',
      architecture: rawInfo.architecture ?? 'unknown',
      device: rawInfo.device ?? 'unknown',
      description: rawInfo.description ?? 'unknown'
    },
    features: [...adapter.features],
    limits: {
      maxStorageBufferBindingSize: l.maxStorageBufferBindingSize,
      maxBufferSize: l.maxBufferSize,
      maxComputeWorkgroupSizeX: l.maxComputeWorkgroupSizeX,
      maxComputeInvocationsPerWorkgroup: l.maxComputeInvocationsPerWorkgroup,
      maxStorageBuffersPerShaderStage: l.maxStorageBuffersPerShaderStage
    },
    isFallbackAdapter: Boolean((adapter as any).isFallbackAdapter)
  }
}
