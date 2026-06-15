import * as THREE from 'three'

// Face order: UP=0, DOWN=1, EAST=2, WEST=3, SOUTH=4, NORTH=5
// matches WASM mesher face order (mesher.rs FACE_NAMES)

const vertexShader = /* glsl */ `
precision highp float;
precision highp int;

layout(location = 0) in uint a_w0;
layout(location = 1) in uint a_w1;
layout(location = 2) in uint a_w2;
layout(location = 3) in uint a_w3;

// World camera position split for stable float32 subtraction (see relativePos below).
uniform ivec3 u_sectionOriginRel;
uniform vec3 u_originDelta;
uniform vec3 u_cameraOriginFrac;

out float v_light;
out float v_ao;
out vec2 v_uv;
flat out int v_texIndex;
flat out int v_tintIndex;
flat out int v_faceId;

// Logarithmic depth buffer support: Three.js injects USE_LOGARITHMIC_DEPTH_BUFFER when the
// renderer has logarithmicDepthBuffer: true. Standard Three.js shader chunks
// rewrite gl_FragDepth via these varyings — if we don't, our linear gl_FragCoord.z
// fails depth test vs sibling meshes that DO write log depth (we'd be invisible).
// The renderer always uses a perspective camera, so we skip the vIsPerspective
// varying and always emit log depth — avoids the smooth-interpolation precision
// issue where vIsPerspective lands on 0.9999… on some pixels and silently falls
// back to linear gl_FragCoord.z, producing a white-noise z-fight pattern against
// neighbouring meshes.
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
out float vFragDepth;
#endif

// Fog support: Three.js injects USE_FOG when scene.fog is set AND material.fog === true.
// Standard MeshBasicMaterial enables this by default; ShaderMaterial does NOT, which is
// why our blocks looked unaffected by distance haze while neighbouring legacy meshes
// faded into the fog. createCubeBlockMaterial sets fog: true and merges
// UniformsLib.fog so Three.js can auto-refresh the fog uniforms each frame.
#ifdef USE_FOG
out float vFogDepth;
#endif

// projectionMatrix / modelViewMatrix: injected by Three.js ShaderMaterial (do not redeclare)

// BASE, DU, DV per face (UP=0, DOWN=1, EAST=2, WEST=3, SOUTH=4, NORTH=5)
// position = BASE[faceId] + u * DU[faceId] + v * DV[faceId]
const vec3 BASE[6] = vec3[6](
    vec3(0.0, 1.0, 1.0),  // UP    (+Y)
    vec3(1.0, 0.0, 1.0),  // DOWN  (-Y)
    vec3(1.0, 1.0, 1.0),  // EAST  (+X)
    vec3(0.0, 1.0, 0.0),  // WEST  (-X)
    vec3(0.0, 1.0, 1.0),  // SOUTH (+Z)
    vec3(1.0, 1.0, 0.0)   // NORTH (-Z)
);

const vec3 DU[6] = vec3[6](
    vec3( 1.0, 0.0,  0.0),  // UP
    vec3(-1.0, 0.0,  0.0),  // DOWN
    vec3( 0.0,-1.0,  0.0),  // EAST
    vec3( 0.0,-1.0,  0.0),  // WEST
    vec3( 1.0, 0.0,  0.0),  // SOUTH
    vec3(-1.0, 0.0,  0.0)   // NORTH
);

const vec3 DV[6] = vec3[6](
    vec3(0.0, 0.0, -1.0),  // UP
    vec3(0.0, 0.0, -1.0),  // DOWN
    vec3(0.0, 0.0, -1.0),  // EAST
    vec3(0.0, 0.0,  1.0),  // WEST
    vec3(0.0,-1.0,  0.0),  // SOUTH
    vec3(0.0,-1.0,  0.0)   // NORTH
);

// Per-(triangle, corner) -> quad corner index (vi), one table per diagonal mode.
// Normal: T0=[0,1,2], T1=[2,1,3]. Flipped: T0=[0,3,2], T1=[0,1,3].
const int VI_NORMAL[6]  = int[6](0, 1, 2, 2, 1, 3);
const int VI_FLIPPED[6] = int[6](0, 3, 2, 0, 1, 3);

void main() {
    // Empty slot sentinel (freed section range in global buffer)
    if (((a_w2 >> 18u) & 0x1u) != 0u) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
    }

    // Non-indexed geometry: 6 vertices per face instance (2 triangles)
    int vi_total = gl_VertexID % 6;
    int triangle = vi_total / 3;      // 0 or 1
    int corner = vi_total - triangle * 3; // 0,1,2

    uint faceId = (a_w0 >> 12u) & 0x7u;

    // Diagonal flip flag from word2 bit 12
    uint diagonalFlag = (a_w2 >> 12u) & 0x1u;

    // SOUTH/NORTH (faceId 4/5) need reversed triangle winding so FrontSide culling
    // shows them. Swap corner 1 <-> 2 within each triangle BEFORE the quad-corner
    // lookup; this reverses winding while keeping all 4 quad corners covered.
    // (The previous override of viPos only collapsed both triangles to the same
    // 3 corners, dropping quad corner vi=3 entirely.)
    int effCorner = corner;
    if (faceId == 4u || faceId == 5u) {
        if (corner == 1) effCorner = 2;
        else if (corner == 2) effCorner = 1;
    }
    int effViTotal = triangle * 3 + effCorner;
    int vi = (diagonalFlag == 0u) ? VI_NORMAL[effViTotal] : VI_FLIPPED[effViTotal];

    float u = float(vi & 1);
    float v = float((vi >> 1) & 1);

    // --- word0: position + face + tint + AO ---
    uint lx     = (a_w0)        & 0xFu;
    uint ly     = (a_w0 >>  4u) & 0xFu;
    uint lz     = (a_w0 >>  8u) & 0xFu;
    uint tint   = (a_w0 >> 15u) & 0xFFu;

    // AO: 2 bits per corner starting at bit 23
    uint aoLevel = (a_w0 >> uint(23 + vi * 2)) & 0x3u;
    v_ao = (float(aoLevel) + 1.0) / 4.0;

    // --- word1: combined smooth light (8 bits per corner) ---
    uint lightRaw = (a_w1 >> uint(vi * 8)) & 0xFFu;
    v_light = float(lightRaw) / 255.0;

    // --- word2: texture index ---
    v_texIndex = int(a_w2 & 0xFFFu);
    v_tintIndex = int(tint);
    v_faceId = int(faceId);

    // --- Per-face UV transform (legacy elemFaces + down +180°) ---
    if (faceId == 0u) {
        v_uv = vec2(u, 1.0 - v);
    } else if (faceId == 1u) {
        v_uv = vec2(1.0 - u, 1.0 - v);
    } else if (faceId == 2u || faceId == 3u) {
        v_uv = vec2(v, u);
    } else if (faceId == 4u) {
        v_uv = vec2(u, v);
    } else { // faceId == 5u
        v_uv = vec2(1.0 - u, v);
    }

    // --- Position: section base (multiples of 16) + face quad + block-local 0..15 ---
    // Must mirror WORD2/WORD3 constants in TS (GLSL cannot import them).
    int sX = int((a_w3 & 0xFFFFu) | (((a_w2 >> 19u) & 0x3Fu) << 16u)) - 2097152;
    int sZ = int(((a_w3 >> 16u) & 0xFFFFu) | (((a_w2 >> 25u) & 0x3Fu) << 16u)) - 2097152;
    int sY = int((a_w2 >> 13u) & 0x1Fu) - 4;
    int sXr = sX - u_sectionOriginRel.x;
    int sYr = sY - u_sectionOriginRel.y;
    int sZr = sZ - u_sectionOriginRel.z;
    vec3 sectionBase = vec3(float(sXr * 16), float(sYr * 16), float(sZr * 16));
    vec3 facePos = BASE[faceId] + u * DU[faceId] + v * DV[faceId];
    vec3 blockLocal = vec3(float(lx), float(ly), float(lz));
    vec3 relativePos = sectionBase + u_originDelta + facePos + blockLocal - u_cameraOriginFrac;
    vec4 mvPosition = modelViewMatrix * vec4(relativePos, 1.0);
    gl_Position = projectionMatrix * mvPosition;

#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
    // Mirrors three.js logdepthbuf_vertex chunk (EXT path: fragment writes gl_FragDepth).
    vFragDepth = 1.0 + gl_Position.w;
#endif

#ifdef USE_FOG
    // Mirrors three.js fog_vertex chunk: view-space depth (positive in front of camera).
    vFogDepth = -mvPosition.z;
#endif
}
`

