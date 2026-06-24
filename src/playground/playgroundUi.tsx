import { isMobile } from '../lib/simpleUtils'
import useLongPress from './reactUtils'
import { renderToDom } from '@zardoy/react-util'
import { useEffect, useState } from 'react'
import { proxy, useSnapshot } from 'valtio'
import { Vec3 } from 'vec3'
import { MobileControls } from './mobileControls'

export const playgroundGlobalUiState = proxy({
  scenes: [] as string[],
  selected: '',
  selectorOpened: false,
  actions: {} as Record<string, () => void>
})

renderToDom(<Playground />, {
  strictMode: false,
  selector: '#react-root'
})

function Playground() {
  useEffect(() => {
    const style = document.createElement('style')
    style.innerHTML = /* css */ `
      .lil-gui {
        top: 60px !important;
        right: 0 !important;
      }
    `
    document.body.appendChild(style)

    // Hide the loading overlay once the playground UI is ready
    const loadingOverlay = document.getElementById('loading')
    if (loadingOverlay) {
      loadingOverlay.classList.add('hidden')
    }

    return () => {
      style.remove()
    }
  }, [])

  return (
    <div
      style={{
        fontFamily: 'monospace',
        color: 'white'
      }}
    >
      <Controls />
      <SceneSelector />
      <ActionsSelector />
    </div>
  )
}

function SceneSelector() {
  const mobile = isMobile()
  const { scenes, selected } = useSnapshot(playgroundGlobalUiState)
  const [hidden, setHidden] = useState(false)
  const longPressEvents = useLongPress(
    () => {
      playgroundGlobalUiState.selectorOpened = true
    },
    () => {}
  )

  if (hidden) return null

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        display: 'flex',
        alignItems: 'flex-start',
        zIndex: 1
      }}
      {...longPressEvents}
    >
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {scenes.map(scene => (
          <div
            key={scene}
            style={{
              padding: mobile ? '5px' : '2px 5px',
              cursor: 'pointer',
              userSelect: 'none',
              background: scene === selected ? 'rgba(0, 0, 0, 0.5)' : 'rgba(0, 0, 0, 0.6)',
              fontWeight: scene === selected ? 'bold' : 'normal'
            }}
            onClick={() => {
              const qs = new URLSearchParams(window.location.search)
              qs.set('scene', scene)
              location.search = qs.toString()
            }}
          >
            {scene}
          </div>
        ))}
      </div>
      <div
        style={{
          padding: mobile ? '5px' : '2px 5px',
          cursor: 'pointer',
          userSelect: 'none',
          background: 'rgba(0, 0, 0, 0.6)',
          fontSize: '14px',
          lineHeight: '1'
        }}
        onClick={() => setHidden(true)}
      >
        ×
      </div>
    </div>
  )
}

const ActionsSelector = () => {
  const { actions, selectorOpened } = useSnapshot(playgroundGlobalUiState)

  if (!selectorOpened) return null
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.5)',
        zIndex: 10,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 5,
        fontSize: 24
      }}
    >
      {Object.entries({
        ...actions,
        Close() {
          playgroundGlobalUiState.selectorOpened = false
        }
      }).map(([name, action]) => (
        <div
          key={name}
          style={{
            padding: '2px 5px',
            cursor: 'pointer',
            userSelect: 'none',
            background: 'rgba(0, 0, 0, 0.5)'
          }}
          onClick={() => {
            action()
            playgroundGlobalUiState.selectorOpened = false
          }}
        >
          {name}
        </div>
      ))}
    </div>
  )
}

const Controls = () => {
  return <MobileControls />
}
