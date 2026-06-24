/* eslint-disable no-await-in-loop */
import { Vec3 } from 'vec3'

// import log from '../../../../../Downloads/mesher (2).log'
import { WorldRendererCommon } from './worldrendererCommon'
const log = ''

export class MesherLogReader {
  chunksToReceive: Array<{
    x: number
    z: number
    chunkLength: number
  }> = []
  messagesQueue: Array<{
    fromWorker: boolean
    workerIndex: number
    message: any
  }> = []

  sectionFinishedToReceive = null as {
    messagesLeft: string[]
    resolve: () => void
  } | null
  replayStarted = false

  constructor(private readonly worldRenderer: WorldRendererCommon) {
    this.parseMesherLog()
  }

  chunkReceived(x: number, z: number, chunkLength: number) {
    // remove existing chunks with same x and z
    const existingChunkIndex = this.chunksToReceive.findIndex(chunk => chunk.x === x && chunk.z === z)
    if (existingChunkIndex === -1) {
      // console.error('Chunk not found', x, z)
    } else {
      // warn if chunkLength is different
      if (this.chunksToReceive[existingChunkIndex].chunkLength !== chunkLength) {
        // console.warn('Chunk length mismatch', x, z, this.chunksToReceive[existingChunkIndex].chunkLength, chunkLength)
      }
      // remove chunk
      this.chunksToReceive = this.chunksToReceive.filter((chunk, index) => chunk.x !== x || chunk.z !== z)
    }
    this.maybeStartReplay()
  }

  async maybeStartReplay() {
    if (this.chunksToReceive.length !== 0 || this.replayStarted) return
    const lines = log.split('\n')
    console.log('starting replay')
    this.replayStarted = true
    const waitForWorkersMessages = async () => {
      if (!this.sectionFinishedToReceive) return
      await new Promise<void>(resolve => {
        this.sectionFinishedToReceive!.resolve = resolve
      })
    }

    for (const line of lines) {
      if (line.includes('dispatchMessages dirty')) {
        await waitForWorkersMessages()
        this.worldRenderer.stopMesherMessagesProcessing = true
        const message = JSON.parse(line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1))
        if (!message.value) continue
        const index = line.split(' ')[1]
        const type = line.split(' ')[3]
        // console.log('sending message', message.x, message.y, message.z)
        this.worldRenderer.forceCallFromMesherReplayer = true
        this.worldRenderer.setSectionDirty(new Vec3(message.x, message.y, message.z), message.value)
        this.worldRenderer.forceCallFromMesherReplayer = false
      }
      if (line.includes('-> blockUpdate')) {
        await waitForWorkersMessages()
        this.worldRenderer.stopMesherMessagesProcessing = true
        const message = JSON.parse(line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1))
        this.worldRenderer.forceCallFromMesherReplayer = true
        this.worldRenderer.setBlockStateIdInner(new Vec3(message.pos.x, message.pos.y, message.pos.z), message.stateId)
        this.worldRenderer.forceCallFromMesherReplayer = false
      }

      if (line.includes(' sectionFinished ')) {
        if (!this.sectionFinishedToReceive) {
          console.log('starting worker message processing validating')
          this.worldRenderer.stopMesherMessagesProcessing = false
          this.sectionFinishedToReceive = {
            messagesLeft: [],
            resolve: () => {
              this.sectionFinishedToReceive = null
            }
          }
        }
        const parts = line.split(' ')
        const coordsPart = parts.find(part => part.split(',').length === 3)
        if (!coordsPart) throw new Error(`no coords part found ${line}`)
        const [x, y, z] = coordsPart.split(',').map(Number)
        this.sectionFinishedToReceive.messagesLeft.push(`${x},${y},${z}`)
      }
    }
  }

  workerMessageReceived(type: string, message: any) {
    if (type === 'sectionFinished') {
      const { key } = message
      if (!this.sectionFinishedToReceive) {
        console.warn(`received sectionFinished message but no sectionFinishedToReceive ${key}`)
        return
      }

      const idx = this.sectionFinishedToReceive.messagesLeft.indexOf(key)
      if (idx === -1) {
        console.warn(`received sectionFinished message for non-outstanding section ${key}`)
        return
      }
      this.sectionFinishedToReceive.messagesLeft.splice(idx, 1)
      if (this.sectionFinishedToReceive.messagesLeft.length === 0) {
        this.sectionFinishedToReceive.resolve()
      }
    }
  }

  parseMesherLog() {
    const lines = log.split('\n')
    for (const line of lines) {
      if (line.startsWith('-> chunk')) {
        const chunk = JSON.parse(line.slice('-> chunk'.length))
        this.chunksToReceive.push(chunk)
        continue
      }
    }
  }
}
