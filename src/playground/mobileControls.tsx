import { CSSProperties, PointerEvent, useEffect, useRef } from 'react'
import { proxy, ref, useSnapshot } from 'valtio'

export type ButtonName = 'jump' | 'sneak'

export const joystickPointer = proxy({
  pointer: null as { x: number; y: number; pointerId: number } | null,
  joystickInner: null as HTMLDivElement | null
})

export const cameraPointer = proxy({
  pointer: null as { x: number; y: number; pointerId: number } | null
})

export const handleMovementStickDelta = (e?: { clientX: number; clientY: number }) => {
  const max = 32
  let x = 0
  let y = 0

  if (e && joystickPointer.pointer) {
    x = e.clientX - joystickPointer.pointer.x
    y = e.clientY - joystickPointer.pointer.y
    x = Math.min(Math.max(x, -max), max)
    y = Math.min(Math.max(y, -max), max)
  }

  if (joystickPointer.joystickInner) {
    joystickPointer.joystickInner.style.transform = `translate(${x}px, ${y}px)`
  }

  const vector = {
    x: x / max,
    y: 0,
    z: y / max
  }

  console.log('Movement vector:', vector)
}

export const handleCameraRotation = (deltaX: number, deltaY: number) => {
  console.log('Camera rotation:', { deltaX, deltaY })
}