const fragmentShader = /* glsl */ `
precision highp float;
precision highp int;

uniform sampler2D u_atlas;
uniform sampler2D u_tintPalette;
/** 0=normal 1=holes 2=tileIndex 3=faceId 4=atlasAlpha */
uniform float u_debugMode;

in float v_light;
in float v_ao;
in vec2 v_uv;
flat in int v_texIndex;
flat in int v_tintIndex;
flat in int v_faceId;

#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
uniform float logDepthBufFC;
in float vFragDepth;
#endif

#ifdef USE_FOG
uniform vec3 fogColor;
in float vFogDepth;
#ifdef FOG_EXP2
uniform float fogDensity;
#else
uniform float fogNear;
uniform float fogFar;
#endif
#endif

out vec4 FragColor;

void writeLogDepth() {
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
    // Camera is always perspective; skip the vIsPerspective branch from three.js
    // standard chunks to avoid float-precision z-fight against neighbouring meshes.
    gl_FragDepth = log2(vFragDepth) * logDepthBufFC * 0.5;
#endif
}

// Mirrors three.js fog_fragment chunk: applied after lighting/tint on the final colour.
void applyFog() {
#ifdef USE_FOG
#ifdef FOG_EXP2
    float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
#else
    float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
#endif
    FragColor.rgb = mix(FragColor.rgb, fogColor, fogFactor);
#endif
}

void main() {
    // Atlas sample (pixelated, no filtering)
    ivec2 atlasSize = textureSize(u_atlas, 0);
    int tilesPerRow = atlasSize.x / 16;
    ivec2 tileOrigin = ivec2(v_texIndex % tilesPerRow, v_texIndex / tilesPerRow) * 16;
    ivec2 texel = tileOrigin + clamp(ivec2(v_uv * 16.0), ivec2(0), ivec2(15));
    vec4 baseColor = texelFetch(u_atlas, texel, 0);

    if (u_debugMode > 3.5) {
        FragColor = vec4(vec3(baseColor.a), 1.0);
        writeLogDepth();
        return;
    }

    if (u_debugMode > 2.5) {
        if (v_faceId == 0) FragColor = vec4(1.0, 0.0, 0.0, 1.0);
        else if (v_faceId == 1) FragColor = vec4(0.0, 1.0, 0.0, 1.0);
        else if (v_faceId == 2) FragColor = vec4(0.0, 0.0, 1.0, 1.0);
        else if (v_faceId == 3) FragColor = vec4(1.0, 1.0, 0.0, 1.0);
        else if (v_faceId == 4) FragColor = vec4(1.0, 0.0, 1.0, 1.0);
        else FragColor = vec4(0.0, 1.0, 1.0, 1.0);
        writeLogDepth();
        return;
    }

    if (u_debugMode > 1.5) {
        float t = float(v_texIndex) / 4095.0;
        FragColor = vec4(t, fract(float(v_texIndex) / 64.0), 0.0, 1.0);
        writeLogDepth();
        return;
    }

    if (baseColor.a < 0.01) {
        if (u_debugMode > 0.5) {
            FragColor = vec4(1.0, 0.0, 0.0, 1.0);
            writeLogDepth();
            return;
        }
        discard;
    }

    // Tint from palette (256x1 RGBA texture, index 0 = white [1,1,1])
    vec3 tint = texelFetch(u_tintPalette, ivec2(v_tintIndex, 0), 0).rgb;

    // Combined light * AO, identity brightness curve (no mcBrightness) to match the
    // legacy CPU mesher output 1:1.
    float brightness = v_light * v_ao;

    // Opaque full cubes: always alpha 1 (legacy uses cutout material; avoids seeing blocks behind)
    FragColor = vec4(baseColor.rgb * tint * brightness, 1.0);
    applyFog();
    writeLogDepth();
}
`

