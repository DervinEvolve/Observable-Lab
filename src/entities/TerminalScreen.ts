import * as THREE from 'three'
import gsap from 'gsap'

// Terminal configuration
const TERMINAL_CONFIG = {
  width: 1.4,        // World units
  height: 1.0,       // World units
  hoverHeight: 2.0,  // Height above ground
  canvasWidth: 512,  // Pixels
  canvasHeight: 384, // Pixels
  fontSize: 14,
  lineHeight: 18,
  padding: 12,
  maxLines: 20,
  backgroundColor: '#0d1117',  // Dark terminal background
  textColor: '#58a6ff',        // Blue for commands
  outputColor: '#8b949e',      // Gray for output
  successColor: '#3fb950',     // Green for success
  errorColor: '#f85149',       // Red for errors
  promptColor: '#8b949e',      // Gray for prompt
}

// Terminal activity states
export type TerminalActivity = 'idle' | 'running' | 'success' | 'error'

interface TerminalLine {
  text: string
  color: string
  isCommand?: boolean
}

export class TerminalScreen {
  public group: THREE.Group
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private texture: THREE.CanvasTexture
  private mesh: THREE.Mesh
  private lines: TerminalLine[] = []
  private activity: TerminalActivity = 'idle'
  private cursorVisible: boolean = true
  private cursorInterval: number | null = null
  private isVisible: boolean = false
  private webShot: { img: HTMLImageElement; domain: string } | null = null
  private webShotTimer: number | null = null
  private spill!: THREE.Mesh

