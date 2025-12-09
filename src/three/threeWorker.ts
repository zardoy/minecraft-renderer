// Three.js Worker Entry Point
// This worker handles three.js rendering in an offscreen canvas

globalThis.structuredClone ??= (value) => JSON.parse(JSON.stringify(value))

// Handle mcData messages - needed for esbuild plugin to access globalThis.mcData
// Use addEventListener to coexist with worker proxy's message handler
// eslint-disable-next-line no-restricted-globals
self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data
  const globalVar: any = globalThis

  if (data.type === 'mcData') {
    globalVar.mcData = data.mcData
    globalVar.loadedData = data.mcData
    console.log('data loaded')
    return
  }

  // Handle array of messages (batch mode)
  if (Array.isArray(data)) {
    // eslint-disable-next-line unicorn/no-array-for-each
    data.forEach((msg) => {
      if (msg.type === 'mcData') {
        globalVar.mcData = msg.mcData
        globalVar.loadedData = msg.mcData
      }
    })
  }
})

// Initialize the graphics backend worker proxy
import { createGraphicsBackendBase } from './graphicsBackend'

const graphicsBackend = createGraphicsBackendBase()
graphicsBackend.workerProxy()