export function createCubeBlockMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        // Merge UniformsLib.fog (fogColor/fogNear/fogFar/fogDensity) so Three.js's
        // WebGLMaterials.refreshFogUniforms can keep them in sync with scene.fog each
        // frame — only happens for materials with \`fog: true\` set below.
        uniforms: THREE.UniformsUtils.merge([
            THREE.UniformsLib.fog,
            {
                u_atlas: { value: null },
                u_tintPalette: { value: null },
                u_debugMode: { value: 0 },
                u_sectionOriginRel: { value: new THREE.Vector3(0, 0, 0) },
                u_originDelta: { value: new THREE.Vector3() },
                u_cameraOriginFrac: { value: new THREE.Vector3() },
            },
        ]),
        // Opaque full cubes — WASM mesher already culls interior faces between
        // solid neighbors, so no z-fighting between own faces. Keep NoBlending so
        // the alpha=1 path writes pure pixels and depth.
        transparent: false,
        depthWrite: true,
        depthTest: true,
        blending: THREE.NoBlending,
        glslVersion: THREE.GLSL3,
        // Required for Three.js to inject \`#define USE_FOG\` (and refresh fog uniforms).
        fog: true,
    })
}

// Three geometry constants: 6 vertices per face (2 triangles, un-indexed)
export const VERTICES_PER_FACE = 6

