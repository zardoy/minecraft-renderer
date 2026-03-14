import * as THREE from 'three'
import { WorldRendererThree } from './worldRendererThree'
import { SoundSystem } from '../graphicsBackend/types'

export class ThreeJsSound implements SoundSystem {
  audioListener: THREE.AudioListener | undefined
  private readonly activeSounds = new Set<THREE.PositionalAudio>()
  private readonly audioContext: AudioContext | undefined
  private readonly soundVolumes = new Map<THREE.PositionalAudio, number>()
  baseVolume = 1

  constructor(public worldRenderer: WorldRendererThree) {
    worldRenderer.onWorldSwitched.push(() => {
      this.stopAll()
    })

    worldRenderer.onReactiveConfigUpdated('volume', (volume) => {
      this.changeVolume(volume)
    })
  }

  initAudioListener() {
    if (this.audioListener) return
    this.audioListener = new THREE.AudioListener()
    this.worldRenderer.camera.add(this.audioListener)
  }

  playSound(position: { x: number, y: number, z: number }, path: string, volume = 1, pitch = 1, timeout = 500) {
    this.initAudioListener()

    const sound = new THREE.PositionalAudio(this.audioListener!)
    this.activeSounds.add(sound)
    this.soundVolumes.set(sound, volume)

    const audioLoader = new THREE.AudioLoader()
    const start = Date.now()
    void audioLoader.loadAsync(path).then((buffer) => {
      if (Date.now() - start > timeout) {
        console.warn('Ignored playing sound', path, 'due to timeout:', timeout, 'ms <', Date.now() - start, 'ms')
        return
      }
      // play
      sound.setBuffer(buffer)
      sound.setRefDistance(20)
      sound.setVolume(volume * this.baseVolume)
      sound.setPlaybackRate(pitch) // set the pitch
      this.worldRenderer.scene.add(sound)
      // set sound position
      this.worldRenderer.sceneOrigin.setPositionFromWorld(sound, position.x, position.y, position.z)
      sound.onEnded = () => {
        this.worldRenderer.scene.remove(sound)
        if (sound.source) {
          sound.disconnect()
        }
        this.activeSounds.delete(sound)
        this.soundVolumes.delete(sound)
        audioLoader.manager.itemEnd(path)
      }
      sound.play()
    })
  }

  stopAll() {
    for (const sound of this.activeSounds) {
      if (!sound) continue
      sound.stop()
      if (sound.source) {
        sound.disconnect()
      }
      this.worldRenderer.scene.remove(sound)
    }
    this.activeSounds.clear()
    this.soundVolumes.clear()
  }

  changeVolume(volume: number) {
    this.baseVolume = volume
    for (const [sound, individualVolume] of this.soundVolumes) {
      sound.setVolume(individualVolume * this.baseVolume)
    }
  }

  destroy() {
    this.stopAll()
    // Remove and cleanup audio listener
    if (this.audioListener) {
      this.audioListener.removeFromParent()
      this.audioListener = undefined
    }
  }

  playTestSound() {
    this.playSound(this.worldRenderer.camera.position, '/sound.mp3')
  }
}
