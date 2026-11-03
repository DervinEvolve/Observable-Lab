import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js'
import gsap from 'gsap'
import {
  ROBOT_WILDCARD,
  WILDCARD_MODELS,
  WILDCARD_DISPLAY_NAMES,
  WILDCARD_ACCENTS,
  type WildcardId,
} from '../shared/types'

// Robot behavior states
type RobotBehaviorState =
  | 'idle'
  | 'walking'
  | 'celebrating'
  | 'disappointed'
  | 'waving'
  | 'dancing'
  | 'punching'
  | 'dead'

// Code events the robot reacts to
export type CodeEvent =
  | 'idle'
  | 'tests_pass'
  | 'all_tests_pass'
  | 'tests_fail'
  | 'build_broken'
  | 'bug_fixing'
  | 'pr_merged'
  | 'epoch_start'
  | 'milestone'

// Robot configuration
const ROBOT_CONFIG = {
  path: '/models/scientists/code/Robot.gltf',
  scale: 0.0018, // ~45% of scientist scale (0.004) - smaller mascot
  idleColor: 0x4fc3f7, // Light blue accent
}

// Movement boundaries - beside planner desk, away from plant dome
// Planner desk is at approximately (0, 0, -5)
// Robot stays to the right side of the desk
const MOVEMENT_ZONE = {
  // Home position - beside the planner desk
  home: new THREE.Vector3(1.8, 0, -4.5),
  // Constrained area to the side of planner desk
  minX: 1.2,
  maxX: 2.8,
  minZ: -5.5,
  maxZ: -3.5,
}

// Animation mapping for code events
const CODE_EVENT_ANIMATIONS: Record<CodeEvent, string[]> = {
  idle: ['robot_idle', 'robot_standing'],
  tests_pass: ['robot_jump', 'robot_thumbsup'],
  all_tests_pass: ['robot_dance'],
  tests_fail: ['robot_no'],
  build_broken: ['robot_death'],
  bug_fixing: ['robot_punch'],
  pr_merged: ['robot_yes', 'robot_thumbsup'],
  epoch_start: ['robot_wave'],
  milestone: ['robot_walkjump', 'robot_dance'],
}

export class Robot {
  public group: THREE.Group
  public mixer: THREE.AnimationMixer | null = null
  public animations: Map<string, THREE.AnimationAction> = new Map()

  // Wildcard identity — the robot is an autonomous R&D agent, not a panel role.
  // It runs a free coding model (default: North) in its own sandbox + branch.
  public wildcard: WildcardId = ROBOT_WILDCARD
  public readonly name: string = WILDCARD_DISPLAY_NAMES[ROBOT_WILDCARD]
  public readonly modelId: string = WILDCARD_MODELS[ROBOT_WILDCARD]
  public readonly accent: number = WILDCARD_ACCENTS[ROBOT_WILDCARD]

  private model: THREE.Group | null = null
  private loaded: boolean = false
  private currentAction: THREE.AnimationAction | null = null
  private behaviorState: RobotBehaviorState = 'idle'

  // Position tracking
  private currentPosition: THREE.Vector3
  private targetPosition: THREE.Vector3
  private homePosition: THREE.Vector3

  // Animation state
  private time: number = 0
  private idleTimer: number = 0
  private nextWanderTime: number = 5
  private fidgetTimer: number = 0
  private nextFidgetTime: number = 7

  // Queue for animation sequences
  private animationQueue: string[] = []
  private isPlayingSequence: boolean = false

  constructor() {
    this.group = new THREE.Group()
    this.group.name = 'robot_mascot'

    // Start position - beside planner desk
    this.homePosition = MOVEMENT_ZONE.home.clone()
    this.currentPosition = this.homePosition.clone()
    this.targetPosition = this.homePosition.clone()

    this.group.position.copy(this.homePosition)
    // Face toward the center/plant
    this.faceDirection(new THREE.Vector3(0, 0, 0))
  }

  public isLoaded(): boolean {
    return this.loaded
  }