/** Section index units for render origin R (R is always a multiple of 16). */
export function computeSectionOriginRel (renderOrigin: { x: number, y: number, z: number }): {
  x: number
  y: number
  z: number
} {
  return {
    x: Math.round(renderOrigin.x / 16),
    y: Math.round(renderOrigin.y / 16),
    z: Math.round(renderOrigin.z / 16),
  }
}

// Word layout constants (for encoding/decoding instances)
export const WORD0 = {
    LX_BITS: 4,
    LY_BITS: 4,
    LZ_BITS: 4,
    FACE_BITS: 3,
    TINT_BITS: 8,
    AO_BITS_PER_CORNER: 2,
    NUM_CORNERS: 4,
    // Bit offsets
    LX_SHIFT: 0,
    LY_SHIFT: 4,
    LZ_SHIFT: 8,
    FACE_SHIFT: 12,
    TINT_SHIFT: 15,
    AO_SHIFT: 23,
    TRANSPARENT_SHIFT: 31,
} as const

export const WORD1 = {
    LIGHT_BITS_PER_CORNER: 8,
    NUM_CORNERS: 4,
} as const

export const WORD2 = {
    TEX_INDEX_BITS: 12,
    DIAGONAL_FLAG_SHIFT: 12,
    SECTION_Y_SHIFT: 13,
    SECTION_Y_BITS: 5,
    EMPTY_SHIFT: 18,
    SECTION_X_HI_SHIFT: 19,
    SECTION_Z_HI_SHIFT: 25,
    SECTION_HI_BITS: 6,
    SPARE_BITS: 1,
} as const

/** Section base X/Z: low 16 bits in a_w3, high 6 in a_w2 (22-bit biased section index). */
export const WORD3 = {
    SECTION_BITS: 22,
    SECTION_MASK: (1 << 22) - 1,
    LO_BITS: 16,
    HI_BITS: 6,
    SECTION_BIAS: 2097152,
} as const
