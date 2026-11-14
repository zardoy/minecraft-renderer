/**
 * Light emission of opaque block pixels, written to the alpha channel of the frame for the bloom and heat haze post
 * effects (`#define BLOCK_EMISSION`, only while one of them is on, only on materials drawn without blending).
 *
 * Everything else in the frame has alpha 1: opaque three materials force it, blended ones keep it at 1 over an opaque
 * background. Encoding, e = emission 0..1 (texture marked emissive × texel brightness): alpha = 1 - EMISSION_SCALE * e.
 * Translucent surfaces blended on top raise alpha again, so light seen through glass or water glows less.
 */

export const EMISSION_SCALE = 0.45

/** Fragment chunk: `blockEmissionAlpha(cell, texel)` for the 16px atlas cell of the pixel. */
export const BLOCK_EMISSION_GLSL = /* glsl */ `
#ifdef BLOCK_EMISSION
uniform sampler2D u_tileFlags;

float blockEmissionAlpha(ivec2 cell, vec3 texel) {
    ivec2 size = textureSize(u_tileFlags, 0);
    if (size.x < 2 || cell.x < 0 || cell.y < 0 || cell.x >= size.x || cell.y >= size.y) return 1.0;
    vec4 flags = texelFetch(u_tileFlags, cell, 0);
    // Only the bright texels of a light source glow: the flame of a torch, not its stick.
    float e = flags.g * smoothstep(0.35, 0.85, max(texel.r, max(texel.g, texel.b)));
    return 1.0 - ${EMISSION_SCALE.toFixed(2)} * e;
}
#endif
`

/** CPU mirror of the post-effect decoder, for tests: alpha → emission. */
export function decodeEmissionAlpha(alpha: number): number {
  return Math.min(1, Math.max(0, (1 - alpha) / EMISSION_SCALE))
}
