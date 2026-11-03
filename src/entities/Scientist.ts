import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js'
import gsap from 'gsap'
import { COLORS, StationRole } from '../scene/colors'
import { LAB_POIS, LAB_RACK_POI } from '../scene/LabDetails'

export type ModelId = 'gemini' | 'deepseek' | 'claude' | 'gpt' | 'grok'

type BehaviorState =
  | 'idle'
  | 'walkingToPlant'
  | 'observingPlant'
  | 'walkingToStation'
  | 'working'
  | 'walkingToColleague'
  | 'conversing'
  | 'thinking'
  | 'walkingToPOI'
  | 'atPOI'
  | 'eureka'
  | 'frustrated'
  | 'pointing'

export interface ScientistState {
  modelId: ModelId
  role: StationRole
  behavior: BehaviorState
  stationIndex: number
  conversationPartner: Scientist | null
}

// Character configuration for each AI model
const CHARACTER_CONFIG: Record<ModelId, {
  path: string
  scale: number
  accentColor: number
}> = {
  claude: {
    path: '/models/scientists/claude/Male_LongSleeve.gltf',
    scale: 0.004,
    accentColor: COLORS.models.claude, // Orange
  },
  gpt: {
    path: '/models/scientists/gpt/Female_Dress.gltf',
    scale: 0.004,
    accentColor: COLORS.models.gpt, // Purple/Green
  },
  gemini: {
    path: '/models/scientists/gemini/Female_Alternative.gltf',
    scale: 0.004,
    accentColor: COLORS.models.gemini, // Blue
  },
  grok: {
    path: '/models/scientists/grok/Male_Casual.gltf',
    scale: 0.004,
    accentColor: COLORS.models.grok, // Twitter blue
  },
  deepseek: {
    path: '/models/scientists/deepseek/Female_TankTop.gltf',
    scale: 0.004,
    accentColor: COLORS.models.deepseek, // DeepSeek green
  },
}

// Animation name mapping - Quaternius animations to our behavior states
// Male models use Man_*, Female models use Female_*
const ANIMATION_MAP: Record<string, string[]> = {
  idle: ['idle', 'man_idle', 'female_idle'],
  standing: ['standing', 'man_standing', 'female_standing'],
  walking: ['walk', 'walking', 'man_walk', 'female_walk'],
  jump: ['jump', 'man_jump', 'female_jump'],
}

export class Scientist {
  public group: THREE.Group
  public mixer: THREE.AnimationMixer | null = null
  public animations: Map<string, THREE.AnimationAction> = new Map()

  private state: ScientistState
  private currentAction: THREE.AnimationAction | null = null
  private model: THREE.Group | null = null
  private loaded: boolean = false

  // Position tracking
  private stationPosition: THREE.Vector3
  private plantPosition: THREE.Vector3 = new THREE.Vector3(0, 0, 0)
  private targetPosition: THREE.Vector3
  private currentPosition: THREE.Vector3
  private poiLook: THREE.Vector3 = new THREE.Vector3() // what to face while at a point of interest
  private waypoints: THREE.Vector3[] = [] // detour points to route around the central terrarium

  // Animation state
  private walkPhase: number = 0
  private behaviorTimer: number = 0
  private nextBehaviorTime: number = 0
  private time: number = 0

  // Epoch activation state
  private isActiveInEpoch: boolean = false
  private activeGlowIntensity: number = 0
  // When a directed conversation is set up, how long to hold it once they meet.
  private directedConvoSec: number | null = null
  private accentMaterials: THREE.MeshStandardMaterial[] = []

  // Speech indicator for conversations
  private speechIndicator: THREE.Group | null = null
  private speechDots: THREE.Mesh[] = []
  private speechTime: number = 0

  // Thinking indicator for active work
  private thinkingIndicator: THREE.Group | null = null
  private thinkingTime: number = 0

  // Idle life: subtle breathing, and dust puffs kicked up while walking
  private baseScale: number = 1
  private breathePhase: number = Math.random() * Math.PI * 2
  private lastStepPhase: number = 0
  private dustPuffs: Array<{ sprite: THREE.Sprite; t: number }> = []
  private static dustTexture: THREE.Texture | null = null

  // Static reference to all scientists for social interactions
  private static allScientists: Scientist[] = []

