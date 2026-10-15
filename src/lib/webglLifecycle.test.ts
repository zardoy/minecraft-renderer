import { expect, test } from 'vitest'
import { loseWebGLContext, releaseWebGLRenderer } from './webglLifecycle'

test('releases a renderer in context-loss order', () => {
  const calls: string[] = []
  const renderer = {
    forceContextLoss: () => calls.push('forceContextLoss'),
    dispose: () => calls.push('dispose'),
    domElement: {
      remove: () => calls.push('remove')
    }
  }

  releaseWebGLRenderer(renderer)

  expect(calls).toEqual(['forceContextLoss', 'dispose', 'remove'])
})

test('loses a raw WebGL context through WEBGL_lose_context', () => {
  const calls: string[] = []
  const gl = {
    getExtension: (name: string) => {
      expect(name).toBe('WEBGL_lose_context')
      return { loseContext: () => calls.push('loseContext') }
    }
  }

  loseWebGLContext(gl)

  expect(calls).toEqual(['loseContext'])
})
