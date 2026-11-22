/**
 * New sections fade in, like vanilla's "Chunk Fade" (Options.chunkSectionFadeInTime, default 0.75 s): every column records
 * when it was first shown and the vertex shader reads that time. The opaque sections still fading are taken out of the terrain
 * pass and drawn after it with blending (ChunkMeshManager's fade pass, SECTION_FADE_SET_ALPHA): a real see-through fade over
 * whatever is behind. (An ordered dither looked like a dot grid on 1x displays. Vanilla mixes from the fog colour,
 * `mix(FogColor, color, chunkVisibility)`; with our thinner fog that read as white chunks flashing.) Only the camera's own column is not faded (within 8 blocks, full effect from 16). Vanilla spares everything within
 * 16 blocks and fades fully from 32 (terrain.vsh), but there chunks near the player already exist; here late chunks (generated or
 * meshed after the ones around them) are often revealed close to the camera and popped in without any fade.
 *
 * The futuristic reveal is the same timing with another look: cyan block edges first, then the blocks fade in.
 *
 * The start times live in a small ring texture (see sectionFade.ts): one float per section, 4 sections per RGBA texel
 * along x. A section is addressed by its world section coordinates: x and z modulo SECTION_FADE_RING, y from the lowest
 * section of the world. Defines: SECTION_FADE (on), SECTION_FADE_SCIFI (futuristic look).
 */

/** sections along x and z kept in the texture (render distance up to 31 chunks fits) */
export const SECTION_FADE_RING = 64
/** section rows along y (a 512-block world); sections above are not faded */
export const SECTION_FADE_Y = 32

/** Vertex chunk: `float sectionFadeVisibility(ivec3 section, vec2 columnCenterRel)`, 0 = just shown, 1 = fully visible. */
export const SECTION_FADE_VERTEX_GLSL = /* glsl */ `
#ifdef SECTION_FADE
uniform highp sampler2D u_sectionFadeTex;
/** x: now (seconds since the fade epoch), y: fade duration (seconds) */
uniform vec2 u_sectionFadeTime;
/** lowest section y of the world */
uniform int u_sectionFadeMinY;
/** render origin: whole sections and the rest (blocks), to find the section of legacy geometry */
uniform ivec3 u_sectionFadeOriginSection;
uniform vec3 u_sectionFadeOriginRem;
out float v_sectionFade;
#ifdef SECTION_FADE_SCIFI
/** position inside the block grid (fract = position in the block) */
out vec3 v_sectionFadeLocal;
#endif

/**
 * @param columnCenterRel horizontal position of the column's centre relative to the camera. The whole column uses it, so a column is
 *   always at one stage: with the per-vertex distance of vanilla, flying above terrain showed the near top of a column finished while
 *   its farther lower sections were still fading (fog-coloured or edges only: blocks on air)
 */
float sectionFadeVisibility(ivec3 section, vec2 columnCenterRel) {
    int sy = section.y - u_sectionFadeMinY;
    if (sy < 0 || sy >= ${SECTION_FADE_Y}) return 1.0;
    int sx = section.x & ${SECTION_FADE_RING - 1};
    int sz = section.z & ${SECTION_FADE_RING - 1};
    vec4 texel = texelFetch(u_sectionFadeTex, ivec2(sx >> 2, sz * ${SECTION_FADE_Y} + sy), 0);
    float start = dot(texel, vec4(equal(ivec4(0, 1, 2, 3), ivec4(sx & 3))));
    if (start <= 0.0) return 1.0;
    float visibility = clamp((u_sectionFadeTime.x - start) / max(u_sectionFadeTime.y, 0.001), 0.0, 1.0);
    // the column the camera is in does not fade (no dissolving blocks around the player), see above
    return mix(1.0, visibility, clamp((length(columnCenterRel) - 8.0) / 8.0, 0.0, 1.0));
}

/** section of legacy geometry from its origin relative to the render origin */
ivec3 sectionFadeSectionOf(vec3 originRel) {
    return ivec3(floor((originRel + u_sectionFadeOriginRem + 0.5) / 16.0)) + u_sectionFadeOriginSection;
}
#endif
`

/** Fragment chunk: `applySectionFade(inout vec4 color)` (may discard in the futuristic look). */
export const SECTION_FADE_FRAGMENT_GLSL = /* glsl */ `
#ifdef SECTION_FADE
in float v_sectionFade;

#ifdef SECTION_FADE_SCIFI
in vec3 v_sectionFadeLocal;
const vec3 SECTION_FADE_CYAN = vec3(0.05, 0.92, 0.93);
#endif

void applySectionFade(inout vec4 color) {
    float t = v_sectionFade;
    if (t >= 1.0) return;
#ifdef SECTION_FADE_SCIFI
    // distance to the nearest block edge on this face: on a face one axis is ~0, the edge distance is the middle one
    vec3 f = fract(v_sectionFadeLocal + 0.0001);
    vec3 d = min(f, 1.0 - f);
    float edge = d.x + d.y + d.z - min(d.x, min(d.y, d.z)) - max(d.x, max(d.y, d.z));
    float line = 1.0 - smoothstep(0.03, 0.07, edge);
    // first only the glowing edges (the rest of the block is not drawn yet), then the blocks fill in
    if (t < 0.35 && line < 0.5) discard;
    float solid = smoothstep(0.35, 1.0, t);
    vec3 glow = SECTION_FADE_CYAN * (0.35 + 0.9 * line);
    color.rgb = mix(glow, color.rgb, solid) + SECTION_FADE_CYAN * line * 0.6 * (1.0 - solid);
#elif defined(SECTION_FADE_SET_ALPHA)
    // fade pass (opaque geometry of the sections still fading, drawn after the terrain with blending): the block over what is
    // behind it (sky, terrain), no colour of its own (fading from the fog colour like vanilla read as white chunks flashing)
    color.a = t;
#elif defined(SECTION_FADE_MUL_ALPHA)
    // already blended geometry (water, glass): fades with its own alpha
    color.a *= t;
#endif
    // otherwise (opaque pass of the global buffers): sections that are still fading are drawn by the fade pass, not here
}
#endif
`
