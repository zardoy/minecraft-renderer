export type RendererGpuPreference = 'default' | 'high-performance' | 'low-power'

/** Maps stored `gpuPreference` to WebGL `powerPreference` (undefined = browser default). */
export function gpuPreferenceToWebGLPowerPreference(preference: RendererGpuPreference): 'high-performance' | 'low-power' | undefined {
  if (preference === 'high-performance') return 'high-performance'
  if (preference === 'low-power') return 'low-power'
  return undefined
}
