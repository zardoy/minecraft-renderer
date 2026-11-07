import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { needsBlockEmission, POST_EFFECTS_OFF, PostProcessing, usesPostProcessing, type PostEffectSettings, type PostFrameInfo } from '../postProcessing'
import { RENDERER_DEFAULT_OPTIONS } from '../../graphicsBackend/rendererDefaultOptions'

function fakeRenderer(width = 800, height = 600) {
  const calls: string[] = []
  let target: THREE.WebGLRenderTarget | null = null
  const renderer = {
    xr: { isPresenting: false },
    getDrawingBufferSize: (v: THREE.Vector2) => v.set(width, height),
    setRenderTarget: (t: THREE.WebGLRenderTarget | null) => {
      target = t
      calls.push(t ? `target ${t.width}x${t.height}` : 'canvas')
    },
    getRenderTarget: () => target,
    clearDepth: () => calls.push('clearDepth'),
    render: (object: THREE.Object3D) => calls.push(`draw ${((object as THREE.Mesh).material as THREE.Material).name}`)
  }
  return { renderer: renderer as unknown as THREE.WebGLRenderer, calls, fake: renderer }
}

const settings = (overrides: Partial<PostEffectSettings>): PostEffectSettings => ({ ...POST_EFFECTS_OFF, ...overrides })

function frameInfo(overrides: Partial<PostFrameInfo> = {}): PostFrameInfo {
  const camera = new THREE.PerspectiveCamera(70, 4 / 3, 0.1, 1000)
  camera.updateMatrixWorld()
  return {
    camera,
    cameraWorldPosition: { x: 0, y: 64, z: 0 },
    timeSeconds: 1,
    inWater: false,
    inNether: false,
    onFire: false,
    sunDirection: new THREE.Vector3(0, 0.5, -1).normalize(),
    sunStrength: 1,
    ...overrides
  }
}

describe('defaults', () => {
  it('every post effect is off by default and off never touches the renderer', () => {
    for (const key of ['antialiasing', 'colorGrading'] as const) expect(RENDERER_DEFAULT_OPTIONS[key]).toBe('off')
    for (const key of ['bloom', 'godRays', 'vignette', 'underwaterWobble', 'heatHaze', 'motionBlur'] as const) {
      expect(RENDERER_DEFAULT_OPTIONS[key]).toBe(false)
    }
    expect(usesPostProcessing(POST_EFFECTS_OFF)).toBe(false)
    const post = new PostProcessing()
    const { renderer, calls } = fakeRenderer()
    expect(post.begin(renderer, POST_EFFECTS_OFF)).toBe(false)
    post.afterWorld(renderer, frameInfo())
    post.end(renderer)
    expect(calls).toEqual([])
  })

  it('block emission is only needed by bloom and heat haze', () => {
    expect(needsBlockEmission(settings({ antialiasing: 'fxaa', godRays: true, motionBlur: true }))).toBe(false)
    expect(needsBlockEmission(settings({ bloom: true }))).toBe(true)
    expect(needsBlockEmission(settings({ heatHaze: true }))).toBe(true)
  })
})

describe('pass sequence', () => {
  it('fxaa alone: frame offscreen at drawing buffer size, one pass to the canvas', () => {
    const post = new PostProcessing()
    const { renderer, calls } = fakeRenderer(1600, 900)
    expect(post.begin(renderer, settings({ antialiasing: 'fxaa' }))).toBe(true)
    post.afterWorld(renderer, frameInfo())
    post.end(renderer)
    expect(calls).toEqual(['target 1600x900', 'canvas', 'draw fxaa'])
    post.end(renderer) // without begin: no-op
    expect(calls).toHaveLength(3)
  })

  it('grading + fxaa: final pass into a target, then fxaa', () => {
    const post = new PostProcessing()
    const { renderer, calls } = fakeRenderer(100, 100)
    post.begin(renderer, settings({ antialiasing: 'fxaa', colorGrading: 'warm', vignette: true }))
    post.end(renderer)
    expect(calls).toEqual(['target 100x100', 'target 100x100', 'draw final', 'canvas', 'draw fxaa'])
  })

  it('bloom: half and quarter resolution blur, composite, then the hand draws on top with cleared depth', () => {
    const post = new PostProcessing()
    const { renderer, calls } = fakeRenderer(100, 60)
    post.begin(renderer, settings({ bloom: true }))
    post.afterWorld(renderer, frameInfo())
    post.end(renderer)
    expect(calls).toEqual([
      'target 100x60',
      'target 50x30',
      'draw bloomPrefilter',
      'target 50x30',
      'draw blur',
      'target 50x30',
      'draw blur',
      'target 25x15',
      'draw downsample',
      'target 25x15',
      'draw blur',
      'target 25x15',
      'draw blur',
      'target 100x60',
      'draw composite',
      'target 100x60',
      'clearDepth',
      'canvas',
      'draw final'
    ])
  })

  it('god rays only run while the sun is in front of the camera and up', () => {
    const post = new PostProcessing()
    const sunAhead = fakeRenderer(100, 100)
    post.begin(sunAhead.renderer, settings({ godRays: true }))
    post.afterWorld(sunAhead.renderer, frameInfo())
    expect(sunAhead.calls).toContain('draw godRays')

    for (const frame of [frameInfo({ sunDirection: new THREE.Vector3(0, 0.5, 1).normalize() }), frameInfo({ sunStrength: 0 }), frameInfo({ inWater: true })]) {
      const { renderer, calls } = fakeRenderer(100, 100)
      post.begin(renderer, settings({ godRays: true }))
      post.afterWorld(renderer, frame)
      post.end(renderer)
      expect(calls).not.toContain('draw godRays')
      expect(calls).not.toContain('draw composite')
    }
  })

  it('motion blur needs a previous frame and skips teleports', () => {
    const post = new PostProcessing()
    const run = (position: { x: number; y: number; z: number }) => {
      const { renderer, calls } = fakeRenderer(100, 100)
      post.begin(renderer, settings({ motionBlur: true }))
      post.afterWorld(renderer, frameInfo({ cameraWorldPosition: position }))
      post.end(renderer)
      return calls.includes('draw composite')
    }
    expect(run({ x: 0, y: 64, z: 0 })).toBe(false)
    expect(run({ x: 0.2, y: 64, z: 0 })).toBe(true)
    expect(run({ x: 500, y: 64, z: 0 })).toBe(false)
  })

  it('is skipped in XR and releases everything when switched off', () => {
    const post = new PostProcessing()
    const xr = fakeRenderer()
    xr.fake.xr.isPresenting = true
    expect(post.begin(xr.renderer, settings({ antialiasing: 'fxaa' }))).toBe(false)
    expect(xr.calls).toEqual([])
    const on = fakeRenderer()
    post.begin(on.renderer, settings({ bloom: true, godRays: true }))
    post.end(on.renderer)
    const off = fakeRenderer()
    expect(post.begin(off.renderer, POST_EFFECTS_OFF)).toBe(false)
    expect((post as any).scene).toBeUndefined()
    expect((post as any).bloomHalf).toBeUndefined()
  })
})
