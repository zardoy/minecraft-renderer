import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { ShaderWarmup } from './shaderWarmup'

const fakeRenderer = () =>
  ({
    shadowMap: { enabled: false, type: THREE.PCFShadowMap },
    toneMapping: THREE.NoToneMapping,
    outputColorSpace: THREE.LinearSRGBColorSpace,
    compileAsync: vi.fn(async () => {})
  }) as unknown as THREE.WebGLRenderer & { compileAsync: ReturnType<typeof vi.fn> }

describe('ShaderWarmup', () => {
  it('compiles the first time and again only when the scene state the shaders depend on changes', () => {
    const warmup = new ShaderWarmup()
    const renderer = fakeRenderer()
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera()

    warmup.update(renderer, scene, camera)
    warmup.update(renderer, scene, camera)
    expect(renderer.compileAsync).toHaveBeenCalledTimes(1)

    renderer.shadowMap.enabled = true
    warmup.update(renderer, scene, camera)
    expect(renderer.compileAsync).toHaveBeenCalledTimes(2)

    scene.fog = new THREE.Fog(0xffffff, 1, 100)
    warmup.update(renderer, scene, camera)
    warmup.update(renderer, scene, camera)
    expect(renderer.compileAsync).toHaveBeenCalledTimes(3)
    // compiled against the world scene (its lights and fog), not added to it
    expect(renderer.compileAsync.mock.calls[0][2]).toBe(scene)
    expect(scene.children).toHaveLength(0)
    warmup.dispose()
  })
})
