/**
 * Colour grading of world blocks, done inside the block shaders (`#define BLOCK_GRADING`): no extra pass, no offscreen
 * target, so it costs a few ALU ops per block pixel on every device, phones included.
 *
 * It runs on the lit block colour BEFORE fog. Distant blocks therefore fade into the (ungraded) fog and sky colour
 * without a seam, and the grade fades with distance like atmospheric haze. Entities, the hand, the sky and clouds are
 * not graded.
 */

export type ColorGradingPreset = 'off' | 'warm' | 'cinematic' | 'vivid'

export type GradingParams = {
  exposure: number
  contrast: number
  saturation: number
  /** 0 = linear, 1 = full filmic curve */
  filmic: number
  /** white balance multiplier */
  tint: [number, number, number]
  /** added in the dark tones */
  shadowTint: [number, number, number]
  /** multiplier in the bright tones */
  highlightTint: [number, number, number]
}

export const COLOR_GRADING_PRESETS: Record<Exclude<ColorGradingPreset, 'off'>, GradingParams> = {
  // Golden sunlight: warmer white balance and slightly richer colours. No tone curve, so brightness stays vanilla
  // (caves and nights keep their darkness); this is the default look.
  warm: {
    exposure: 1,
    contrast: 1.03,
    saturation: 1.12,
    filmic: 0,
    tint: [1.05, 1, 0.92],
    shadowTint: [0, 0, 0.012],
    highlightTint: [1.03, 1, 0.95]
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

/** Fragment shader chunk: declares the uniforms and `vec3 colorGrade(vec3)`, only compiled with BLOCK_GRADING. */
export const COLOR_GRADING_GLSL = /* glsl */ `
#ifdef BLOCK_GRADING
uniform float u_gradeExposure;
uniform float u_gradeContrast;
uniform float u_gradeSaturation;
uniform float u_gradeFilmic;
uniform vec3 u_gradeTint;
uniform vec3 u_gradeShadowTint;
uniform vec3 u_gradeHighlightTint;

// Filmic curve: rational fit of the ACES reference tone curve (Narkowicz 2015), maps 0..~1.5 into 0..1.
vec3 gradeFilmicCurve(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

vec3 colorGrade(vec3 color) {
    color *= u_gradeTint;
    color = mix(color, gradeFilmicCurve(color * u_gradeExposure), u_gradeFilmic);
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(vec3(luma), color, u_gradeSaturation);
    color = (color - 0.5) * u_gradeContrast + 0.5;
    float tone = smoothstep(0.0, 1.0, luma);
    color += u_gradeShadowTint * (1.0 - tone);
    color *= mix(vec3(1.0), u_gradeHighlightTint, tone);
    return clamp(color, 0.0, 1.0);
}
#endif
`

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const smoothstep01 = (x: number) => {
  const t = clamp01(x)
  return t * t * (3 - 2 * t)
}
const filmic = (x: number) => clamp01((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14))

/** CPU mirror of `colorGrade` in COLOR_GRADING_GLSL (tests, and checking the shader on a real GPU). */
export function colorGradeCpu(input: readonly [number, number, number], p: GradingParams): [number, number, number] {
  const tinted = input.map((v, i) => v * p.tint[i]!)
  const mixed = tinted.map(v => v + (filmic(v * p.exposure) - v) * p.filmic)
  const luma = mixed[0]! * 0.2126 + mixed[1]! * 0.7152 + mixed[2]! * 0.0722
  const tone = smoothstep01(luma)
  return mixed.map((v, i) => {
    let c = luma + (v - luma) * p.saturation
    c = (c - 0.5) * p.contrast + 0.5
    c += p.shadowTint[i]! * (1 - tone)
    c *= 1 + (p.highlightTint[i]! - 1) * tone
    return clamp01(c)
  }) as [number, number, number]
}