  private static getDustTexture(): THREE.Texture {
    if (!Scientist.dustTexture) {
      const c = document.createElement('canvas')
      c.width = c.height = 32
      const ctx = c.getContext('2d')!
      const g = ctx.createRadialGradient(16, 16, 1, 16, 16, 16)
      g.addColorStop(0, 'rgba(210, 195, 170, 0.55)')
      g.addColorStop(1, 'rgba(210, 195, 170, 0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, 32, 32)
      Scientist.dustTexture = new THREE.CanvasTexture(c)
    }
    return Scientist.dustTexture
  }

  constructor(modelId: ModelId, role: StationRole, stationIndex: number) {
    this.state = {
      modelId,
      role,
      behavior: 'idle',
      stationIndex,
      conversationPartner: null,
    }

    this.group = new THREE.Group()
    this.group.name = `scientist_${modelId}`

    // Calculate station position
    const angle = (stationIndex * 2 * Math.PI) / 5 - Math.PI / 2
    const radius = 5.0
    this.stationPosition = new THREE.Vector3(
      Math.cos(angle) * radius,
      0,
      Math.sin(angle) * radius
    )
    this.currentPosition = this.stationPosition.clone()
    this.targetPosition = this.stationPosition.clone()

    // Initial position
    this.group.position.copy(this.stationPosition)

    // Register this scientist for social interactions
    Scientist.allScientists.push(this)

    // Schedule first behavior change
    this.scheduleNextBehavior()
  }

  public static clearAllScientists(): void {
    Scientist.allScientists = []
  }

  public getStationPosition(): THREE.Vector3 {
    return this.stationPosition.clone()
  }

  // Walk back to this scientist's own desk (e.g. when it starts writing/committing code).
  public returnToStation(): void {
    this.state.behavior = 'walkingToStation'
    this.routeAround(this.stationPosition)
    this.walkPhase = 0
    this.playAnimation('walking')
  }

  public isLoaded(): boolean {
    return this.loaded
  }

  async load(): Promise<void> {
    const config = CHARACTER_CONFIG[this.state.modelId]
    if (!config) {
      throw new Error(`Unknown model ID: ${this.state.modelId}`)
    }

    const loader = new GLTFLoader()

    return new Promise((resolve, reject) => {
      loader.load(
        config.path,
        (gltf: GLTF) => {
          // Add loaded model to group
          this.model = gltf.scene
          this.model.scale.setScalar(config.scale)
          this.baseScale = config.scale

          this.group.add(this.model)

          // Enable shadows and collect accent materials
          this.model.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              child.castShadow = true
              child.receiveShadow = true

              // Store materials that could be used for accent glow
              if (child.material instanceof THREE.MeshStandardMaterial) {
                // Clone material so we can modify it per-scientist
                const mat = child.material.clone()
                child.material = mat

                // Check if this is a colored/accent material (not skin, not white)
                const hsl = { h: 0, s: 0, l: 0 }
                mat.color.getHSL(hsl)
                if (hsl.s > 0.2 && hsl.l > 0.2 && hsl.l < 0.9) {
                  this.accentMaterials.push(mat)
                }
              }
            }
          })

          // Setup animation mixer
          if (gltf.animations.length > 0) {
            this.mixer = new THREE.AnimationMixer(this.model)

            // Store all available animations with normalized names
            gltf.animations.forEach((clip) => {
              const action = this.mixer!.clipAction(clip)
              // Normalize name: remove prefix, lowercase
              const normalizedName = clip.name
                .toLowerCase()
                .replace('humanarmature|', '')
                .replace('man_', '')
                .replace('female_', '')
              this.animations.set(normalizedName, action)

              // Also store with intermediate name (e.g., 'man_idle', 'female_idle')
              const intermediateName = clip.name.toLowerCase().replace('humanarmature|', '')
              this.animations.set(intermediateName, action)

              // Also store with original name
              this.animations.set(clip.name.toLowerCase(), action)

              if (import.meta.env.DEV) {
                console.log(`[${this.state.modelId}] Animation loaded: ${clip.name} -> ${normalizedName}`)
              }
            })

            // Play idle animation by default
            this.playAnimation('idle')
          }

          // Face the station (away from center)
          this.faceStation()

          this.loaded = true
          resolve()
        },
        (progress) => {
          // Optional: loading progress
          if (import.meta.env.DEV && progress.total > 0) {
            const percent = (progress.loaded / progress.total) * 100
            if (percent === 100) {
              console.log(`[${this.state.modelId}] Model loaded`)
            }
          }
        },
        (error) => {
          console.error(`Failed to load scientist ${this.state.modelId}:`, error)
          reject(error)
        }
      )
    })
  }

  playAnimation(name: string, fadeTime: number = 0.3): void {
    if (!this.mixer) return

    // Try to find animation using our mapping
    const variations = ANIMATION_MAP[name] || [name]

    let action: THREE.AnimationAction | undefined

    // Try each variation
    for (const variant of variations) {
      action = this.animations.get(variant)
      if (action) break
    }

    // Fallback to direct name lookup
    if (!action) {
      action = this.animations.get(name.toLowerCase())
    }

    if (!action) {
      // Final fallback - try to find any animation containing the name
      for (const [key, anim] of this.animations) {
        if (key.includes(name.toLowerCase())) {
          action = anim
          break
        }
      }
    }

    if (!action) {
      // Ultimate fallback - just play the first available animation
      if (this.animations.size > 0) {
        action = this.animations.values().next().value
        if (import.meta.env.DEV) {
          console.warn(`[${this.state.modelId}] Animation '${name}' not found, using first available`)
        }
      }
    }

    if (!action) {
      if (import.meta.env.DEV) {
        console.warn(`[${this.state.modelId}] No animations available`)
      }
      return
    }

    if (this.currentAction === action) return

    // Crossfade to new animation
    if (this.currentAction) {
      this.currentAction.fadeOut(fadeTime)
    }

    action.reset().fadeIn(fadeTime).play()
    this.currentAction = action
  }

  private createSpeechIndicator(): void {
    if (this.speechIndicator) return

    this.speechIndicator = new THREE.Group()
    this.speechIndicator.name = 'speechIndicator'

    // Create three dots
    const dotGeometry = new THREE.SphereGeometry(0.04, 8, 6)
    const dotMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xffffff,
      emissiveIntensity: 0.3,
      transparent: true,
      opacity: 0.9,
    })

    const spacing = 0.12
    for (let i = 0; i < 3; i++) {
      const dot = new THREE.Mesh(dotGeometry, dotMaterial.clone())
      dot.position.set((i - 1) * spacing, 0, 0)
      this.speechDots.push(dot)
      this.speechIndicator.add(dot)
    }

    // Position above the scientist's head and model label
    this.speechIndicator.position.set(0, 2.5, 0)
    this.speechIndicator.visible = false

    this.group.add(this.speechIndicator)
  }

  private showSpeechIndicator(): void {
    if (!this.speechIndicator) {
      this.createSpeechIndicator()
    }
    if (this.speechIndicator) {
      this.speechIndicator.visible = true
      this.speechTime = 0
    }
  }

  private hideSpeechIndicator(): void {
    if (this.speechIndicator) {
      this.speechIndicator.visible = false
    }
  }

  private createThinkingIndicator(): void {
    if (this.thinkingIndicator) return

    this.thinkingIndicator = new THREE.Group()
    this.thinkingIndicator.name = 'thinkingIndicator'

    // Create a rotating ring of small dots
    const ringRadius = 0.15
    const dotCount = 6
    const dotGeometry = new THREE.SphereGeometry(0.025, 6, 4)

    for (let i = 0; i < dotCount; i++) {
      const angle = (i / dotCount) * Math.PI * 2
      const dotMaterial = new THREE.MeshStandardMaterial({
        color: CHARACTER_CONFIG[this.state.modelId].accentColor,
        emissive: CHARACTER_CONFIG[this.state.modelId].accentColor,
        emissiveIntensity: 0.5,
        transparent: true,
        opacity: 0.3 + (i / dotCount) * 0.7, // Gradient opacity
      })
      const dot = new THREE.Mesh(dotGeometry, dotMaterial)
      dot.position.set(
        Math.cos(angle) * ringRadius,
        0,
        Math.sin(angle) * ringRadius
      )
      this.thinkingIndicator.add(dot)
    }

    // Position above the scientist's head
    this.thinkingIndicator.position.set(0, 2.7, 0)
    this.thinkingIndicator.rotation.x = -Math.PI / 4 // Tilt toward camera
    this.thinkingIndicator.visible = false

    this.group.add(this.thinkingIndicator)
  }

  private showThinkingIndicator(): void {
    if (!this.thinkingIndicator) {
      this.createThinkingIndicator()
    }
    if (this.thinkingIndicator) {
      this.thinkingIndicator.visible = true
      this.thinkingTime = 0
    }
  }

  private hideThinkingIndicator(): void {
    if (this.thinkingIndicator) {
      this.thinkingIndicator.visible = false
    }
  }

  private updateThinkingIndicator(deltaTime: number): void {
    if (!this.thinkingIndicator || !this.thinkingIndicator.visible) return

    this.thinkingTime += deltaTime

    // Rotate the ring
    this.thinkingIndicator.rotation.y = this.thinkingTime * 2

    // Pulse the dots
    this.thinkingIndicator.children.forEach((dot, i) => {
      const phase = this.thinkingTime * 3 + i * 0.5
      const scale = 0.8 + Math.sin(phase) * 0.2
      dot.scale.setScalar(scale)
    })
  }

  private updateSpeechIndicator(deltaTime: number): void {
    if (!this.speechIndicator || !this.speechIndicator.visible) return

    this.speechTime += deltaTime

    // Animate each dot with a wave pattern
    const speed = 3.0
    const waveDelay = 0.3

    this.speechDots.forEach((dot, i) => {
      // Staggered bounce animation
      const phase = this.speechTime * speed - i * waveDelay
      const bounce = Math.max(0, Math.sin(phase)) * 0.08

      // Base Y position with bounce
      dot.position.y = bounce

      // Pulse opacity/scale
      const pulse = 0.7 + Math.max(0, Math.sin(phase)) * 0.3
      dot.scale.setScalar(pulse)

      // Update material opacity
      const mat = dot.material as THREE.MeshStandardMaterial
      mat.opacity = 0.5 + Math.max(0, Math.sin(phase)) * 0.5
    })

    // Make indicator face the camera (billboard effect) - rotate around Y only
    // The indicator should face outward from the scientist
    this.speechIndicator.rotation.y = -this.group.rotation.y
  }

  private faceCenter(): void {
    // Face toward center (plant)
    const dx = this.plantPosition.x - this.group.position.x
    const dz = this.plantPosition.z - this.group.position.z
    this.group.rotation.y = Math.atan2(dx, dz)
  }

  private faceStation(): void {
    // Face away from center (toward the desk/station)
    const dx = this.group.position.x - this.plantPosition.x
    const dz = this.group.position.z - this.plantPosition.z
    this.group.rotation.y = Math.atan2(dx, dz)
  }

  private facePosition(target: THREE.Vector3): void {
    // Face toward target position (for walking)
    const dx = target.x - this.group.position.x
    const dz = target.z - this.group.position.z
    this.group.rotation.y = Math.atan2(dx, dz)
  }

  private scheduleNextBehavior(): void {
    // Random time until next behavior change (5-15 seconds)
    this.nextBehaviorTime = 5 + Math.random() * 10
    this.behaviorTimer = 0
  }

  public update(deltaTime: number): void {
    this.time += deltaTime
    this.behaviorTimer += deltaTime

    // Update animation mixer
    if (this.mixer) {
      this.mixer.update(deltaTime)
    }

    // Check if it's time for a behavior change
    if (this.behaviorTimer >= this.nextBehaviorTime) {
      this.transitionBehavior()
    }

    // Update based on current behavior
    switch (this.state.behavior) {
      case 'walkingToPlant':
      case 'walkingToStation':
      case 'walkingToColleague':
      case 'walkingToPOI':
        this.updateWalking(deltaTime)
        break
      case 'observingPlant':
        this.faceCenter()
        break
      case 'atPOI':
        this.facePosition(this.poiLook)
        this.applyRestingSeparation(deltaTime)
        break
      case 'working':
        this.faceStation()
        break
      case 'idle':
      case 'thinking':
        this.faceStation()
        this.applyRestingSeparation(deltaTime)
        break
      case 'conversing':
        if (this.state.conversationPartner) {
          this.facePosition(this.state.conversationPartner.group.position)
        }
        this.updateSpeechIndicator(deltaTime)
        break
    }

    // Update thinking indicator if active
    if (this.isActiveInEpoch) {
      this.updateThinkingIndicator(deltaTime)
    }

    // Subtle idle breathing on the model itself (not while striding)
    const walking = this.state.behavior.startsWith('walking')
    if (this.model) {
      const b = walking ? 1 : 1 + 0.012 * Math.sin(this.time * 1.7 + this.breathePhase)
      this.model.scale.set(this.baseScale, this.baseScale * b, this.baseScale)
    }

    // Fade out footfall dust puffs
    for (let i = this.dustPuffs.length - 1; i >= 0; i--) {
      const p = this.dustPuffs[i]
      p.t += deltaTime
      const a = p.t / 0.7
      if (a >= 1) {
        p.sprite.parent?.remove(p.sprite)
        p.sprite.material.dispose()
        this.dustPuffs.splice(i, 1)
        continue
      }
      const sc = 0.05 + a * 0.1
      p.sprite.scale.set(sc, sc * 0.6, 1)
      p.sprite.material.opacity = 0.3 * (1 - a)
      p.sprite.position.y += deltaTime * 0.03
    }
  }

  private spawnFootDust(): void {
    const parent = this.group.parent
    if (!parent || this.dustPuffs.length >= 4) return
    const mat = new THREE.SpriteMaterial({
      map: Scientist.getDustTexture(), transparent: true, opacity: 0.3, depthWrite: false,
    })
    const sprite = new THREE.Sprite(mat)
    sprite.position.set(
      this.group.position.x + (Math.random() - 0.5) * 0.08,
      0.03,
      this.group.position.z + (Math.random() - 0.5) * 0.08
    )
    sprite.scale.set(0.05, 0.03, 1)
    parent.add(sprite)
    this.dustPuffs.push({ sprite, t: 0 })
  }

  private transitionBehavior(): void {
    // The active scientist stays at its desk working until its turn ends
    // (don't interrupt it mid-return).
    if (this.isActiveInEpoch) {
      if (this.state.behavior !== 'working' && this.state.behavior !== 'walkingToStation') {
        this.startWorking()
      } else {
        this.scheduleNextBehavior()
      }
      return
    }

    const currentBehavior = this.state.behavior

    // State machine transitions
    switch (currentBehavior) {
      case 'idle':
        // Randomly choose next action
        const rand = Math.random()

        if (rand < 0.2) {
          this.startVisitPOI()
        } else if (rand < 0.34) {
          this.startWalkingToPlant()
        } else if (rand < 0.5) {
          this.startWorking()
        } else if (rand < 0.68) {
          this.tryStartConversation()
        } else if (rand < 0.82) {
          this.startThinking()
        } else {
          // Stay idle a bit longer
          this.scheduleNextBehavior()
        }
        break
      case 'observingPlant':
        this.startWalkingToStation()
        break
      case 'atPOI':
        // Done at the coffee/whiteboard/bookshelf — head back to the station
        this.startWalkingToStation()
        break
      case 'working':
        this.state.behavior = 'idle'
        this.playAnimation('idle') // Return to relaxed idle
        this.scheduleNextBehavior()
        break
      case 'conversing':
        this.endConversation()
        break
      case 'thinking':
        this.state.behavior = 'idle'
        this.playAnimation('idle') // Return to relaxed idle
        this.scheduleNextBehavior()
        break
      case 'eureka':
      case 'frustrated':
      case 'pointing':
        // These return to idle automatically
        break
    }
  }

  private startThinking(): void {
    this.state.behavior = 'thinking'
    this.faceStation()
    this.playAnimation('idle') // Thoughtful pose
    this.scheduleNextBehavior()
  }

  private tryStartConversation(): void {
    // Check if there's already a conversation happening
    const activeConversations = Scientist.allScientists.filter(
      (s) => s.state.behavior === 'conversing' || s.state.behavior === 'walkingToColleague'
    ).length

    if (activeConversations >= 2) {
      this.scheduleNextBehavior()
      return
    }

    // Find an available colleague
    const availableColleagues = Scientist.allScientists.filter(
      (s) =>
        s !== this &&
        (s.state.behavior === 'idle' || s.state.behavior === 'working') &&
        s.state.conversationPartner === null
    )

    if (availableColleagues.length === 0) {
      this.scheduleNextBehavior()
      return
    }

    // Pick a random colleague
    const colleague = availableColleagues[Math.floor(Math.random() * availableColleagues.length)]

    // Set up conversation
    this.state.conversationPartner = colleague
    colleague.state.conversationPartner = this

    // Calculate meeting point
    const myPos = this.stationPosition
    const theirPos = colleague.getStationPosition()

    const myAngle = Math.atan2(myPos.z, myPos.x)
    const theirAngle = Math.atan2(theirPos.z, theirPos.x)

    let angleDiff = theirAngle - myAngle
    if (angleDiff > Math.PI) angleDiff -= Math.PI * 2
    if (angleDiff < -Math.PI) angleDiff += Math.PI * 2
    const midAngle = myAngle + angleDiff / 2

    const meetingRadius = 3.5
    const meetingCenter = new THREE.Vector3(
      Math.cos(midAngle) * meetingRadius,
      0,
      Math.sin(midAngle) * meetingRadius
    )

    const direction = new THREE.Vector3()
      .subVectors(theirPos, myPos)
      .normalize()

    const separationDistance = 0.4

    const myMeetingPos = meetingCenter.clone().sub(
      direction.clone().multiplyScalar(separationDistance)
    )
    const theirMeetingPos = meetingCenter.clone().add(
      direction.clone().multiplyScalar(separationDistance)
    )

    // Start walking
    this.state.behavior = 'walkingToColleague'
    this.routeAround(myMeetingPos)
    this.walkPhase = 0
    this.playAnimation('walking')

    colleague.state.behavior = 'walkingToColleague'
    colleague.routeAround(theirMeetingPos)
    colleague.walkPhase = 0
    colleague.playAnimation('walking')
  }

  private endConversation(): void {
    const partner = this.state.conversationPartner

    this.hideSpeechIndicator() // Hide speech dots
    this.state.conversationPartner = null
    this.state.behavior = 'walkingToStation'
    this.routeAround(this.stationPosition)
    this.playAnimation('walking')
    this.scheduleNextBehavior()

    if (partner && partner.state.conversationPartner === this) {
      partner.hideSpeechIndicator() // Hide partner's speech dots
      partner.state.conversationPartner = null
      partner.state.behavior = 'walkingToStation'
      partner.targetPosition = partner.stationPosition.clone()
      partner.playAnimation('walking')
      partner.scheduleNextBehavior()
    }
  }

  // Directed conversation: THIS scientist and `partner` walk toward each other,
  // meet, face off, and show speech indicators for `durationSec`, then return
  // to their stations. Driven by the real epoch pipeline (a handoff or the
  // rebuttal debate) rather than the random idle chatter — grounded, not filler.
  public converseWith(partner: Scientist, durationSec = 5): void {
    if (partner === this) return
    // Free both from any desk-lock or in-flight behavior.
    this.isActiveInEpoch = false
    partner.isActiveInEpoch = false

    this.state.conversationPartner = partner
    partner.state.conversationPartner = this

    const myPos = this.stationPosition
    const theirPos = partner.getStationPosition()
    const myAngle = Math.atan2(myPos.z, myPos.x)
    const theirAngle = Math.atan2(theirPos.z, theirPos.x)
    let angleDiff = theirAngle - myAngle
    if (angleDiff > Math.PI) angleDiff -= Math.PI * 2
    if (angleDiff < -Math.PI) angleDiff += Math.PI * 2
    const midAngle = myAngle + angleDiff / 2
    const meetingCenter = new THREE.Vector3(Math.cos(midAngle) * 3.5, 0, Math.sin(midAngle) * 3.5)
    const dir = new THREE.Vector3().subVectors(theirPos, myPos).normalize()

    this.directedConvoSec = durationSec
    partner.directedConvoSec = durationSec

    this.state.behavior = 'walkingToColleague'
    this.routeAround(meetingCenter.clone().sub(dir.clone().multiplyScalar(0.4)))
    this.walkPhase = 0
    this.playAnimation('walking')

    partner.state.behavior = 'walkingToColleague'
    partner.routeAround(meetingCenter.clone().add(dir.clone().multiplyScalar(0.4)))
    partner.walkPhase = 0
    partner.playAnimation('walking')
  }

  // A quick celebratory hop — used when this scientist's code really merges.
  public celebrate(): void {
    if (this.state.behavior === 'conversing' || this.state.behavior === 'walkingToColleague') return
    this.playAnimation('jump')
    window.setTimeout(() => {
      if (this.state.behavior === 'idle' || this.state.behavior === 'working') this.playAnimation('idle')
    }, 1200)
  }

  private startWalkingToPlant(): void {
    const observingCount = Scientist.allScientists.filter(
      (s) => s.state.behavior === 'observingPlant' || s.state.behavior === 'walkingToPlant'
    ).length

    if (observingCount >= 1) {
      this.scheduleNextBehavior()
      return
    }

    this.state.behavior = 'walkingToPlant'
    const angle = (this.state.stationIndex * 2 * Math.PI) / 5 - Math.PI / 2
    const nearPlantRadius = 2.5
    this.routeAround(new THREE.Vector3(
      Math.cos(angle) * nearPlantRadius,
      0,
      Math.sin(angle) * nearPlantRadius
    ))
    this.walkPhase = 0
    this.playAnimation('walking')
  }

  private startWalkingToStation(): void {
    this.state.behavior = 'walkingToStation'
    this.routeAround(this.stationPosition)
    this.walkPhase = 0
    this.playAnimation('walking')
  }

  // Walk to a point of interest (coffee, whiteboard, bookshelf), linger, then
  // return — gives movement a sense of purpose instead of random wandering.
  private startVisitPOI(): void {
    // Avoid crowding: skip a POI another scientist is already at/heading to
    const taken = new Set(
      Scientist.allScientists
        .filter((s) => s !== this && (s.state.behavior === 'walkingToPOI' || s.state.behavior === 'atPOI'))
        .map((s) => `${s.targetPosition.x.toFixed(1)},${s.targetPosition.z.toFixed(1)}`)
    )
    const open = LAB_POIS.filter((p) => !taken.has(`${p.stand[0].toFixed(1)},${p.stand[2].toFixed(1)}`))
    const pool = open.length > 0 ? open : LAB_POIS
    const choice = pool[Math.floor(Math.random() * pool.length)]

    this.poiLook.set(choice.look[0], choice.look[1], choice.look[2])
    this.routeAround(new THREE.Vector3(choice.stand[0], choice.stand[1], choice.stand[2]))
    this.state.behavior = 'walkingToPOI'
    this.walkPhase = 0
    this.playAnimation('walking')
  }

  public startWorking(): void {
    this.state.behavior = 'working'
    this.faceStation()
    this.playAnimation('idle') // Working pose at desk
    this.scheduleNextBehavior()
  }

  public stopWorking(): void {
    this.state.behavior = 'idle'
    this.playAnimation('idle')
    this.scheduleNextBehavior()
  }

  private updateWalking(deltaTime: number): void {
    const walkSpeed = 0.8
    // Steer toward the next detour waypoint (if any), then the final target.
    const steer = this.waypoints.length > 0 ? this.waypoints[0] : this.targetPosition
    const direction = new THREE.Vector3().subVectors(steer, this.group.position)
    direction.y = 0
    const distance = direction.length()

    if (distance < 0.1) {
      // Reached a detour waypoint — snap to it and continue to the next/target.
      if (this.waypoints.length > 0) {
        this.group.position.x = steer.x
        this.group.position.z = steer.z
        this.currentPosition.copy(this.group.position)
        this.waypoints.shift()
        return
      }

      // Reached final destination
      this.group.position.copy(this.targetPosition)
      this.currentPosition.copy(this.targetPosition)

      if (this.state.behavior === 'walkingToPlant') {
        this.state.behavior = 'observingPlant'
        this.faceCenter()
        this.playAnimation('idle') // Observing plant
        this.scheduleNextBehavior()
      } else if (this.state.behavior === 'walkingToStation') {
        if (this.isActiveInEpoch) {
          this.startWorking()
        } else {
          this.state.behavior = 'idle'
          this.faceStation()
          this.playAnimation('idle')
          this.scheduleNextBehavior()
        }
      } else if (this.state.behavior === 'walkingToColleague') {
        this.state.behavior = 'conversing'
        this.playAnimation('idle') // Subtle movement while talking
        this.showSpeechIndicator() // Show speech dots
        // A directed (pipeline-driven) conversation holds for a set time; a
        // random one uses the default 5-15s scheduler.
        if (this.directedConvoSec !== null) {
          this.nextBehaviorTime = this.directedConvoSec
          this.behaviorTimer = 0
          this.directedConvoSec = null
        } else {
          this.scheduleNextBehavior()
        }
        if (this.state.conversationPartner) {
          this.facePosition(this.state.conversationPartner.group.position)
        }
      } else if (this.state.behavior === 'walkingToPOI') {
        this.state.behavior = 'atPOI'
        this.facePosition(this.poiLook)
        this.playAnimation('idle') // linger at the coffee/whiteboard/bookshelf
        this.scheduleNextBehavior()
      }
      return
    }

    // Move toward the current steer point, with light separation from nearby
    // colleagues so they don't overlap. A conversation partner is never repelled,
    // so meeting up to talk (stopping face-to-face with speech dots) is untouched.
    direction.normalize()
    const R = 0.85
    const sep = new THREE.Vector3()
    for (const other of Scientist.allScientists) {
      if (other === this || other === this.state.conversationPartner) continue
      const away = new THREE.Vector3().subVectors(this.group.position, other.group.position)
      away.y = 0
      const dist = away.length()
      if (dist > 1e-4 && dist < R) {
        const strength = (R - dist) / R
        away.normalize()
        sep.addScaledVector(away, strength)
        // Sideways component (consistent handedness) so head-on / converging agents
        // flow AROUND each other instead of pushing straight back and overlapping.
        sep.addScaledVector(new THREE.Vector3(-away.z, 0, away.x), strength * 0.7)
      }
    }
    if (sep.lengthSq() > 0) {
      direction.addScaledVector(sep, 1.2).normalize()
    }
    const moveAmount = Math.min(walkSpeed * deltaTime, distance)
    this.group.position.add(direction.multiplyScalar(moveAmount))
    this.currentPosition.copy(this.group.position)

    // Face walking direction
    this.facePosition(steer)

    this.walkPhase += deltaTime * 8

    // Each footfall (every half stride) kicks up a small dust puff
    if (Math.floor(this.walkPhase / Math.PI) > Math.floor(this.lastStepPhase / Math.PI)) {
      this.spawnFootDust()
    }
    this.lastStepPhase = this.walkPhase
  }

  // Gently push a standing (idle / at-POI) scientist out of another's personal
  // space so two never end up overlapping at rest. Skips conversation partners.
  private applyRestingSeparation(dt: number): void {
    const R = 0.6
    const push = new THREE.Vector3()
    for (const other of Scientist.allScientists) {
      if (other === this || other === this.state.conversationPartner) continue
      const away = new THREE.Vector3().subVectors(this.group.position, other.group.position)
      away.y = 0
      const d = away.length()
      if (d > 1e-4 && d < R) push.addScaledVector(away.normalize(), (R - d) / R)
    }
    if (push.lengthSq() > 0) {
      this.group.position.addScaledVector(push.normalize(), Math.min(0.6 * dt, 0.06))
      this.currentPosition.copy(this.group.position)
    }
  }

  // Set a walk target, inserting a waypoint to route around the central terrarium.
  private routeAround(target: THREE.Vector3): void {
    this.targetPosition = target.clone()
    this.waypoints = []
    const A = new THREE.Vector3(this.group.position.x, 0, this.group.position.z)
    const B = new THREE.Vector3(target.x, 0, target.z)
    const ab = new THREE.Vector3().subVectors(B, A)
    const len2 = ab.lengthSq()
    const t = len2 > 1e-6 ? THREE.MathUtils.clamp((-A.dot(ab)) / len2, 0, 1) : 0
    const closest = A.clone().addScaledVector(ab, t)
    const AVOID = 1.9
    if (closest.length() >= AVOID) return // straight path already clears the terrarium

    let mid = new THREE.Vector3().addVectors(A, B).multiplyScalar(0.5)
    if (mid.length() < 0.6) {
      // Start/target nearly diametric through the center — step to one side.
      const dir = ab.clone().normalize()
      mid = new THREE.Vector3(-dir.z, 0, dir.x)
    }
    this.waypoints = [mid.setLength(2.7)]
  }

  // Walk to the compute rack (e.g., when accessing Modal / GPU work), then return.
  public goToRack(): void {
    if (this.state.conversationPartner) return
    this.poiLook.set(LAB_RACK_POI.look[0], LAB_RACK_POI.look[1], LAB_RACK_POI.look[2])
    this.state.behavior = 'walkingToPOI'
    this.walkPhase = 0
    this.routeAround(new THREE.Vector3(LAB_RACK_POI.stand[0], LAB_RACK_POI.stand[1], LAB_RACK_POI.stand[2]))
    this.playAnimation('walking')
  }

  // Public API
  public changeRole(newRole: StationRole): void {
    this.state.role = newRole

    // Visual feedback - small hop
    gsap.to(this.group.position, {
      y: this.group.position.y + 0.1,
      duration: 0.2,
      ease: 'power2.out',
      yoyo: true,
      repeat: 1,
    })
  }

  public getModelId(): ModelId {
    return this.state.modelId
  }

  public getRole(): StationRole {
    return this.state.role
  }

  public getStationIndex(): number {
    return this.state.stationIndex
  }

  public getBehavior(): BehaviorState {
    return this.state.behavior
  }

  public setActiveInEpoch(active: boolean): void {
    if (this.isActiveInEpoch === active) return

    this.isActiveInEpoch = active

    if (active) {
      // Head to the desk to work this turn; if already there, start immediately.
      const atDesk = this.group.position.distanceTo(this.stationPosition) < 0.6
      if (atDesk) this.startWorking()
      else this.returnToStation() // the active-gate keeps it working on arrival
      this.showThinkingIndicator()

      // Animate glow intensity on accent materials
      gsap.to(this, {
        activeGlowIntensity: 0.6,
        duration: 0.5,
        ease: 'power2.out',
        onUpdate: () => {
          this.accentMaterials.forEach((mat) => {
            mat.emissiveIntensity = this.activeGlowIntensity
            mat.emissive.setHex(CHARACTER_CONFIG[this.state.modelId].accentColor)
          })
        },
      })
    } else {
      this.stopWorking()
      this.hideThinkingIndicator()

      gsap.to(this, {
        activeGlowIntensity: 0,
        duration: 0.8,
        ease: 'power2.out',
        onUpdate: () => {
          this.accentMaterials.forEach((mat) => {
            mat.emissiveIntensity = this.activeGlowIntensity
          })
        },
      })
    }
  }

  public isActive(): boolean {
    return this.isActiveInEpoch
  }

  // Trigger special animations
  public triggerEureka(): void {
    this.state.behavior = 'eureka'
    this.playAnimation('jump') // Excited jump animation
    this.scheduleNextBehavior()

    setTimeout(() => {
      this.state.behavior = 'idle'
      this.playAnimation('idle')
    }, 1500)
  }

  public triggerFrustration(): void {
    this.state.behavior = 'frustrated'
    this.playAnimation('idle') // Frustrated stance
    this.scheduleNextBehavior()

    setTimeout(() => {
      this.state.behavior = 'idle'
      this.playAnimation('idle')
    }, 2000)
  }

  public triggerThinking(): void {
    this.state.behavior = 'thinking'
    this.playAnimation('idle') // Thoughtful pose
    this.scheduleNextBehavior()
  }

  public triggerPointAtPlant(): void {
    this.state.behavior = 'pointing'
    this.faceCenter()
    this.playAnimation('idle') // Observing pose

    setTimeout(() => {
      this.state.behavior = 'idle'
      this.faceStation()
      this.playAnimation('idle')
    }, 2000)
  }

  public dispose(): void {
    gsap.killTweensOf(this.group.position)
    gsap.killTweensOf(this)

    if (this.mixer) {
      this.mixer.stopAllAction()
    }

    // Dispose speech indicator
    this.speechDots.forEach((dot) => {
      dot.geometry.dispose()
      ;(dot.material as THREE.Material).dispose()
    })
    this.speechDots = []

    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose()
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => m.dispose())
        } else {
          obj.material.dispose()
        }
      }
    })
  }
}

// Create all five scientists - now returns promises
export function createAllScientists(): Scientist[] {
  const models: ModelId[] = ['gemini', 'deepseek', 'claude', 'gpt', 'grok']
  const roles: StationRole[] = ['planner', 'executor', 'reviewer', 'challenger', 'commentator']

  return models.map((modelId, index) => {
    return new Scientist(modelId, roles[index], index)
  })
}

// Async function to load all scientists
export async function loadAllScientists(scientists: Scientist[]): Promise<void> {
  const loadPromises = scientists.map((scientist) => scientist.load())
  await Promise.all(loadPromises)
  console.log('All scientists loaded')
}
