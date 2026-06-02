export const loadScript = async function (scriptSrc: string, highPriority = true): Promise<HTMLScriptElement> {
  const existingScript = document.querySelector<HTMLScriptElement>(`script[src="${scriptSrc}"]`)
  if (existingScript) {
    return existingScript
  }

  return new Promise((resolve, reject) => {
    const scriptElement = document.createElement('script')
    scriptElement.src = scriptSrc

    if (highPriority) {
      scriptElement.fetchPriority = 'high'
    }
    scriptElement.async = true

    scriptElement.addEventListener('load', () => {
      resolve(scriptElement)
    })

    scriptElement.onerror = (error) => {
      reject(new Error(typeof error === 'string' ? error : (error as any).message))
      scriptElement.remove()
    }

    document.head.appendChild(scriptElement)
  })
}

const detectFullOffscreenCanvasSupport = () => {
  if (typeof OffscreenCanvas === 'undefined') return false
  try {
    const canvas = new OffscreenCanvas(1, 1)
    // Try to get a WebGL context - this will fail on iOS where only 2D is supported (iOS 16)
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
    return gl !== null
  } catch (e) {
    return false
  }
}

const hasFullOffscreenCanvasSupport = detectFullOffscreenCanvasSupport()

export const createCanvas = (width: number, height: number): OffscreenCanvas => {
  if (hasFullOffscreenCanvasSupport || typeof document === 'undefined') {
    return new OffscreenCanvas(width, height)
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas as unknown as OffscreenCanvas // todo-low
}

export async function loadImageFromUrl(imageUrl: string): Promise<ImageBitmap> {
  const response = await fetch(imageUrl)
  const blob = await response.blob()
  return createImageBitmap(blob)
}

export const versionToNumber = (ver: string) => {
  const [x, y = '0', z = '0'] = ver.split('.')
  return +`${x.padStart(2, '0')}${y.padStart(2, '0')}${z.padStart(2, '0')}`
}

export const versionToMajor = (version: string) => {
  const [x, y = '0'] = version.split('.')
  return `${x.padStart(2, '0')}.${y.padStart(2, '0')}`
}

export const versionsMapToMajor = <T>(versionsMap: Record<string, T>) => {
  const majorVersions = {} as Record<string, T>
  for (const [ver, data] of Object.entries(versionsMap)) {
    const major = versionToMajor(ver)
    majorVersions[major] = data
  }
  return majorVersions
}
