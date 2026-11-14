/**
 * Sun shadows for the chunk block shaders: a single directional shadow map rendered by the sunShadows module.
 *
 * Positions use the render-origin-relative frame (`relativePos - u_originDelta + u_cameraOriginFrac`): it does not
 * depend on the camera, so a map rendered once stays valid while the camera moves, until the module re-renders it.
 *
 * Defines: SUN_SHADOWS (receive), SUN_SHADOWS_SOFT (wide Poisson filter), SHADOW_CASTER (depth pass variant of the
 * vertex shader: projects with u_lightViewProj and skips everything else).
 */

/** Sky light that still reaches a fully shadowed surface (sky ambient), as a factor of the unshadowed sky light. */
export const SHADOWED_SKY_LIGHT = 0.6

const SOFT_DISK = [
  [-0.358, -0.704],
  [0.207, 0.546],
  [-0.33, 0.352],
  [0.429, -0.772],
  [-0.52, 0.815],
  [0.23, -0.278],
  [0.875, 0.053],
  [-0.689, 0.008],
  [-0.266, -0.131],
  [0.734, -0.448],
  [0.582, 0.799],
  [0.391, 0.12],
  [-0.791, 0.42],
  [0.137, 0.976],
  [0.028, -0.981],
  [-0.807, -0.5]
]

const glslVec2Array = (points: number[][]) => points.map(([x, y]) => `vec2(${x!.toFixed(3)}, ${y!.toFixed(3)})`).join(',\n    ')

/** Vertex chunk. Requires u_originDelta and u_cameraOriginFrac declared before it. */
export const SUN_SHADOW_VERTEX_GLSL = /* glsl */ `
#if defined(SUN_SHADOWS) || defined(SHADOW_CASTER)
vec3 shadowSpacePos(vec3 relativePos) {
    return relativePos - u_originDelta + u_cameraOriginFrac;
}
#endif

#ifdef SHADOW_CASTER
uniform mat4 u_lightViewProj;
#endif

#ifdef SUN_SHADOWS
uniform mat4 u_shadowMatrix;
/** Receivers look up the map this far along their normal (cubes only), kills acne on lit faces. */
uniform float u_shadowNormalOffset;
out vec3 v_shadowCoord;
out float v_shadowDist;

void writeSunShadowVaryings(vec3 relativePos, vec3 normal) {
    v_shadowCoord = (u_shadowMatrix * vec4(shadowSpacePos(relativePos) + normal * u_shadowNormalOffset, 1.0)).xyz;
    v_shadowDist = length(relativePos.xz);
}
#endif
`

/** Fragment chunk: `float sunShadowAmount(float facingSun)` → 0 lit … 1 fully shadowed. */
export const SUN_SHADOW_FRAGMENT_GLSL = /* glsl */ `
#ifdef SUN_SHADOWS
uniform highp sampler2DShadow u_shadowMap;
/** x: strength (0 at night), y: 1 / map size, z: fade start, w: fade end (blocks from the camera) */
uniform vec4 u_shadowParams;
/** x: constant depth bias, y: max slope bias (depth units) */
uniform vec2 u_shadowBias;
uniform vec3 u_sunDir;
in vec3 v_shadowCoord;
in float v_shadowDist;

#ifdef SUN_SHADOWS_SOFT
const vec2 SHADOW_DISK[16] = vec2[16](
    ${glslVec2Array(SOFT_DISK)}
);
const float SHADOW_FILTER_TEXELS = 2.5;
#else
const float SHADOW_FILTER_TEXELS = 1.0;
#endif

float sunShadowAmount(float facingSun) {
    vec3 coord = v_shadowCoord;
    // Derivatives before any branch (undefined in non-uniform control flow).
    vec3 dx = dFdx(coord);
    vec3 dy = dFdy(coord);

    float strength = u_shadowParams.x * (1.0 - smoothstep(u_shadowParams.z, u_shadowParams.w, v_shadowDist));
    if (strength <= 0.0) return 0.0;
    if (coord.x <= 0.0 || coord.y <= 0.0 || coord.x >= 1.0 || coord.y >= 1.0 || coord.z >= 1.0) return 0.0;

    // Receiver plane bias: how much depth changes per shadow texel across this surface, so grazing surfaces
    // (sun near the horizon) do not shadow themselves across the filter footprint.
    float det = dx.x * dy.y - dx.y * dy.x;
    vec2 depthSlope = abs(det) > 1e-14 ? vec2(dy.y * dx.z - dx.y * dy.z, dx.x * dy.z - dy.x * dx.z) / det : vec2(0.0);
    float texel = u_shadowParams.y;
    float slopeBias = min((abs(depthSlope.x) + abs(depthSlope.y)) * texel * SHADOW_FILTER_TEXELS, u_shadowBias.y);
    float depth = coord.z - u_shadowBias.x - slopeBias;

    float lit;
#ifdef SUN_SHADOWS_SOFT
    // Rotate the disk per pixel (interleaved gradient noise) so the 16 taps blur instead of banding.
    float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float angle = noise * 6.283185307;
    mat2 rotation = mat2(cos(angle), sin(angle), -sin(angle), cos(angle));
    lit = 0.0;
    for (int i = 0; i < 16; i++) {
        vec2 offset = rotation * SHADOW_DISK[i] * (SHADOW_FILTER_TEXELS * texel);
        lit += texture(u_shadowMap, vec3(coord.xy + offset, depth));
    }
    lit /= 16.0;
#else
    // Four hardware 2x2 PCF taps half a texel apart: a 3x3 tent.
    float h = 0.5 * texel;
    lit = 0.25 * (
        texture(u_shadowMap, vec3(coord.xy + vec2(-h, -h), depth)) +
        texture(u_shadowMap, vec3(coord.xy + vec2(h, -h), depth)) +
        texture(u_shadowMap, vec3(coord.xy + vec2(-h, h), depth)) +
        texture(u_shadowMap, vec3(coord.xy + vec2(h, h), depth))
    );
#endif
    // Faces turned away from the sun are in their own shadow, whatever the map says.
    return max(1.0 - lit, 1.0 - facingSun) * strength;
}

float shadowedSkyLight(float sky, float facingSun) {
    return sky * mix(1.0, ${SHADOWED_SKY_LIGHT.toFixed(2)}, sunShadowAmount(facingSun));
}
#endif
`

/** Depth pass fragment for shader cubes: only cuts out transparent texels (leaves). Depth is the plain ortho depth. */
export const CUBE_SHADOW_CASTER_FRAGMENT = /* glsl */ `
precision highp float;
precision highp int;

uniform sampler2D u_atlas;
in vec2 v_uv;
flat in int v_texIndex;
out vec4 FragColor;

void main() {
    ivec2 atlasSize = textureSize(u_atlas, 0);
    int tilesPerRow = atlasSize.x / 16;
    ivec2 tileOrigin = ivec2(v_texIndex % tilesPerRow, v_texIndex / tilesPerRow) * 16;
    if (texelFetch(u_atlas, tileOrigin + clamp(ivec2(v_uv * 16.0), ivec2(0), ivec2(15)), 0).a < 0.5) discard;
    FragColor = vec4(1.0);
}
`

/** Depth pass fragment for legacy geometry: same cutout threshold as the colour pass. */
export const LEGACY_SHADOW_CASTER_FRAGMENT = /* glsl */ `
precision highp float;

uniform sampler2D u_atlas;
in vec2 v_uv;
out vec4 FragColor;

void main() {
    if (texture(u_atlas, v_uv).a < 0.1) discard;
    FragColor = vec4(1.0);
}
`
