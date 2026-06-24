import type { MesherConfig } from './shared'

export type FaceDirection = readonly [number, number, number]

/** Directional face darkening (matches legacy `renderElement` in models.ts). */
export function getSideShading(dir: FaceDirection, shadingTheme: MesherConfig['shadingTheme'], cardinalLight: MesherConfig['cardinalLight']): number {
  if (shadingTheme === 'high-contrast') {
    return 0.8 + 0.5 * Math.max(0, 0.66 * dir[0] + 0.66 * dir[1] + 0.33 * dir[2])
  }
  if (cardinalLight === 'nether') {
    return 0.5 + Math.abs(0.1 * dir[0] + 0.4 * dir[1] + 0.3 * dir[2])
  }
  return 0.75 + 0.25 * dir[1] + 0.05 * (Math.abs(dir[2]) - 3 * Math.abs(dir[0]))
}

/** Per-vertex brightness from AO (0–3) and corner light (0–15). */
export function vertexLightFromAo(ao: number, cornerLight15: number, sideShading: number, shadingTheme: MesherConfig['shadingTheme']): number {
  const lightNorm = cornerLight15 / 15
  if (shadingTheme === 'high-contrast') {
    return sideShading * ((ao + 1) / 4) * lightNorm
  }
  const aoBias = 0.4
  const aoScale = 0.2
  return sideShading * (ao * aoScale + aoBias) * lightNorm
}
