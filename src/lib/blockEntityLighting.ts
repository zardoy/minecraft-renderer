/**
 * Shared block lighting math — keep in sync with APPLY_LIGHTMAP_GLSL in shaders.
 */

export type BlockLightmapParams = {
  curve?: number
  minBrightness?: number
  gamma?: number
}

export const DEFAULT_LIGHTMAP_PARAMS: Required<BlockLightmapParams> = {
  curve: 0,
  minBrightness: 0.12,
  gamma: 1,
}

/** GLSL body for applyLightmap — requires u_lightCurve, u_minBrightness, u_lightGamma uniforms. */
export const APPLY_LIGHTMAP_GLSL = /* glsl */ `
float applyLightmap(float L) {
    float curved = L / (4.0 - 3.0 * L);
    float shaped = mix(L, curved, u_lightCurve);
    shaped = mix(u_minBrightness, 1.0, shaped);
    return clamp(pow(shaped, u_lightGamma), 0.0, 1.0);
}
`

export function applyLightmap (L: number, params: BlockLightmapParams = DEFAULT_LIGHTMAP_PARAMS): number {
  const curve = params.curve ?? DEFAULT_LIGHTMAP_PARAMS.curve
  const minBrightness = params.minBrightness ?? DEFAULT_LIGHTMAP_PARAMS.minBrightness
  const gamma = params.gamma ?? DEFAULT_LIGHTMAP_PARAMS.gamma

  const curved = L / (4 - 3 * L)
  let shaped = L * (1 - curve) + curved * curve
  shaped = minBrightness + shaped * (1 - minBrightness)
  return Math.min(1, Math.max(0, shaped ** gamma))
}

/** Same cap as block shaders: max(block, min(sky, skyLevel)). */
export function combinedBlockLight (block: number, sky: number, skyLevel: number): number {
  return Math.max(block, Math.min(sky, skyLevel))
}

/** 0..1 brightness for MeshBasicMaterial.color.setScalar on block-entity overlays. */
export function blockEntityBrightness (
  blockNorm: number,
  skyNorm: number,
  skyLevel: number,
  lightmapParams: BlockLightmapParams = DEFAULT_LIGHTMAP_PARAMS,
): number {
  const L = combinedBlockLight(blockNorm, skyNorm, skyLevel)
  return applyLightmap(L, lightmapParams)
}
