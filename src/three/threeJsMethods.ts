import { AppViewer } from '../graphicsBackend'
import { ThreeJsBackendMethods } from './graphicsBackendBase'

/** @deprecated Use getDecoratedThreeJsRendererMethods instead */
export function getThreeJsRendererMethods(): ThreeJsBackendMethods | undefined {
  const renderer = globalThis.appViewer.backend
  if (renderer?.id !== 'threejs' || !renderer.backendMethods) return
  return new Proxy(renderer.backendMethods, {
    get(target, prop) {
      return async (...args) => {
        const result = await (target[prop as any] as any)(...args)
        return result
      }
    }
  }) as ThreeJsBackendMethods
}

export function getDecoratedThreeJsRendererMethods(appViewer: AppViewer): ThreeJsBackendMethods | undefined {
  return () => {
    const renderer = appViewer.backend
    if (renderer?.id !== 'threejs' || !renderer.backendMethods) return
    return new Proxy(renderer.backendMethods, {
      get(target, prop) {
        return async (...args) => {
          const result = await (target[prop as any] as any)(...args)
          return result
        }
      }
    }) as ThreeJsBackendMethods
  }
}
