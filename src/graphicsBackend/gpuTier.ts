/**
 * Weak mobile GPU detection, for device defaults: the GPUs below can't afford sun shadows and the full-screen color grading pass
 * at native resolution. Measured on a Mali-G57 phone (1600x720, spawn of play.mcraft.fun): shadows cost 35-45 % of the frame rate,
 * the warm grading pass another ~45 %. Players telemetry shows the same class (Mali-G52/G57, Adreno 610) at 16-18 FPS.
 */

let cachedRenderer: string | null | undefined

/** WebGL renderer string (unmasked when the browser allows it), read once from a throwaway context. Undefined outside a page. */
export function detectGpuRenderer(): string | undefined {
  if (cachedRenderer !== undefined) return cachedRenderer ?? undefined
  cachedRenderer = null
  if (typeof document === 'undefined') return undefined
  try {
    const canvas = document.createElement('canvas')
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null
    if (!gl) return undefined
    const info = gl.getExtension('WEBGL_debug_renderer_info')
    cachedRenderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '') || null
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  } catch {
    cachedRenderer = null
  }
  return cachedRenderer ?? undefined
}

/**
 * Low and mid-range mobile GPUs, by renderer string: Mali-4xx / Mali-T / Mali-G below G77, Adreno below 640, PowerVR, and software
 * renderers. Newer Mali (G77+, Immortalis), Adreno 640+ and Apple GPUs keep the full defaults (Auto resolution covers the rest).
 */
export function isWeakMobileGpu(renderer: string | undefined): boolean {
  if (!renderer) return false
  if (/swiftshader|llvmpipe|software/i.test(renderer)) return true
  if (/powervr/i.test(renderer)) return true
  if (/immortalis/i.test(renderer)) return false
  if (/mali-(4\d\d|t\d+)/i.test(renderer)) return true
  const mali = /mali-g(\d+)/i.exec(renderer)
  if (mali) return Number(mali[1]) < 77
  const adreno = /adreno[^\d]*(\d{3})/i.exec(renderer)
  if (adreno) return Number(adreno[1]) < 640
  return false
}

/** Defaults that differ on weak mobile GPUs (only options the player hasn't changed take them). */
export function weakGpuDefaults(weak: boolean) {
  return {
    sunShadows: (weak ? 'off' : 'normal') as 'off' | 'normal' | 'soft',
    colorGrading: (weak ? 'off' : 'warm') as 'off' | 'warm' | 'cinematic' | 'vivid',
    /**
     * One mesher worker instead of two: on a Mali-G57 phone (8 cores) the second worker competed with the main thread, a 20 s walk over
     * chunk borders ran at 21-28 FPS with 62-71 frames over 50 ms, with one worker 29-36 FPS and 28
     */
    rendererWorldPerformance: (weak ? 'low-energy' : 'normal') as 'low-energy' | 'normal' | 'maximum'
  }
}
