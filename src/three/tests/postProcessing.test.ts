import * as THREE from 'three'
import { expect, test } from 'vitest'
import { PostProcessing } from '../postProcessing'
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
    render: (object: THREE.Object3D) =>
      calls.push(`render ${(object as THREE.Mesh).material ? ((object as THREE.Mesh).material as THREE.Material).name : object.type}`)
  }
  return { renderer: renderer as unknown as THREE.WebGLRenderer, calls, fake: renderer }
}

test('antialiasing is off by default and off never touches the renderer', () => {
  expect(RENDERER_DEFAULT_OPTIONS.antialiasing).toBe('off')
  const post = new PostProcessing()
  const { renderer, calls } = fakeRenderer()
  expect(post.begin(renderer, 'off')).toBe(false)
  post.end(renderer)
  expect(calls).toEqual([])
})

test('fxaa renders the frame offscreen at drawing buffer size, then one pass to the canvas', () => {
  const post = new PostProcessing()
  const { renderer, calls } = fakeRenderer(1600, 900)
  expect(post.begin(renderer, 'fxaa')).toBe(true)
  post.end(renderer)
  expect(calls).toEqual(['target 1600x900', 'canvas', 'render FXAAShader'])
  // end without begin is a no-op
  post.end(renderer)
  expect(calls).toHaveLength(3)
})

test('follows drawing buffer resizes and is skipped in XR', () => {
  const post = new PostProcessing()
  const small = fakeRenderer(100, 50)
  post.begin(small.renderer, 'fxaa')
  post.end(small.renderer)
  const big = fakeRenderer(200, 100)
  post.begin(big.renderer, 'fxaa')
  expect(big.calls[0]).toBe('target 200x100')
  post.end(big.renderer)

  const xr = fakeRenderer()
  xr.fake.xr.isPresenting = true
  expect(post.begin(xr.renderer, 'fxaa')).toBe(false)
  expect(xr.calls).toEqual([])
})