  constructor(position: THREE.Vector3, rotation: number = 0) {
    this.group = new THREE.Group()
    this.group.name = 'terminal_screen'
    this.group.position.copy(position)
    this.group.position.y += TERMINAL_CONFIG.hoverHeight
    this.group.rotation.y = rotation

    // Hidden by default
    this.group.visible = false

    // Create canvas for text rendering
    this.canvas = document.createElement('canvas')
    this.canvas.width = TERMINAL_CONFIG.canvasWidth
    this.canvas.height = TERMINAL_CONFIG.canvasHeight
    this.ctx = this.canvas.getContext('2d')!

    // Create texture from canvas
    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.minFilter = THREE.LinearFilter
    this.texture.magFilter = THREE.LinearFilter
    // Mirror horizontally so the code reads correctly on the camera-facing side
    this.texture.wrapS = THREE.RepeatWrapping
    this.texture.repeat.x = -1
    this.texture.offset.x = 1

    // Create screen mesh
    const geometry = new THREE.PlaneGeometry(
      TERMINAL_CONFIG.width,
      TERMINAL_CONFIG.height
    )
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      side: THREE.DoubleSide,
    })
    this.mesh = new THREE.Mesh(geometry, material)
    this.group.add(this.mesh)

    // Add subtle glow effect behind terminal
    const glowGeometry = new THREE.PlaneGeometry(
      TERMINAL_CONFIG.width + 0.1,
      TERMINAL_CONFIG.height + 0.1
    )
    const glowMaterial = new THREE.MeshBasicMaterial({
      color: 0x58a6ff,
      transparent: true,
      opacity: 0.1,
      side: THREE.DoubleSide,
    })
    const glow = new THREE.Mesh(glowGeometry, glowMaterial)
    glow.position.z = -0.01
    this.group.add(glow)

    // Light spill: a soft blue pool on the desk below the floating screen,
    // so the terminal visibly casts light into the room.
    const spillCanvas = document.createElement('canvas')
    spillCanvas.width = spillCanvas.height = 64
    const sctx = spillCanvas.getContext('2d')!
    const grad = sctx.createRadialGradient(32, 32, 2, 32, 32, 32)
    grad.addColorStop(0, 'rgba(88, 166, 255, 0.55)')
    grad.addColorStop(1, 'rgba(88, 166, 255, 0)')
    sctx.fillStyle = grad
    sctx.fillRect(0, 0, 64, 64)
    const spillMat = new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(spillCanvas),
      transparent: true,
      opacity: 0.35,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    this.spill = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.8), spillMat)
    this.spill.rotation.x = -Math.PI / 2
    this.spill.position.y = -TERMINAL_CONFIG.hoverHeight + 0.78 // just above desk height
    this.group.add(this.spill)

    // Initial render
    this.render()

    // Start cursor blink
    this.startCursorBlink()
  }

  private startCursorBlink(): void {
    this.cursorInterval = window.setInterval(() => {
      if (this.activity === 'running') {
        this.cursorVisible = !this.cursorVisible
        this.render()
      }
    }, 500)
  }

  private render(): void {
    const ctx = this.ctx
    const config = TERMINAL_CONFIG

    // Clear and fill background
    ctx.fillStyle = config.backgroundColor
    ctx.fillRect(0, 0, config.canvasWidth, config.canvasHeight)

    // Add subtle scanlines effect
    ctx.fillStyle = 'rgba(255, 255, 255, 0.02)'
    for (let y = 0; y < config.canvasHeight; y += 2) {
      ctx.fillRect(0, y, config.canvasWidth, 1)
    }

    // Draw terminal header bar
    ctx.fillStyle = '#21262d'
    ctx.fillRect(0, 0, config.canvasWidth, 24)

    // Draw window controls (decorative)
    const controlColors = ['#f85149', '#f0883e', '#3fb950']
    controlColors.forEach((color, i) => {
      ctx.beginPath()
      ctx.arc(12 + i * 16, 12, 5, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
    })

    // Draw title
    ctx.fillStyle = '#8b949e'
    ctx.font = '11px monospace'
    ctx.fillText('sprites terminal', config.canvasWidth / 2 - 40, 16)

    // Set font for terminal content
    ctx.font = `${config.fontSize}px "Monaco", "Menlo", "Ubuntu Mono", monospace`

    // Calculate visible lines
    const startY = 24 + config.padding
    const maxVisibleLines = Math.floor(
      (config.canvasHeight - startY - config.padding) / config.lineHeight
    )
    const visibleLines = this.lines.slice(-maxVisibleLines)

    // Draw lines
    visibleLines.forEach((line, index) => {
      const y = startY + (index + 1) * config.lineHeight

      if (line.isCommand) {
        // Draw prompt
        ctx.fillStyle = config.promptColor
        ctx.fillText('$', config.padding, y)

        // Draw command
        ctx.fillStyle = line.color
        ctx.fillText(line.text, config.padding + 16, y)
      } else {
        ctx.fillStyle = line.color
        ctx.fillText(line.text, config.padding, y)
      }
    })

    // Draw cursor if active
    if (this.activity === 'running' && this.cursorVisible) {
      const lastLine = visibleLines[visibleLines.length - 1]
      const cursorY = startY + visibleLines.length * config.lineHeight
      let cursorX = config.padding

      if (lastLine?.isCommand) {
        cursorX += 16 + ctx.measureText(lastLine.text).width + 4
      } else if (lastLine) {
        cursorX += ctx.measureText(lastLine.text).width + 4
      }

      ctx.fillStyle = config.textColor
      ctx.fillRect(cursorX, cursorY - config.fontSize + 2, 8, config.fontSize)
    }

    // Draw activity indicator
    if (this.activity !== 'idle') {
      const indicatorColor =
        this.activity === 'success' ? config.successColor :
        this.activity === 'error' ? config.errorColor :
        config.textColor

      ctx.beginPath()
      ctx.arc(config.canvasWidth - 16, config.canvasHeight - 16, 6, 0, Math.PI * 2)
      ctx.fillStyle = indicatorColor
      ctx.fill()
    }

    // Overlay a REAL screenshot of the page the model is browsing (loaded with
    // CORS so the canvas→WebGL texture stays untainted). Drawn over the text
    // area with a small in-terminal URL bar; when it clears, the streamed
    // code underneath is visible again.
    if (this.webShot) {
      const barTop = 24
      const barH = 22
      // URL bar strip
      ctx.fillStyle = '#161b22'
      ctx.fillRect(0, barTop, config.canvasWidth, barH)
      ctx.fillStyle = '#0d1117'
      ctx.fillRect(8, barTop + 4, config.canvasWidth - 16, barH - 8)
      ctx.fillStyle = config.textColor
      ctx.font = '11px monospace'
      ctx.fillText(`🌐 ${this.webShot.domain}`, 14, barTop + 15)

      // Page image fills the rest of the screen, anchored to the page top
      const img = this.webShot.img
      const imgTop = barTop + barH
      const areaH = config.canvasHeight - imgTop
      const scale = config.canvasWidth / img.width
      const srcH = Math.min(img.height, areaH / scale)
      ctx.drawImage(img, 0, 0, img.width, srcH, 0, imgTop, config.canvasWidth, srcH * scale)
    }

    // Update texture
    this.texture.needsUpdate = true
  }

  // Show a real screenshot of a page the model actually browsed, rendered on
  // this terminal screen for `holdMs`, then return to the text stream.
  public showPageShot(pageUrl: string, holdMs = 5000): void {
    let domain = pageUrl
    try { domain = new URL(pageUrl).hostname.replace(/^www\./, '') } catch { /* keep raw */ }
    const img = new Image()
    img.crossOrigin = 'anonymous' // thum.io sends ACAO:* — required for WebGL
    img.onload = () => {
      this.webShot = { img, domain }
      this.render()
      if (this.webShotTimer) window.clearTimeout(this.webShotTimer)
      this.webShotTimer = window.setTimeout(() => {
        this.webShot = null
        this.render()
      }, holdMs)
    }
    // On failure just stay on the text stream — the search lines already tell the story.
    img.src = `https://image.thum.io/get/width/512/crop/600/${pageUrl.replace(/"/g, '%22')}`
  }

  // Add a command line (with $ prompt)
  public addCommand(command: string): void {
    this.lines.push({
      text: command,
      color: TERMINAL_CONFIG.textColor,
      isCommand: true,
    })
    this.activity = 'running'
    this.render()
  }

  // Add output line
  public addOutput(text: string, type: 'normal' | 'success' | 'error' = 'normal'): void {
    const color =
      type === 'success' ? TERMINAL_CONFIG.successColor :
      type === 'error' ? TERMINAL_CONFIG.errorColor :
      TERMINAL_CONFIG.outputColor

    // Split long lines
    const maxChars = 55
    const wrappedLines = this.wrapText(text, maxChars)

    wrappedLines.forEach(line => {
      this.lines.push({ text: line, color })
    })

    // Keep only recent lines
    if (this.lines.length > TERMINAL_CONFIG.maxLines * 2) {
      this.lines = this.lines.slice(-TERMINAL_CONFIG.maxLines)
    }

    this.render()
  }

  private wrapText(text: string, maxChars: number): string[] {
    if (text.length <= maxChars) return [text]

    const lines: string[] = []
    let remaining = text

    while (remaining.length > 0) {
      lines.push(remaining.slice(0, maxChars))
      remaining = remaining.slice(maxChars)
    }

    return lines
  }

  // Stream a coding session: type the command char-by-char, then reveal output
  // lines one at a time — so the screen visibly "writes" code.
  public streamSession(
    command: string,
    outputs: Array<{ text: string; type?: 'normal' | 'success' | 'error' }>
  ): void {
    this.activity = 'running'
    const cmdLine: TerminalLine = { text: '', color: TERMINAL_CONFIG.textColor, isCommand: true }
    this.lines.push(cmdLine)
    this.render()

    let i = 0
    const typeChar = () => {
      if (i < command.length) {
        cmdLine.text += command[i++]
        this.render()
        window.setTimeout(typeChar, 26)
      } else {
        window.setTimeout(() => this.streamOutputs(outputs, 0), 350)
      }
    }
    window.setTimeout(typeChar, 250)
  }

  private streamOutputs(
    outputs: Array<{ text: string; type?: 'normal' | 'success' | 'error' }>,
    idx: number
  ): void {
    if (idx >= outputs.length) {
      this.setActivity(outputs.some(o => o.type === 'error') ? 'error' : 'success')
      return
    }
    const o = outputs[idx]
    this.addOutput(o.text, o.type || 'normal')
    window.setTimeout(() => this.streamOutputs(outputs, idx + 1), 480)
  }

  // Set activity state
  public setActivity(activity: TerminalActivity): void {
    this.activity = activity

    if (activity === 'idle') {
      // Clear terminal after a delay when going idle (10s to allow reading)
      setTimeout(() => {
        if (this.activity === 'idle') {
          this.clear()
          this.setVisible(false)
        }
      }, 10000)
    }

    this.render()
  }

  // Clear terminal
  public clear(): void {
    this.lines = []
    this.render()
  }

  // Show/hide with animation
  public setVisible(visible: boolean): void {
    if (this.isVisible === visible) return
    this.isVisible = visible

    if (visible) {
      this.group.visible = true
      this.group.scale.set(0.1, 0.1, 0.1)
      gsap.to(this.group.scale, {
        x: 1, y: 1, z: 1,
        duration: 0.3,
        ease: 'back.out(1.7)',
      })
      // CRT boot flicker: the screen and its desk-spill stutter to life
      const screenMat = this.mesh.material as THREE.MeshBasicMaterial
      const spillMat = this.spill.material as THREE.MeshBasicMaterial
      gsap.killTweensOf([screenMat, spillMat])
      const flicker = { v: 0 }
      gsap.to(flicker, {
        v: 1,
        duration: 0.45,
        ease: 'power1.in',
        onUpdate: () => {
          // random dropouts while powering up = CRT stutter
          const dip = flicker.v < 0.95 && Math.random() < 0.35 ? 0.2 : 1
          screenMat.opacity = flicker.v * dip
          spillMat.opacity = 0.35 * flicker.v * dip
        },
        onComplete: () => {
          screenMat.opacity = 1
          spillMat.opacity = 0.35
        },
      })
    } else {
      gsap.to(this.group.scale, {
        x: 0.1, y: 0.1, z: 0.1,
        duration: 0.2,
        ease: 'power2.in',
        onComplete: () => {
          this.group.visible = false
        },
      })
    }
  }

  public isShowing(): boolean {
    return this.isVisible
  }

  public getActivity(): TerminalActivity {
    return this.activity
  }

  public update(_deltaTime: number, camera?: THREE.Camera): void {
    // Billboard the screen to face the camera (yaw only, stays upright) so the
    // streaming code is always readable from wherever the visitor is looking.
    if (camera && this.group.visible) {
      const camPos = camera.position.clone()
      camPos.y = this.group.position.y
      const away = this.group.position.clone().multiplyScalar(2).sub(camPos)
      this.group.lookAt(away)
    }
  }

  public dispose(): void {
    if (this.cursorInterval) {
      clearInterval(this.cursorInterval)
    }

    gsap.killTweensOf(this.group.scale)

    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
    this.texture.dispose()
  }
}

// Factory function
export function createTerminalScreen(
  position: THREE.Vector3,
  rotation: number
): TerminalScreen {
  return new TerminalScreen(position, rotation)
}
