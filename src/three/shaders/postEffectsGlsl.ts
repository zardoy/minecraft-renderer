import { EMISSION_SCALE } from './blockEmissionGlsl'

/**
 * Full-screen passes of the post pipeline (postProcessing.ts). All GLSL3, drawn with three's FullScreenQuad
 * (one triangle covering clip space, uv 0..1).
 */

export const FULLSCREEN_VERTEX = /* glsl */ `
out vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

const DECODE_EMISSION = /* glsl */ `
// Inverse of blockEmissionGlsl.ts: alpha → emission 0..1 (hot surfaces live below 0.5).
float decodeEmission(float a) {
    return a < 0.5 ? clamp(1.0 - a / ${EMISSION_SCALE.toFixed(2)}, 0.0, 1.0) : clamp((1.0 - a) / ${EMISSION_SCALE.toFixed(2)}, 0.0, 1.0);
}
`

/** Half resolution: 2x2 box of the emissive part of the frame (sky excluded by depth). */
export const BLOOM_PREFILTER_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform vec2 sceneTexel;
in vec2 vUv;
out vec4 outColor;
${DECODE_EMISSION}
vec3 emissive(vec2 uv) {
    vec4 c = texture(tScene, uv);
    float sky = step(0.999999, texture(tDepth, uv).r);
    return c.rgb * decodeEmission(c.a) * (1.0 - sky);
}
void main() {
    vec2 h = 0.5 * sceneTexel;
    vec3 sum = emissive(vUv + vec2(-h.x, -h.y)) + emissive(vUv + vec2(h.x, -h.y)) + emissive(vUv + vec2(-h.x, h.y)) + emissive(vUv + vec2(h.x, h.y));
    outColor = vec4(sum * 0.25, 1.0);
}
`

/** Separable 9-tap gaussian (linear sampling: 5 fetches). */
export const BLUR_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tSource;
uniform vec2 direction; // texel step along the blur axis
in vec2 vUv;
out vec4 outColor;
void main() {
    vec3 sum = texture(tSource, vUv).rgb * 0.2270270270;
    sum += texture(tSource, vUv + direction * 1.3846153846).rgb * 0.3162162162;
    sum += texture(tSource, vUv - direction * 1.3846153846).rgb * 0.3162162162;
    sum += texture(tSource, vUv + direction * 3.2307692308).rgb * 0.0702702703;
    sum += texture(tSource, vUv - direction * 3.2307692308).rgb * 0.0702702703;
    outColor = vec4(sum, 1.0);
}
`

/** 2x2 box downsample. */
export const DOWNSAMPLE_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tSource;
uniform vec2 sourceTexel;
in vec2 vUv;
out vec4 outColor;
void main() {
    vec2 h = 0.5 * sourceTexel;
    vec3 sum = texture(tSource, vUv + vec2(-h.x, -h.y)).rgb + texture(tSource, vUv + vec2(h.x, -h.y)).rgb
        + texture(tSource, vUv + vec2(-h.x, h.y)).rgb + texture(tSource, vUv + vec2(h.x, h.y)).rgb;
    outColor = vec4(sum * 0.25, 1.0);
}
`

export const GOD_RAYS_SAMPLES = 32

/**
 * Screen-space light scattering, half resolution: march from the pixel towards the sun on screen and accumulate
 * sky pixels near the sun (terrain and clouds write depth, so they block the rays).
 */
