import * as THREE from 'three'
import type { BlockEffects } from './blockEffects'
import type { CubeDrawSpan } from './cubeDrawSpans'
import type { GlobalBlockBuffer } from './globalBlockBuffer'
import { INDICES_PER_QUAD, type GlobalLegacyBuffer, type LegacyDrawSpan, type VisibleSectionSpan } from './globalLegacyBuffer'

type Pass<S> = {
  mesh: THREE.Mesh
  material: THREE.ShaderMaterial
  /** the terrain material this one is a blended copy of (uniforms shared) */
  source: THREE.ShaderMaterial
  spans: S[]
}

/**
 * Chunk fade, the plain look: the opaque geometry of sections that are still fading in is left out of the terrain pass and drawn
 * here, after it, with alpha blending (alpha = fade progress, SECTION_FADE_SET_ALPHA). A real see-through fade over the terrain or
 * sky behind, at any resolution (an ordered dither read as a dot grid on 1x displays).
 *
 * Same trick as the sun shadow casters: a mesh sharing the global buffer's geometry (three binds its attributes, the buffer keeps
 * its own instanced draw suppressed) whose onAfterRender issues the fading sections' spans. Sections are drawn far to near and
 * write depth, so a fading section hides its own back parts like the opaque terrain would.
 */
export class SectionFadePass {
  private cube: Pass<CubeDrawSpan> | null = null
  private legacy: Pass<LegacyDrawSpan> | null = null

  constructor(
    private readonly scene: THREE.Object3D,
    private readonly blockEffects: BlockEffects
  ) {}

  /** `cubeSections` / `legacySections`: the fading sections of each buffer that passed the cull. */
  update(
    cubeBuffer: GlobalBlockBuffer | null,
    cubeSections: VisibleSectionSpan[],
    legacyBuffer: GlobalLegacyBuffer | null,
    legacySections: VisibleSectionSpan[]
  ): void {
    if (cubeBuffer && cubeSections.length > 0) {
      const pass = (this.cube = this.ensurePass<CubeDrawSpan>(this.cube, 'cube', cubeBuffer.mesh, 'cubeFade', (renderer, material, spans) =>
        cubeBuffer.drawSpans(renderer, material, spans)
      ))
      pass.spans = orderedSpans(cubeSections, key => {
        const start = cubeBuffer.getSectionDrawStart(key)
        const count = cubeBuffer.getSectionDrawCount(key)
        return start === undefined || !count ? null : { start, count }
      })
    } else if (this.cube) {
      this.cube.spans = []
    }

    if (legacyBuffer && legacySections.length > 0) {
      const pass = (this.legacy = this.ensurePass<LegacyDrawSpan>(this.legacy, 'legacy', legacyBuffer.mesh, 'legacyFade', (renderer, _material, spans) =>
        legacyBuffer.drawIndexSpans(renderer, spans)
      ))
      pass.spans = orderedSpans(legacySections, key => {
        const start = legacyBuffer.getSectionDrawStart(key)
        const count = legacyBuffer.getSectionDrawCount(key)
        return start === undefined || !count ? null : { indexStart: start * INDICES_PER_QUAD, indexCount: count * INDICES_PER_QUAD }
      })
    } else if (this.legacy) {
      this.legacy.spans = []
    }

    for (const pass of [this.cube, this.legacy]) {
      if (pass) pass.mesh.visible = pass.spans.length > 0
    }
  }

  clear(): void {
    for (const pass of [this.cube, this.legacy]) {
      if (!pass) continue
      pass.spans = []
      pass.mesh.visible = false
    }
  }

  dispose(): void {
    for (const pass of [this.cube, this.legacy]) {
      if (!pass) continue
      pass.mesh.parent?.remove(pass.mesh)
      this.blockEffects.unregister(pass.material)
      pass.material.dispose()
    }
    this.cube = null
    this.legacy = null
  }

  private ensurePass<S>(
    current: Pass<S> | null,
    which: 'cube' | 'legacy',
    bufferMesh: THREE.Mesh,
    kind: 'cubeFade' | 'legacyFade',
    draw: (renderer: THREE.WebGLRenderer, material: THREE.ShaderMaterial, spans: readonly S[]) => void
  ): Pass<S> {
    // the legacy buffer's mesh holds a one-entry material array
    const source = (Array.isArray(bufferMesh.material) ? bufferMesh.material[0] : bufferMesh.material) as THREE.ShaderMaterial
    let pass = current
    if (pass && pass.source !== source) {
      // the terrain material was recreated: start over from the new one
      pass.mesh.parent?.remove(pass.mesh)
      this.blockEffects.unregister(pass.material)
      pass.material.dispose()
      pass = null
    }
    if (!pass) {
      const material = source.clone()
      // shared, not copied: every uniform the terrain material gets (origin, lightmap, shadows, fade clock) applies here too
      material.uniforms = source.uniforms
      material.transparent = true
      material.depthWrite = true
      material.depthTest = true
      // colour blends by the fade; the framebuffer alpha (bloom emission of the terrain behind) is kept
      material.blending = THREE.CustomBlending
      material.blendEquation = THREE.AddEquation
      material.blendSrc = THREE.SrcAlphaFactor
      material.blendDst = THREE.OneMinusSrcAlphaFactor
      material.blendSrcAlpha = THREE.ZeroFactor
      material.blendDstAlpha = THREE.OneFactor
      this.blockEffects.register(material, kind)
      const mesh = new THREE.Mesh(bufferMesh.geometry, material)
      mesh.name = `sectionFade-${which}`
      mesh.frustumCulled = false
      mesh.matrixAutoUpdate = false
      mesh.matrix.identity()
      // before other blended geometry (water, glass): those are drawn over the fading terrain
      mesh.renderOrder = -1
      const created: Pass<S> = { mesh, material, source, spans: [] }
      mesh.onAfterRender = renderer => draw(renderer, material, created.spans)
      this.scene.add(mesh)
      pass = created
    }
    // the buffer swaps its geometry when it grows
    pass.mesh.geometry = bufferMesh.geometry
    return pass
  }
}

/** One span per section, far to near (blended drawing order), skipping sections that are not drawable yet. */
function orderedSpans<S>(sections: VisibleSectionSpan[], spanOf: (key: string) => S | null): S[] {
  const sorted = [...sections].sort((a, b) => b.distSq - a.distSq)
  const spans: S[] = []
  for (const { key } of sorted) {
    const span = spanOf(key)
    if (span) spans.push(span)
  }
  return spans
}
