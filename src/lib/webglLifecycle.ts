export type ReleasableWebGLRenderer = {
  forceContextLoss: () => void
  dispose: () => void
  domElement: {
    remove?: () => void
  }
}

export const releaseWebGLRenderer = (renderer: ReleasableWebGLRenderer): void => {
  renderer.forceContextLoss()
  renderer.dispose()
  renderer.domElement.remove?.()
}

export const loseWebGLContext = (gl: { getExtension: (name: string) => { loseContext: () => void } | null } | null): void => {
  if (!gl) return
  try {
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  } catch {
    // Context probes are best-effort; failure to release one must not hide support detection errors.
  }
}
