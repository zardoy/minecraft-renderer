/** Bake tint×AO colors with sky/block channels for static export (no live u_skyLevel uniform). */
export function bakeLegacyVertexColors (
  colors: ArrayLike<number>,
  skyLights: ArrayLike<number>,
  blockLights: ArrayLike<number>,
  skyLevel: number,
): number[] {
  const vertCount = colors.length / 3
  const out: number[] = []
  for (let v = 0; v < vertCount; v++) {
    const L = Math.max(blockLights[v] ?? 0, Math.min(skyLights[v] ?? 1, skyLevel))
    const i = v * 3
    out.push(colors[i]! * L, colors[i + 1]! * L, colors[i + 2]! * L)
  }
  return out
}