export const GOD_RAYS_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tDepth;
uniform vec2 sunUv;
uniform float aspect;
in vec2 vUv;
out vec4 outColor;
void main() {
    vec2 toSun = sunUv - vUv;
    vec2 stepUv = toSun / float(${GOD_RAYS_SAMPLES});
    // Per-pixel jitter (interleaved gradient noise) trades banding for fine noise.
    float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    vec2 uv = vUv + stepUv * jitter;
    float sum = 0.0;
    float weight = 1.0;
    for (int i = 0; i < ${GOD_RAYS_SAMPLES}; i++) {
        float sky = step(0.999999, texture(tDepth, uv).r);
        vec2 d = (uv - sunUv) * vec2(aspect, 1.0);
        float glow = max(0.0, 1.0 - length(d) / 0.45);
        sum += sky * glow * glow * weight;
        weight *= 0.95;
        uv += stepUv;
    }
    outColor = vec4(vec3(sum / float(${GOD_RAYS_SAMPLES})), 1.0);
}
`

export const MOTION_BLUR_SAMPLES = 8

/**
 * World composite: distortion (underwater wobble, heat haze), camera motion blur, bloom and god rays.
 * Defines: DISTORTION, MOTION_BLUR, BLOOM, GOD_RAYS.
 */
export const WORLD_COMPOSITE_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform vec2 sceneTexel;
uniform float time;
in vec2 vUv;
out vec4 outColor;

#ifdef DISTORTION
uniform float wobble;      // underwater, 0..1
uniform float heatGlobal;  // nether / on fire, 0..1
uniform float heatLocal;   // above hot surfaces on screen, 0..1 (0 = off)
#endif

#ifdef MOTION_BLUR
uniform mat4 viewToPrevClip;
uniform vec2 projectionScale; // projectionMatrix[0][0], [1][1]
uniform float logFar;         // log2(far + 1): depth is logarithmic
uniform float blurScale;
#endif

#ifdef BLOOM
uniform sampler2D tBloomHalf;
uniform sampler2D tBloomQuarter;
uniform float bloomIntensity;
#endif

#ifdef GOD_RAYS
uniform sampler2D tRays;
uniform vec3 raysColor;
#endif

float noise(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

void main() {
    vec2 uv = vUv;

#ifdef DISTORTION
    vec2 offset = vec2(0.0);
    if (wobble > 0.0) {
        offset += wobble * 0.004 * vec2(sin(uv.y * 24.0 + time * 1.7), cos(uv.x * 19.0 + time * 1.3));
    }
    float heat = heatGlobal;
    if (heatLocal > 0.0) {
        // Rising air: look a little below this pixel for hot surfaces (alpha band < 0.5).
        float hot = 0.0;
        for (int i = 1; i <= 4; i++) {
            hot = max(hot, step(texture(tScene, uv - vec2(0.0, 0.012 * float(i))).a, 0.499) * (1.0 - 0.18 * float(i)));
        }
        heat = max(heat, hot * heatLocal);
    }
    if (heat > 0.0) {
        offset.x += heat * 0.0025 * sin(uv.y * 90.0 + time * 6.0) * sin(uv.x * 37.0 + time * 2.3);
        offset.y += heat * 0.0015 * sin(uv.x * 70.0 - time * 5.0);
    }
    uv = clamp(uv + offset, sceneTexel, 1.0 - sceneTexel);
#endif

    vec3 color;
#ifdef MOTION_BLUR
    // Reproject this pixel with the previous camera (world assumed static) to get its screen velocity.
    float depth = texture(tDepth, uv).r;
    float viewDepth = exp2(depth * logFar) - 1.0;
    vec2 ndc = uv * 2.0 - 1.0;
    vec4 viewPos = vec4(ndc.x * viewDepth / projectionScale.x, ndc.y * viewDepth / projectionScale.y, -viewDepth, 1.0);
    vec4 prevClip = viewToPrevClip * viewPos;
    vec2 velocity = vec2(0.0);
    if (prevClip.w > 0.0) velocity = uv - (prevClip.xy / prevClip.w * 0.5 + 0.5);
    velocity *= blurScale;
    float speed = length(velocity);
    if (speed > 0.04) velocity *= 0.04 / speed;
    float start = noise(gl_FragCoord.xy) - 0.5;
    color = vec3(0.0);
    for (int i = 0; i < ${MOTION_BLUR_SAMPLES}; i++) {
        float t = (float(i) + start) / float(${MOTION_BLUR_SAMPLES}) - 0.5;
        color += texture(tScene, clamp(uv + velocity * t, sceneTexel, 1.0 - sceneTexel)).rgb;
    }
    color /= float(${MOTION_BLUR_SAMPLES});
#else
    color = texture(tScene, uv).rgb;
#endif

#ifdef BLOOM
    color += bloomIntensity * (texture(tBloomHalf, uv).rgb + 1.5 * texture(tBloomQuarter, uv).rgb);
#endif
#ifdef GOD_RAYS
    color += raysColor * texture(tRays, uv).r;
#endif
    outColor = vec4(color, 1.0);
}
`

/**
 * Final pass over the whole frame (world + hand): colour grading with a filmic tone curve, and vignette.
 * Defines: GRADING, VIGNETTE. With neither it is a plain copy.
 */
export const FINAL_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tSource;
uniform float aspect;
in vec2 vUv;
out vec4 outColor;

#ifdef GRADING
uniform float exposure;
uniform float contrast;
uniform float saturation;
uniform float filmic;      // 0 = linear, 1 = full filmic curve
uniform vec3 tint;         // white balance multiplier
uniform vec3 shadowTint;   // added in the dark tones
uniform vec3 highlightTint; // multiplier in the bright tones

// Filmic curve: rational fit of the ACES reference tone curve (Narkowicz 2015), maps 0..~1.5 into 0..1.
vec3 filmicCurve(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
#endif

#ifdef VIGNETTE
uniform float vignette;
#endif

void main() {
    vec3 color = texture(tSource, vUv).rgb;
#ifdef GRADING
    color *= tint;
    color = mix(color, filmicCurve(color * exposure), filmic);
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(vec3(luma), color, saturation);
    color = (color - 0.5) * contrast + 0.5;
    float tone = smoothstep(0.0, 1.0, luma);
    color += shadowTint * (1.0 - tone);
    color *= mix(vec3(1.0), highlightTint, tone);
    color = clamp(color, 0.0, 1.0);
#endif
#ifdef VIGNETTE
    vec2 d = (vUv - 0.5) * vec2(aspect, 1.0);
    color *= 1.0 - vignette * smoothstep(0.35, 0.95, length(d));
#endif
    outColor = vec4(color, 1.0);
}
`

export type ColorGradingPreset = 'off' | 'warm' | 'cinematic' | 'vivid'

type GradingParams = {
  exposure: number
  contrast: number
  saturation: number
  filmic: number
  tint: [number, number, number]
  shadowTint: [number, number, number]
  highlightTint: [number, number, number]
}

export const COLOR_GRADING_PRESETS: Record<Exclude<ColorGradingPreset, 'off'>, GradingParams> = {
  // Golden sunlight: warmer white balance, slightly richer colours, gentle filmic roll-off.
  warm: {
    exposure: 1.25,
    contrast: 1.04,
    saturation: 1.1,
    filmic: 0.6,
    tint: [1.06, 1, 0.9],
    shadowTint: [0, 0.005, 0.02],
    highlightTint: [1.03, 1, 0.94]
  },
  // Teal shadows, warm highlights, more contrast, a bit less saturation.
  cinematic: {
    exposure: 1.3,
    contrast: 1.12,
    saturation: 0.92,
    filmic: 1,
    tint: [1.02, 1, 0.97],
    shadowTint: [-0.01, 0.012, 0.03],
    highlightTint: [1.05, 1, 0.92]
  },
  vivid: {
    exposure: 1.15,
    contrast: 1.08,
    saturation: 1.28,
    filmic: 0.35,
    tint: [1, 1, 1],
    shadowTint: [0, 0, 0],
    highlightTint: [1, 1, 1]
  }
}