export const MobileControls = () => {
  const usingTouch = navigator.maxTouchPoints > 0
  const joystickOuter = useRef<HTMLDivElement>(null)
  const joystickInner = useRef<HTMLDivElement>(null)
  const { pointer: movementPointer } = useSnapshot(joystickPointer)
  const { pointer: cameraPointerState } = useSnapshot(cameraPointer)

  const joystickSize = 80
  const Z_INDEX_INTERACTIBLE = 8

  const buttonProps = (name: ButtonName) => {
    const holdDown = {
      jump() {
        console.log('Jump button pressed')
      },
      sneak() {
        console.log('Sneak button pressed')
      }
    }

    const holdUp = {
      jump() {
        console.log('Jump button released')
      },
      sneak() {
        console.log('Sneak button released')
      }
    }

    type PType = PointerEvent<HTMLDivElement>

    const pointerup = (e: PType) => {
      const elem = e.currentTarget as HTMLElement
      elem.releasePointerCapture(e.pointerId)
      holdUp[name]()
      elem.style.background = 'rgba(0, 0, 0, 0.5)'
    }

    const buttonPositions = {
      jump: [85, 60],
      sneak: [85, 75]
    }

    const buttonIcons = {
      jump: '↑',
      sneak: '↓'
    }

    return {
      style: {
        position: 'fixed',
        left: `${buttonPositions[name][0]}%`,
        top: `${buttonPositions[name][1]}%`,
        borderRadius: '50%',
        width: '50px',
        height: '50px',
        background: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        transition: 'background 0.1s',
        zIndex: Z_INDEX_INTERACTIBLE,
        color: 'white',
        fontSize: '16px',
        userSelect: 'none',
        transform: 'translate(-50%, -50%)',
        border: '2px solid rgba(255, 255, 255, 0.3)'
      } satisfies CSSProperties,
      onPointerDown(e: PType) {
        const elem = e.currentTarget as HTMLElement
        elem.setPointerCapture(e.pointerId)
        holdDown[name]()
        elem.style.background = 'rgba(0, 0, 0, 0.8)'
      },
      onPointerUp: pointerup,
      onLostPointerCapture: pointerup,
      children: buttonIcons[name]
    }
  }

  useEffect(() => {
    if (joystickInner.current) {
      joystickPointer.joystickInner = ref(joystickInner.current)
    }
  }, [])

  if (!usingTouch) return null

  return (
    <div>
      {/* Movement Joystick */}
      <div
        className="movement_joystick_outer"
        ref={joystickOuter}
        style={{
          display: movementPointer ? 'flex' : 'none',
          borderRadius: '50%',
          width: joystickSize,
          height: joystickSize,
          border: '2px solid rgba(0, 0, 0, 0.5)',
          backgroundColor: 'rgba(255, 255, 255, 0.3)',
          position: 'fixed',
          justifyContent: 'center',
          alignItems: 'center',
          transform: 'translate(-50%, -50%)',
          zIndex: Z_INDEX_INTERACTIBLE,
          ...(movementPointer
            ? {
                left: `${(movementPointer.x / window.innerWidth) * 100}%`,
                top: `${(movementPointer.y / window.innerHeight) * 100}%`
              }
            : {})
        }}
      >
        <div
          className="movement_joystick_inner"
          style={{
            borderRadius: '50%',
            width: joystickSize * 0.35,
            height: joystickSize * 0.35,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            position: 'absolute'
          }}
          ref={joystickInner}
        />
      </div>

      {/* Up/Down Action Buttons */}
      <div {...buttonProps('jump')} />
      <div {...buttonProps('sneak')} />

      {/* Movement touch area (left half of screen) */}
      <div
        style={{
          position: 'fixed',
          left: '0',
          top: '0',
          width: '50%',
          height: '100%',
          zIndex: Z_INDEX_INTERACTIBLE - 1
        }}
        onPointerDown={e => {
          if (joystickPointer.pointer) return

          joystickPointer.pointer = {
            x: e.clientX,
            y: e.clientY,
            pointerId: e.pointerId
          }

          const elem = e.currentTarget as HTMLElement
          elem.setPointerCapture(e.pointerId)
        }}
        onPointerMove={e => {
          if (!joystickPointer.pointer || e.pointerId !== joystickPointer.pointer.pointerId) return

          handleMovementStickDelta({
            clientX: e.clientX,
            clientY: e.clientY
          })
        }}
        onPointerUp={e => {
          if (!joystickPointer.pointer || e.pointerId !== joystickPointer.pointer.pointerId) return

          joystickPointer.pointer = null
          handleMovementStickDelta() // Reset position

          const elem = e.currentTarget as HTMLElement
          elem.releasePointerCapture(e.pointerId)
        }}
        onLostPointerCapture={e => {
          if (!joystickPointer.pointer || e.pointerId !== joystickPointer.pointer.pointerId) return

          joystickPointer.pointer = null
          handleMovementStickDelta() // Reset position
        }}
      />

      {/* Camera rotation touch area (right half of screen, excluding buttons) */}
      <div
        style={{
          position: 'fixed',
          right: '0',
          top: '0',
          width: '50%',
          height: '100%',
          zIndex: Z_INDEX_INTERACTIBLE - 2
        }}
        onPointerDown={e => {
          if (cameraPointer.pointer) return

          cameraPointer.pointer = {
            x: e.clientX,
            y: e.clientY,
            pointerId: e.pointerId
          }

          const elem = e.currentTarget as HTMLElement
          elem.setPointerCapture(e.pointerId)
        }}
        onPointerMove={e => {
          if (!cameraPointer.pointer || e.pointerId !== cameraPointer.pointer.pointerId) return

          const deltaX = e.clientX - cameraPointer.pointer.x
          const deltaY = e.clientY - cameraPointer.pointer.y

          handleCameraRotation(deltaX, deltaY)

          // Update pointer position for continuous rotation
          cameraPointer.pointer.x = e.clientX
          cameraPointer.pointer.y = e.clientY
        }}
        onPointerUp={e => {
          if (!cameraPointer.pointer || e.pointerId !== cameraPointer.pointer.pointerId) return

          cameraPointer.pointer = null

          const elem = e.currentTarget as HTMLElement
          elem.releasePointerCapture(e.pointerId)
        }}
        onLostPointerCapture={e => {
          if (!cameraPointer.pointer || e.pointerId !== cameraPointer.pointer.pointerId) return

          cameraPointer.pointer = null
        }}
      />
    </div>
  )
}