  async load(): Promise<void> {
    const loader = new GLTFLoader()

    return new Promise((resolve, reject) => {
      loader.load(
        ROBOT_CONFIG.path,
        (gltf: GLTF) => {
          this.model = gltf.scene
          this.model.scale.setScalar(ROBOT_CONFIG.scale)

          this.group.add(this.model)

          // Enable shadows
          this.model.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              child.castShadow = true
              child.receiveShadow = true
            }
          })

          // Setup animation mixer
          if (gltf.animations.length > 0) {
            this.mixer = new THREE.AnimationMixer(this.model)

            // Store all animations with normalized names
            gltf.animations.forEach((clip) => {
              const action = this.mixer!.clipAction(clip)
              // Normalize name: lowercase
              const normalizedName = clip.name.toLowerCase()
              this.animations.set(normalizedName, action)

              if (import.meta.env.DEV) {
                console.log(`[Robot] Animation loaded: ${clip.name} -> ${normalizedName}`)
              }
            })

            // Start with idle animation
            this.playAnimation('robot_idle')
          }

          this.loaded = true
          console.log(`[Robot] ${this.name} loaded (wildcard brain: ${this.modelId})`)
          resolve()
        },
        (progress) => {
          if (import.meta.env.DEV && progress.total > 0) {
            const percent = (progress.loaded / progress.total) * 100
            if (percent === 100) {
              console.log('[Robot] Model file loaded')
            }
          }
        },
        (error) => {
          console.error('[Robot] Failed to load model:', error)
          reject(error)
        }
      )
    })
  }

  private playAnimation(name: string, fadeTime: number = 0.3, loop: boolean = true): void {
    if (!this.mixer) return

    // Try to find the animation
    let action = this.animations.get(name.toLowerCase())

    // Fallback - try to find any animation containing the name
    if (!action) {
      for (const [key, anim] of this.animations) {
        if (key.includes(name.toLowerCase())) {
          action = anim
          break
        }
      }
    }

    // Ultimate fallback - idle
    if (!action) {
      action = this.animations.get('robot_idle') || this.animations.get('robot_standing')
    }

    if (!action) {
      if (import.meta.env.DEV) {
        console.warn(`[Robot] Animation '${name}' not found`)
      }
      return
    }

    if (this.currentAction === action) return

    // Configure looping
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1)
    if (!loop) {
      action.clampWhenFinished = true
    }

    // Crossfade to new animation
    if (this.currentAction) {
      this.currentAction.fadeOut(fadeTime)
    }

    action.reset().fadeIn(fadeTime).play()
    this.currentAction = action
  }

  private playAnimationSequence(animations: string[]): void {
    if (animations.length === 0) return

    this.animationQueue = [...animations]
    this.isPlayingSequence = true
    this.playNextInQueue()
  }

  private playNextInQueue(): void {
    if (this.animationQueue.length === 0) {
      this.isPlayingSequence = false
      this.playAnimation('robot_idle')
      return
    }

    const nextAnim = this.animationQueue.shift()!
    this.playAnimation(nextAnim, 0.2, false)

    // Find the animation to get its duration
    const action = this.animations.get(nextAnim.toLowerCase())
    const duration = action?.getClip().duration || 2

    // Schedule next animation
    setTimeout(() => {
      if (this.isPlayingSequence) {
        this.playNextInQueue()
      }
    }, duration * 1000)
  }

  private faceDirection(target: THREE.Vector3): void {
    const dx = target.x - this.group.position.x
    const dz = target.z - this.group.position.z
    this.group.rotation.y = Math.atan2(dx, dz)
  }

  private pickRandomWanderTarget(): THREE.Vector3 {
    // Random position within movement zone
    const x = MOVEMENT_ZONE.minX + Math.random() * (MOVEMENT_ZONE.maxX - MOVEMENT_ZONE.minX)
    const z = MOVEMENT_ZONE.minZ + Math.random() * (MOVEMENT_ZONE.maxZ - MOVEMENT_ZONE.minZ)
    return new THREE.Vector3(x, 0, z)
  }

  public update(deltaTime: number): void {
    this.time += deltaTime

    // Update animation mixer
    if (this.mixer) {
      this.mixer.update(deltaTime)
    }

    // Wander on its own schedule (unchanged). In between wanders, North is free
    // to do spontaneous fidget animations (wave, nod, thumbs-up, dance, etc.).
    if (this.behaviorState === 'idle' && !this.isPlayingSequence) {
      this.idleTimer += deltaTime
      this.fidgetTimer += deltaTime

      if (this.idleTimer >= this.nextWanderTime) {
        this.startWandering()
      } else if (this.fidgetTimer >= this.nextFidgetTime) {
        this.fidgetTimer = 0
        this.nextFidgetTime = 8 + Math.random() * 12
        this.playIdleFidget()
      }
    }

    // Update walking
    if (this.behaviorState === 'walking') {
      this.updateWalking(deltaTime)
    }
  }

  // Pool of expressive idle animations (playAnimation falls back to idle if a
  // clip isn't present in this GLTF, so unknown names are safe).
  private idleFidgets = [
    'robot_wave', 'robot_yes', 'robot_thumbsup', 'robot_dance',
    'robot_jump', 'robot_walkjump', 'robot_sitting',
  ]

  private playIdleFidget(): void {
    const name = this.idleFidgets[Math.floor(Math.random() * this.idleFidgets.length)]
    this.isPlayingSequence = true
    this.playAnimation(name, 0.3, false)
    const action = this.animations.get(name.toLowerCase())
    const duration = action?.getClip().duration || 2
    setTimeout(() => {
      this.isPlayingSequence = false
      this.playAnimation('robot_idle')
      this.scheduleNextWander()
    }, duration * 1000)
  }

  private startWandering(): void {
    this.targetPosition = this.pickRandomWanderTarget()
    this.behaviorState = 'walking'
    this.playAnimation('robot_walking')
    this.faceDirection(this.targetPosition)
  }

  private updateWalking(deltaTime: number): void {
    const walkSpeed = 0.6
    const direction = new THREE.Vector3()
      .subVectors(this.targetPosition, this.group.position)
    const distance = direction.length()

    if (distance < 0.1) {
      // Reached destination
      this.group.position.copy(this.targetPosition)
      this.currentPosition.copy(this.targetPosition)
      this.behaviorState = 'idle'
      this.playAnimation('robot_idle')
      this.scheduleNextWander()

      // Face the plant (center) when idle
      this.faceDirection(new THREE.Vector3(0, 0, 0))
      return
    }

    // Move toward target
    direction.normalize()
    const moveAmount = Math.min(walkSpeed * deltaTime, distance)
    this.group.position.add(direction.multiplyScalar(moveAmount))
    this.currentPosition.copy(this.group.position)
  }

  private scheduleNextWander(): void {
    // Random time until next wander (8-20 seconds)
    this.nextWanderTime = 8 + Math.random() * 12
    this.idleTimer = 0
  }

  // Public API - React to code events
  public reactToEvent(event: CodeEvent): void {
    const animations = CODE_EVENT_ANIMATIONS[event]

    if (!animations || animations.length === 0) {
      return
    }

    // Stop current activity
    this.behaviorState = this.getBehaviorForEvent(event)
    this.isPlayingSequence = false

    if (animations.length === 1) {
      // Single animation
      const isLooping = event === 'idle'
      this.playAnimation(animations[0], 0.3, isLooping)

      if (!isLooping) {
        // Return to idle after animation completes
        const action = this.animations.get(animations[0].toLowerCase())
        const duration = action?.getClip().duration || 2
        setTimeout(() => {
          this.behaviorState = 'idle'
          this.playAnimation('robot_idle')
          this.scheduleNextWander()
        }, duration * 1000)
      }
    } else {
      // Animation sequence
      this.playAnimationSequence(animations)
    }

    // Add a little hop for excitement on positive events
    if (['tests_pass', 'all_tests_pass', 'pr_merged', 'milestone'].includes(event)) {
      gsap.to(this.group.position, {
        y: this.group.position.y + 0.15,
        duration: 0.2,
        ease: 'power2.out',
        yoyo: true,
        repeat: 1,
      })
    }
  }

  private getBehaviorForEvent(event: CodeEvent): RobotBehaviorState {
    switch (event) {
      case 'tests_pass':
      case 'all_tests_pass':
      case 'pr_merged':
      case 'milestone':
        return 'celebrating'
      case 'tests_fail':
        return 'disappointed'
      case 'build_broken':
        return 'dead'
      case 'bug_fixing':
        return 'punching'
      case 'epoch_start':
        return 'waving'
      default:
        return 'idle'
    }
  }

  // Convenience methods for common events
  public celebrate(): void {
    this.reactToEvent('tests_pass')
  }

  public bigCelebration(): void {
    this.reactToEvent('all_tests_pass')
  }

  public showDisappointment(): void {
    this.reactToEvent('tests_fail')
  }

  public waveHello(): void {
    this.reactToEvent('epoch_start')
  }

  public getBehavior(): RobotBehaviorState {
    return this.behaviorState
  }

  public dispose(): void {
    gsap.killTweensOf(this.group.position)

    if (this.mixer) {
      this.mixer.stopAllAction()
    }

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

// Factory function
export function createRobot(): Robot {
  return new Robot()
}
