import * as THREE from 'three'
import gsap from 'gsap'
import { LIGHTING_PRESETS, type LightingPreset } from '../shared/types'

interface LightingControllerOptions {
  scene: THREE.Scene
  ambientLight: THREE.AmbientLight
  mainLight?: THREE.DirectionalLight
}

export class LightingController {
  private scene: THREE.Scene
  private ambientLight: THREE.AmbientLight
  private mainLight: THREE.DirectionalLight | null
  private redAccentLights: THREE.PointLight[] = []
  private currentPreset: string = 'healthy'
  private transitionDuration: number = 2.0 // seconds

  constructor(options: LightingControllerOptions) {
    this.scene = options.scene
    this.ambientLight = options.ambientLight
    this.mainLight = options.mainLight || null

    // Create red accent lights (hidden by default)
    this.createRedAccentLights()
  }

  private createRedAccentLights(): void {
    // Create 4 subtle red point lights around the lab
    const positions = [
      new THREE.Vector3(3, 2, 0),
      new THREE.Vector3(-3, 2, 0),
      new THREE.Vector3(0, 2, 3),
      new THREE.Vector3(0, 2, -3),
    ]

    positions.forEach(pos => {
      const light = new THREE.PointLight(0xff3333, 0, 6) // Start with 0 intensity
      light.position.copy(pos)
      this.scene.add(light)
      this.redAccentLights.push(light)
    })
  }

  // Update lighting based on stability score
  public updateFromStability(stabilityScore: number): void {
    let targetPreset: string

    if (stabilityScore > 0.8) {
      targetPreset = 'thriving'
    } else if (stabilityScore >= 0.5) {
      targetPreset = 'healthy'
    } else if (stabilityScore >= 0.3) {
      targetPreset = 'struggling'
    } else {
      targetPreset = 'critical'
    }

    if (targetPreset !== this.currentPreset) {
      this.transitionTo(targetPreset)
    }
  }

  // Transition to a specific preset
  public transitionTo(presetName: string): void {
    const preset = LIGHTING_PRESETS[presetName]
    if (!preset) {
      console.warn(`Unknown lighting preset: ${presetName}`)
      return
    }

    this.currentPreset = presetName
    this.applyPreset(preset)
  }

  // 0..1 growth stage — a mature lab glows warmer than a seedling lab.
  // Subtle by design: at full growth the ambient shifts ~20% toward golden.
  private growthWarmth = 0
  public setGrowthWarmth(stage: number): void {
    const clamped = THREE.MathUtils.clamp(stage, 0, 1)
    if (Math.abs(clamped - this.growthWarmth) < 0.05) return
    this.growthWarmth = clamped
    const preset = LIGHTING_PRESETS[this.currentPreset]
    if (preset) this.applyPreset(preset)
  }

  private applyPreset(preset: LightingPreset): void {
    // Animate ambient light color and intensity
    const targetColor = new THREE.Color(preset.ambient)
      .lerp(new THREE.Color(0xffd699), this.growthWarmth * 0.2)

    gsap.to(this.ambientLight.color, {
      r: targetColor.r,
      g: targetColor.g,
      b: targetColor.b,
      duration: this.transitionDuration,
      ease: 'power2.inOut',
    })

    gsap.to(this.ambientLight, {
      intensity: preset.intensity,
      duration: this.transitionDuration,
      ease: 'power2.inOut',
    })

    // If we have a main directional light, adjust it too
    if (this.mainLight) {
      const mainIntensity = preset.intensity * 2 // Main light is typically stronger
      gsap.to(this.mainLight, {
        intensity: mainIntensity,
        duration: this.transitionDuration,
        ease: 'power2.inOut',
      })
    }

    // Handle red accent lights
    const redIntensity = preset.redAccent ? 0.3 : 0
    this.redAccentLights.forEach(light => {
      gsap.to(light, {
        intensity: redIntensity,
        duration: this.transitionDuration,
        ease: 'power2.inOut',
      })
    })

    // Add pulsing effect for critical state
    if (preset.redAccent) {
      this.startCriticalPulse()
    } else {
      this.stopCriticalPulse()
    }
  }

  // A PR just failed CI — the warning lamps wash the room red for a beat,
  // then settle back to whatever the current preset wants them at.
  public ciFailFlash(): void {
    const preset = LIGHTING_PRESETS[this.currentPreset]
    const restIntensity = preset?.redAccent ? 0.3 : 0
    this.redAccentLights.forEach((light, i) => {
      gsap.killTweensOf(light)
      gsap.timeline()
        .to(light, { intensity: 0.55, duration: 0.25, ease: 'power2.out', delay: i * 0.06 })
        .to(light, { intensity: restIntensity, duration: 1.6, ease: 'power2.inOut', delay: 0.5 })
    })
  }

  // An epoch just kicked off — the lab lights warm up like instruments
  // powering on, then ease back to the preset level.
  public epochWarmUp(): void {
    const baseIntensity = this.ambientLight.intensity
    gsap.killTweensOf(this.ambientLight)
    gsap.timeline()
      .to(this.ambientLight, { intensity: baseIntensity * 1.35, duration: 1.2, ease: 'power2.out' })
      .to(this.ambientLight, { intensity: baseIntensity, duration: 2.5, ease: 'sine.inOut' })
    if (this.mainLight) {
      const mainBase = this.mainLight.intensity
      gsap.killTweensOf(this.mainLight)
      gsap.timeline()
        .to(this.mainLight, { intensity: mainBase * 1.25, duration: 1.2, ease: 'power2.out' })
        .to(this.mainLight, { intensity: mainBase, duration: 2.5, ease: 'sine.inOut' })
    }
  }

  private criticalPulseTimeline: gsap.core.Timeline | null = null

  private startCriticalPulse(): void {
    if (this.criticalPulseTimeline) return

    this.criticalPulseTimeline = gsap.timeline({ repeat: -1 })

    this.redAccentLights.forEach((light, i) => {
      this.criticalPulseTimeline!.to(
        light,
        {
          intensity: 0.5,
          duration: 0.8,
          ease: 'sine.inOut',
          yoyo: true,
          repeat: 1,
        },
        i * 0.2 // Stagger
      )
    })
  }

  private stopCriticalPulse(): void {
    if (this.criticalPulseTimeline) {
      this.criticalPulseTimeline.kill()
      this.criticalPulseTimeline = null
    }
  }

  // Get current preset name
  public getCurrentPreset(): string {
    return this.currentPreset
  }

  // Set transition duration
  public setTransitionDuration(seconds: number): void {
    this.transitionDuration = seconds
  }

  // Dispose of resources
  public dispose(): void {
    this.stopCriticalPulse()
    this.redAccentLights.forEach(light => {
      this.scene.remove(light)
      light.dispose()
    })
    this.redAccentLights = []
  }
}
