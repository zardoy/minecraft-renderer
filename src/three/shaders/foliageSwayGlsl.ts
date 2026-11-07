import { FOLIAGE_TAG_MAX_TEXELS, FOLIAGE_TAG_MIN_TEXELS } from '../../mesher-shared/foliageSway'

/**
 * Wind is a sum of sines of the world position and time. Spatial frequencies are whole cycles per SWAY_PERIOD blocks
 * and temporal ones whole cycles per SWAY_TIME_PERIOD seconds, so the CPU can wrap both into small numbers (float
 * precision) without plants ever jumping.
 */
export const SWAY_PERIOD = 64
export const SWAY_TIME_PERIOD = 600
/** Max horizontal offset in blocks per sway level (top of a tall plant moves twice as much). */
const SWAY_AMPLITUDE = 0.06
/** Leaves move as a whole block, much less than grass tips. */
const LEAF_AMPLITUDE = 0.025

const glslFloat = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`)

/**
 * Vertex shader chunk, active with `#define WAVING_FOLIAGE`. Needs u_originDelta / u_cameraOriginFrac (all block
 * shaders have them): `relativePos - u_originDelta + u_cameraOriginFrac` is the position relative to the render origin,
 * which only changes on rebase, and u_swayOriginMod is that origin modulo SWAY_PERIOD.
 */
export const FOLIAGE_SWAY_GLSL = /* glsl */ `
#ifdef WAVING_FOLIAGE
uniform float u_swayTime;
uniform vec3 u_swayOriginMod;

const float SWAY_TAU = 6.283185307;

vec3 swayWorldPos(vec3 relativePos) {
    return relativePos - u_originDelta + u_cameraOriginFrac + u_swayOriginMod;
}

vec2 windOffset(vec3 p) {
    float s = SWAY_TAU / ${glslFloat(SWAY_PERIOD)};
    float w = SWAY_TAU / ${glslFloat(SWAY_TIME_PERIOD)};
    float t = u_swayTime;
    float gust = 0.6 + 0.4 * sin(w * 40.0 * t + s * (p.x + 2.0 * p.z));
    float a = sin(w * 480.0 * t + s * (5.0 * p.x + 3.0 * p.z + 2.0 * p.y));
    float b = sin(w * 690.0 * t + s * (-3.0 * p.x + 4.0 * p.z + p.y));
    float c = sin(w * 1130.0 * t + s * (7.0 * p.x - 6.0 * p.z));
    return gust * vec2(0.8 * a + 0.2 * c, 0.7 * b + 0.3 * c);
}

#ifdef WAVING_FOLIAGE_LEGACY
uniform sampler2D u_atlas;

float swayTagged(float offGrid) {
    return step(${glslFloat(FOLIAGE_TAG_MIN_TEXELS)}, offGrid) * (1.0 - step(${glslFloat(FOLIAGE_TAG_MAX_TEXELS)}, offGrid));
}

/** Level encoded by the mesher in the atlas UV, see mesher-shared/foliageSway.ts. */
float foliageSwayLevel(vec2 atlasUv) {
    vec2 size = vec2(textureSize(u_atlas, 0));
    // No atlas bound yet (1x1 placeholder): every UV would look tagged.
    if (size.x < 64.0) return 0.0;
    vec2 texels = atlasUv * size;
    vec2 offGrid = abs(texels - floor(texels + 0.5));
    float v = swayTagged(offGrid.y);
    return v * (1.0 + swayTagged(offGrid.x));
}

vec3 foliageSwayOffset(vec2 atlasUv, vec3 relativePos) {
    float level = foliageSwayLevel(atlasUv);
    if (level == 0.0) return vec3(0.0);
    vec2 wind = windOffset(swayWorldPos(relativePos)) * (${glslFloat(SWAY_AMPLITUDE)} * level);
    return vec3(wind.x, 0.0, wind.y);
}
#endif

#ifdef WAVING_FOLIAGE_CUBE
/** One texel per 12-bit tile index (tilesPerRow wide), r = 1 for leaves. */
uniform sampler2D u_leafMask;

vec3 leafSwayOffset(int texIndex, vec3 relativePos) {
    int maskWidth = textureSize(u_leafMask, 0).x;
    if (maskWidth < 2 || texelFetch(u_leafMask, ivec2(texIndex % maskWidth, texIndex / maskWidth), 0).r < 0.5) return vec3(0.0);
    vec3 p = swayWorldPos(relativePos);
    vec2 wind = windOffset(p) * ${glslFloat(LEAF_AMPLITUDE)};
    float bob = sin(SWAY_TAU / ${glslFloat(SWAY_PERIOD)} * 9.0 * (p.x + p.z));
    return vec3(wind.x, 0.5 * wind.y * bob, wind.y);
}
#endif
#endif
`
