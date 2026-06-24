import { augmentWorkerMcData } from '../lib/buildWorkerMcDataIndexes'

globalThis.structuredClone ??= value => JSON.parse(JSON.stringify(value))

const applyWorkerMcData = (raw: Record<string, unknown>) => {
  augmentWorkerMcData(raw)
  const globalVar: any = globalThis
  globalVar.mcData = raw
  globalVar.loadedData = raw
  // eslint-disable-next-line no-restricted-globals
  self.postMessage({ type: 'mcDataApplied' })
}

// eslint-disable-next-line no-restricted-globals
self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data
  if (data.type === 'mcData') {
    applyWorkerMcData(data.mcData)
    console.log('data loaded')
    return
  }

  if (Array.isArray(data)) {
    // eslint-disable-next-line unicorn/no-array-for-each
    data.forEach(msg => {
      if (msg.type === 'mcData') {
        applyWorkerMcData(msg.mcData)
      }
    })
  }
})

// Initialize the graphics backend worker proxy
import { createGraphicsBackendBase } from './graphicsBackendBase'

const graphicsBackend = createGraphicsBackendBase()
graphicsBackend.workerProxy()
