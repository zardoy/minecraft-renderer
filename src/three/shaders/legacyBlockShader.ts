import * as THREE from 'three'

export type RenderOrigin = { x: number, y: number, z: number }

export function computeCameraRelativeUniforms (
  renderOrigin: RenderOrigin,
  x: number,
  y: number,
  z: number,
): { originDelta: RenderOrigin, cameraOriginFrac: RenderOrigin } {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const iz = Math.floor(z)
  return {
    originDelta: {
      x: renderOrigin.x - ix,
      y: renderOrigin.y - iy,
      z: renderOrigin.z - iz,
    },
    cameraOriginFrac: {
      x: x - ix,
      y: y - iy,
      z: z - iz,
    },
  }
}

const vertexShader = /* glsl */ `
precision highp float;

uniform vec3 u_originDelta;
uniform vec3 u_cameraOriginFrac;

// position, uv, color: declared by Three.js shader chunks (vertexColors → USE_COLOR).
out vec3 vColor;
out vec2 v_uv;

#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
out float vFragDepth;
#endif

#ifdef USE_FOG
out float vFogDepth;
#endif

void main() {
    vec3 relativePos = modelMatrix[3].xyz + u_originDelta + position - u_cameraOriginFrac;
    vec4 mvPosition = viewMatrix * vec4(relativePos, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    vColor = color;
    v_uv = uv;

#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
    vFragDepth = 1.0 + gl_Position.w;
#endif

#ifdef USE_FOG
    vFogDepth = -mvPosition.z;
#endif
}
`

const fragmentShader = /* glsl */ `
precision highp float;

uniform sampler2D u_atlas;

in vec3 vColor;
in vec2 v_uv;

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
    gl_FragDepth = log2(vFragDepth) * logDepthBufFC * 0.5;
#endif
}

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
    vec4 texColor = texture(u_atlas, v_uv);
    vec3 rgb = texColor.rgb * vColor;
    float alpha = texColor.a;

    if (alpha < 0.1) {
        discard;
    }

    FragColor = vec4(rgb, alpha);
    applyFog();
    writeLogDepth();
}
`

const globalVertexShader = /* glsl */ `
precision highp float;

uniform vec3 u_originDelta;
uniform vec3 u_cameraOriginFrac;

in vec3 a_origin;

// position, uv, color: declared by Three.js shader chunks (vertexColors → USE_COLOR).
out vec3 vColor;
out vec2 v_uv;

#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
out float vFragDepth;
#endif

#ifdef USE_FOG
out float vFogDepth;
#endif

void main() {
    vec3 relativePos = a_origin + u_originDelta + position - u_cameraOriginFrac;
    vec4 mvPosition = viewMatrix * vec4(relativePos, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    vColor = color;
    v_uv = uv;

#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
    vFragDepth = 1.0 + gl_Position.w;
#endif

#ifdef USE_FOG
    vFogDepth = -mvPosition.z;
#endif
}
`

export function createLegacyBlockMaterial (): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        u_atlas: { value: null },
        u_originDelta: { value: new THREE.Vector3() },
        u_cameraOriginFrac: { value: new THREE.Vector3() },
      },
    ]),
    transparent: true,
    depthWrite: true,
    depthTest: true,
    vertexColors: true,
    glslVersion: THREE.GLSL3,
    fog: true,
  })
}

/** Global opaque legacy buffer — per-vertex section origin via a_origin. */
export function createGlobalLegacyBlockMaterial (): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: globalVertexShader,
    fragmentShader,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        u_atlas: { value: null },
        u_originDelta: { value: new THREE.Vector3() },
        u_cameraOriginFrac: { value: new THREE.Vector3() },
      },
    ]),
    transparent: false,
    depthWrite: true,
    depthTest: true,
    vertexColors: true,
    glslVersion: THREE.GLSL3,
    fog: true,
  })
}

/** Global transparent blend buffer — same shaders as opaque global, blend material flags. */
export function createGlobalLegacyBlendMaterial (): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: globalVertexShader,
    fragmentShader,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        u_atlas: { value: null },
        u_originDelta: { value: new THREE.Vector3() },
        u_cameraOriginFrac: { value: new THREE.Vector3() },
      },
    ]),
    transparent: true,
    depthWrite: true,
    depthTest: true,
    vertexColors: true,
    glslVersion: THREE.GLSL3,
    fog: true,
  })
}

/** Render-origin + fractional camera split — matches GlobalBlockBuffer.setCameraOrigin. */
export function setLegacyCameraOrigin (
  material: THREE.ShaderMaterial,
  renderOrigin: RenderOrigin,
  x: number,
  y: number,
  z: number,
): void {
  const { originDelta, cameraOriginFrac } = computeCameraRelativeUniforms(renderOrigin, x, y, z)
  const u = material.uniforms.u_originDelta
  if (u?.value?.set) {
    u.value.set(originDelta.x, originDelta.y, originDelta.z)
  }
  const uf = material.uniforms.u_cameraOriginFrac
  if (uf?.value?.set) {
    uf.value.set(cameraOriginFrac.x, cameraOriginFrac.y, cameraOriginFrac.z)
  }
}
