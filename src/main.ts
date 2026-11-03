import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { createLab, getWallClock } from './scene/Lab'
import { createLabDetails } from './scene/LabDetails'
import { CapabilityArchive } from './entities/CapabilityArchive'
import { KillWall } from './entities/KillWall'
import { TrainingRig } from './entities/TrainingRig'
import { JSpaceLens } from './entities/JSpaceLens'
import gsap from 'gsap'
import { createLighting } from './scene/Lighting'
import { createAllStations } from './entities/Station'
import { Plant, PlantState } from './entities/Plant'
import { Scientist, createAllScientists, loadAllScientists, ModelId } from './entities/Scientist'
import { Robot, createRobot, CodeEvent } from './entities/Robot'
import { Drone } from './entities/Drone'
import { GlmWildcard } from './entities/GlmWildcard'
import { ScannerDrone } from './entities/ScannerDrone'
import { AbstractScreen, ScreenActivity } from './entities/AbstractScreen'
import { TerminalScreen } from './entities/TerminalScreen'
import { GlassTerrarium } from './entities/GlassTerrarium'
import { StationRole, COLORS } from './scene/colors'
import { UIOverlay } from './systems/UIOverlay'
import { LightingController } from './systems/LightingController'
import { ParticleSystem } from './systems/ParticleSystem'
import { TranscriptPanel } from './systems/TranscriptPanel'
import { PatinaSystem } from './lib/patina'
import { getStateManager } from './api/StateManager'
import { getTaskOrchestrator, Task, TaskType } from './systems/TaskOrchestrator'
import { getSpritesService, SpritesActivityEvent, StreamOutputEvent, ModelId as SpriteModelId } from './systems/SpritesService'
import type { ExperimentState, ExperimentStatus } from './shared/types'
import { BACKEND_TO_FRONTEND_MODEL, ROLES, MODEL_DISPLAY_NAMES } from './shared/types'

// Map backend role names to station roles
const ROLE_TO_STATION: Record<string, StationRole> = {
  planner: 'planner',
  executor: 'executor',
  challenger: 'challenger',
  reviewer: 'reviewer',
  commentator: 'commentator',
}

class ObservableLab {
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private renderer: THREE.WebGLRenderer
  private controls: OrbitControls
  private plant: Plant
  private glassTerrarium: GlassTerrarium
  private scientists: Scientist[]
  private robot: Robot | null = null
  private glm: GlmWildcard | null = null // GLM wildcard (hovers in front of the NN artwork)
  private scanners: ScannerDrone[] = [] // ambient SDF scanner probes that sweep the plant
  private scannerProjView = new THREE.Matrix4()
  private lastPrunings = -1
  private wasEpochInProgress = false
  private archive: CapabilityArchive | null = null
  private killWall: KillWall | null = null
  private lastState: ExperimentState | null = null
  private trainingRig: TrainingRig | null = null
  private jspaceLens: JSpaceLens | null = null
  private wireJSpaceToggle: ((scientist: Scientist) => boolean) | null = null
  // Latest real reasoning/remark per frontend model id, for the J-space lens
  private latestVoice = new Map<string, { reasoning: string; remark: string }>()
  private inspectRay = new THREE.Raycaster()
  private inspectDown: { x: number; y: number; t: number } | null = null
  private drones: Drone[] = [] // "subagent" drones — spawn when models deploy subagents
  private stationScreens: Map<number, AbstractScreen> = new Map() // Keyed by station index
  private terminalScreens: Map<SpriteModelId, TerminalScreen> = new Map() // Keyed by model ID for streaming
  private codingModels: Set<SpriteModelId> = new Set() // Models with an active code session (screen only shows while at desk)
  private clock: THREE.Clock
  private uiOverlay!: UIOverlay

  // New Phase 4 systems
  private lightingController: LightingController | null = null
  private particleSystem: ParticleSystem | null = null
  private transcriptPanel: TranscriptPanel | null = null
  private patinaSystem: PatinaSystem | null = null
  private ambientLight: THREE.AmbientLight | null = null


  // State tracking
  private currentEpoch: number = 0
  private activeStationIndex: number = -1
  private liveExperiment: boolean = false // true once real backend state arrives (disables the local demo cycle)
  private streamedContributionIds: Set<string> = new Set() // real code contributions already streamed into a terminal
  private previousSpecSnapshot: {
    capabilities: string[]
    behaviors: string[]
    constraints: string[]
    conflicts: string[]
  } | null = null

  constructor() {
    this.clock = new THREE.Clock()
    this.scientists = []

    // Scene
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x1a1a1a)
    this.scene.fog = new THREE.Fog(0xf5f2eb, 12, 20)

    // Camera
    this.camera = new THREE.PerspectiveCamera(
      50,
      window.innerWidth / window.innerHeight,
      0.1,
      100
    )
    this.camera.position.set(8, 5, 8)

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.2

    const app = document.getElementById('app')
    if (app) {
      app.appendChild(this.renderer.domElement)
    }

    // Controls - limited orbit for "observing" feel
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.05
    this.controls.target.set(0, 1, 0)
    this.controls.minDistance = 6
    this.controls.maxDistance = 15
    this.controls.minPolarAngle = Math.PI / 6
    this.controls.maxPolarAngle = Math.PI / 2.2
    this.controls.enablePan = false

    // Initialize plant with default state
    this.plant = new Plant({
      growthStage: 0.75,
      healthScore: 0.85,
      stabilityScore: 0.7,
      capabilities: 6,
      constraints: 4,
      behaviors: 4,
      conflicts: 2,
    })

    // Initialize glass terrarium
    this.glassTerrarium = new GlassTerrarium()

    // Build scene (async for model loading)
    this.init()
  }

  private async init(): Promise<void> {
    // Build scene geometry
    this.buildScene()

    // Load scientist 3D models asynchronously
    await this.loadScientistModels()

    // Create UI overlay after scientists are created
    this.uiOverlay = new UIOverlay(this.camera, this.controls, this.scientists)
    this.uiOverlay.onJSpaceToggle = this.wireJSpaceToggle

    // Set robot reference + give North the same nameplate design as the scientists
    if (this.robot) {
      this.uiOverlay.setRobot(this.robot.group, {
        name: this.robot.name,
        role: 'WILDCARD',
        accent: '#' + this.robot.accent.toString(16).padStart(6, '0'),
      })
    }

    // GLM nameplate (Machine Man wildcard)
    if (this.glm) {
      this.glm.labelEl = this.uiOverlay.addGlmLabel(this.glm.group, '#' + this.glm.accent.toString(16).padStart(6, '0'))
    }

    // Initialize Phase 4 systems
    this.initializePhase4Systems()

    // Events
    window.addEventListener('resize', this.onResize.bind(this))

    // Debug controls - only in development
    if (import.meta.env.DEV) {
      this.setupDebugControls()
    }

    // Start
    this.animate()
  }

  private buildScene(): void {
    // Clear scientist registry for hot reloads
    Scientist.clearAllScientists()

    // Add lab geometry
    const lab = createLab()
    this.scene.add(lab)

    // Additive "AI research lab" set dressing (server rack, bookshelf, plants,
    // corkboards) placed in the empty ring between desks and walls.
    this.scene.add(createLabDetails())

    // Capability Archive: the wall that fills up as the agent earns real
    // capabilities — specimen jars, merge tally, notebook pile.
    // 180° is a clear wall stretch (NN diagram at 162°, commentator station
    // at 198°) — nothing behind it to occlude.
    this.archive = new CapabilityArchive()
    {
      const a = (180 * Math.PI) / 180
      this.archive.group.position.set(Math.cos(a) * 7.8, 1.35, Math.sin(a) * 7.8)
      this.archive.group.rotation.y = -a - Math.PI / 2
    }
    this.scene.add(this.archive.group)

    // The challenger's kill-wall: pruned ideas end up in ashen jars above
    // that station (126°) — the dark mirror of the archive.
    this.killWall = new KillWall()
    {
      const a = (126 * Math.PI) / 180
      this.killWall.group.position.set(Math.cos(a) * 7.84, 2.05, Math.sin(a) * 7.84)
      this.killWall.group.rotation.y = -a - Math.PI / 2
    }
    this.scene.add(this.killWall.group)

    // The compute corner comes alive during real GPU training runs
    this.trainingRig = new TrainingRig()
    this.scene.add(this.trainingRig.group)

    // J-space lens: toggled per-scientist from their hover card
    // (callback wired after UIOverlay exists — see init)
    this.jspaceLens = new JSpaceLens()
    this.scene.add(this.jspaceLens.group)
    this.wireJSpaceToggle = (scientist) => {
      const lens = this.jspaceLens!
      if (lens.attachedTo === scientist.group) {
        lens.detach()
        return false
      }
      const modelId = scientist.getModelId()
      const voice = this.latestVoice.get(modelId)
      const backendId = Object.entries(BACKEND_TO_FRONTEND_MODEL).find(([, f]) => f === modelId)?.[0]
      const name = backendId
        ? (MODEL_DISPLAY_NAMES as Record<string, string>)[backendId] ?? modelId
        : modelId
      lens.attach(
        scientist.group,
        name,
        voice?.reasoning ?? '',
        voice?.remark ?? 'Nothing on the workspace yet — check back after this researcher speaks.'
      )
      return true
    }

    // Click-to-inspect wiring (after all static inspectables exist)
    this.setupInspector()

    // Add lighting and store ambient light reference
    const lighting = createLighting()
    this.scene.add(lighting)

    // Find and store ambient light for LightingController
    lighting.traverse((obj) => {
      if (obj instanceof THREE.AmbientLight) {
        this.ambientLight = obj
      }
    })

    // Add stations
    const stations = createAllStations()
    this.scene.add(stations)

    // Add the procedural plant
    this.scene.add(this.plant.group)

    // Add glass terrarium (dome with breaking mechanic)
    this.scene.add(this.glassTerrarium.group)

    // Set up shatter callback to persist state
    this.glassTerrarium.onShatter = () => {
      this.handleGlassShatter()
    }

    // Scientists will be loaded asynchronously in loadScientistModels()
  }

  private async loadScientistModels(): Promise<void> {
    // Create scientist instances
    this.scientists = createAllScientists()

    // Add their groups to the scene (empty until loaded)
    this.scientists.forEach((scientist) => {
      scientist.group.userData.inspect = { kind: 'scientist', modelId: scientist.getModelId() }
      this.scene.add(scientist.group)
    })

    // Create and add robot mascot (North, the wildcard)
    this.robot = createRobot()
    this.scene.add(this.robot.group)

    // Create GLM (the Machine Man wildcard) in front of the neural-net artwork
    this.glm = new GlmWildcard()
    this.scene.add(this.glm.group)

    // Ambient scanner probes — procedural SDF lab robotics (not subagents):
    // they patrol the terrarium, sweep a scan beam across the plant, and
    // perch on the brass rim between shifts.
    this.scanners = [new ScannerDrone(0.6, 1), new ScannerDrone(0.6 + Math.PI, -1)]
    for (const sd of this.scanners) this.scene.add(sd.group)

    // Create hovering screens for 4 stations (not planner - it has whiteboard)
    this.createStationScreens()

    // Create terminal screens for code streaming (one per model)
    this.createTerminalScreens()

    // Load all 3D models in parallel (scientists + robot)
    try {
      await Promise.all([
        loadAllScientists(this.scientists),
        this.robot.load(),
        this.glm?.load() ?? Promise.resolve(),
      ])
      if (import.meta.env.DEV) {
        console.log('%c🧑‍🔬 All scientist 3D models loaded', 'color: #7cb342; font-weight: bold')
        console.log('%c🤖 Robot mascot loaded', 'color: #4fc3f7; font-weight: bold')
      }
    } catch (error) {
      console.error('Failed to load character models:', error)
    }
  }

  private createStationScreens(): void {
    // Station indices: 0=planner, 1, 2, 3, 4
    // Planner (index 0) has whiteboard - no screen
    // Screens are keyed by station INDEX (not role) so they follow the scientist at that position
    const stationIndices = [1, 2, 3, 4]

    const stationRadius = 5.0
    const screenOffset = 1.2 // Offset behind desk (further from center)

    stationIndices.forEach((index) => {
      // Calculate station position (same formula as scientists)
      const angle = (index * 2 * Math.PI) / 5 - Math.PI / 2

      // Position screen BEHIND the desk (further from center than scientist)
      const screenRadius = stationRadius + screenOffset
      const stationPos = new THREE.Vector3(
        Math.cos(angle) * screenRadius,
        0,
        Math.sin(angle) * screenRadius
      )

      // Screen faces inward (toward center/scientist at desk)
      // PlaneGeometry faces +Z, so we rotate to face toward center
      const facingAngle = -Math.PI / 2 - angle

      const screen = new AbstractScreen(stationPos, facingAngle)
      this.stationScreens.set(index, screen)
      this.scene.add(screen.group)
    })

    if (import.meta.env.DEV) {
      console.log('%c📺 Station screens created (4 screens, keyed by index)', 'color: #64b5f6; font-weight: bold')
    }
  }

  private createTerminalScreens(): void {
    // Create terminal screens for each model (for code streaming)
    // These are hidden by default and show when sprites are executing
    // Position terminals at each scientist's actual station location
    const stationRadius = 5.0
    const screenOffset = 1.2

    this.scientists.forEach((scientist) => {
      const modelId = scientist.getModelId() as SpriteModelId
      const stationIndex = scientist.getStationIndex()

      // Station 0's desk has the whiteboard above it — no code terminal there.
      if (stationIndex === 0) return

      // Calculate position based on scientist's actual station
      const angle = (stationIndex * 2 * Math.PI) / 5 - Math.PI / 2
      const screenRadius = stationRadius + screenOffset
      const position = new THREE.Vector3(
        Math.cos(angle) * screenRadius,
        0,
        Math.sin(angle) * screenRadius
      )
      // Face inward toward the center/camera (the +Math.PI flips the plane so
      // text reads correctly instead of mirrored from the back face).
      const facingAngle = Math.PI / 2 - angle

      const terminal = new TerminalScreen(position, facingAngle)
      this.terminalScreens.set(modelId, terminal)
      this.scene.add(terminal.group)
    })

    if (import.meta.env.DEV) {
      console.log('%c💻 Terminal screens created (5 screens for code streaming)', 'color: #4fc3f7; font-weight: bold')
    }
  }

  private initializePhase4Systems(): void {
    // Initialize LightingController
    if (this.ambientLight) {
      this.lightingController = new LightingController({
        scene: this.scene,
        ambientLight: this.ambientLight,
      })
    }

    // Initialize ParticleSystem
    this.particleSystem = new ParticleSystem(this.scene)

    // Initialize TranscriptPanel (hidden by default)
    this.transcriptPanel = new TranscriptPanel()

    // Initialize PatinaSystem
    this.patinaSystem = new PatinaSystem()
    this.patinaSystem.scanScene(this.scene)

    // Initialize StateManager and start polling
    const stateManager = getStateManager({
      onStateUpdate: (state) => this.handleStateUpdate(state),
      onError: (error) => console.error('State update error:', error),
    })

    // Start polling (will gracefully handle 404 if no experiment exists)
    stateManager.startPolling()

    // Initialize TaskOrchestrator and wire events
    this.initializeTaskOrchestrator()

    // Initialize SpritesService for code execution
    this.initializeSpritesService()

    // Local "phase" cycle so one role works at its desk while others roam
    // (until real backend epochs take over).
    this.startLocalActivityCycle()

    if (import.meta.env.DEV) {
      console.log('%c🔌 Phase 4 Systems Initialized', 'color: #64b5f6; font-weight: bold')
      console.log('  - LightingController: stability-driven lighting')
      console.log('  - ParticleSystem: state-driven particles')
      console.log('  - TranscriptPanel: click icon in bottom-right')
      console.log('  - PatinaSystem: long-term material aging')
      console.log('  - StateManager: polling for experiment state')
      console.log('  - TaskOrchestrator: task queue and event system')
      console.log('  - SpritesService: code execution in sandboxes')
    }

    // Expose debug interface for testing (available in console as window.lab).
    // Development builds only: it can stage simulated activity on demand and
    // call operator routes, so production builds leave it out entirely.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (import.meta.env.DEV) (window as any).lab = {
      orchestrator: getTaskOrchestrator(),
      sprites: getSpritesService(),
      robot: this.robot,
      glm: this.glm,
      plant: this.plant,
      transcript: this.transcriptPanel,
      scanners: this.scanners,
      archive: this.archive,
      trainingRig: this.trainingRig,
      jspace: this.jspaceLens,
      voices: this.latestVoice,
      // Replay live per-role activity from a real in-progress/completed epoch object
      liveReplay: (epoch: ExperimentState['recent_epochs'][0]) => { this.liveAnnouncedKeys.clear(); this.streamedBrowsingKeys.clear(); this.driveLiveEpochActivity(epoch) },
      // Preview live browsing on a sprite terminal (real page screenshot) without waiting for an epoch
      browse: (url = 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/isSafeInteger', modelId: SpriteModelId = 'gpt') => {
        const terminal = this.terminalScreens.get(modelId)
        if (!terminal) { console.log(`[browse] no terminal for ${modelId}`); return }
        this.codingModels.add(modelId)
        this.scientists.find(s => s.getModelId() === modelId)?.returnToStation()
        terminal.streamSession('web search: "safe integer arithmetic in typescript"', [
          { text: '  ↳ developer.mozilla.org' },
        ])
        window.setTimeout(() => terminal.showPageShot(url, 6000), 1500)
        window.setTimeout(() => this.codingModels.delete(modelId), 14000)
      },
      scientists: this.scientists,
      drones: this.drones,
      screens: this.stationScreens,
      terminals: this.terminalScreens,
      // Helper to trigger a test task
      testTask: (role: StationRole = 'executor', type: TaskType = 'implement_feature') => {
        const orchestrator = getTaskOrchestrator()
        const task = orchestrator.createTask({
          type,
          title: `Test ${type}`,
          description: 'Testing scientist behaviors',
          priority: 'high',
        })
        orchestrator.assignTask(task.id, role)
        console.log(`Created and assigned task to ${role}:`, task)
        return task
      },
      // Helper to complete current task for a role
      completeTask: (role: StationRole = 'executor') => {
        const orchestrator = getTaskOrchestrator()
        const task = orchestrator.getActiveTaskForRole(role)
        if (task) {
          orchestrator.completeTask(task.id)
          console.log(`Completed task for ${role}:`, task)
        } else {
          console.log(`No active task for ${role}`)
        }
      },
      // Helper to fail current task
      failTask: (role: StationRole = 'executor') => {
        const orchestrator = getTaskOrchestrator()
        const task = orchestrator.getActiveTaskForRole(role)
        if (task) {
          orchestrator.failTask(task.id, 'Test failure')
          console.log(`Failed task for ${role}:`, task)
        } else {
          console.log(`No active task for ${role}`)
        }
      },
      // Execute a command on a sprite (shows on terminal screen)
      exec: async (modelId: SpriteModelId = 'gpt', command: string = 'ls -la') => {
        console.log(`[lab.exec] Executing on ${modelId}: ${command}`)
        await getSpritesService().executeCommand(modelId, command)
      },
      // Show a terminal for testing without executing
      showTerminal: (modelId: SpriteModelId = 'gpt') => {
        const terminal = this.terminalScreens.get(modelId)
        if (terminal) {
          terminal.setVisible(true)
          terminal.addCommand('echo "Hello from terminal"')
          terminal.addOutput('Hello from terminal', 'normal')
          terminal.addOutput('This is a test output line', 'normal')
          terminal.addOutput('✓ Success message', 'success')
          terminal.addOutput('✗ Error message', 'error')
          console.log(`Terminal shown for ${modelId}`)
        } else {
          console.log(`No terminal for model: ${modelId}`)
        }
      },
      // Hide all terminals
      hideTerminals: () => {
        this.terminalScreens.forEach((terminal) => {
          terminal.setVisible(false)
        })
        console.log('All terminals hidden')
      },
      // Simulate a North (robot wildcard) experiment — visible without OpenRouter credits
      north: () => this.runNorthDemo(),
      // Simulate a Modal/GPU access: a scientist walks to the compute rack
      modal: () => this.simulateModalAccess(),
      // Spawn N subagent drones over the terrarium (clear to despawn)
      subagent: (n: number = 1) => { for (let i = 0; i < n; i++) this.spawnSubagent() },
      despawnSubagent: () => this.despawnSubagent(),
      clearSubagents: () => this.clearSubagents(),
      // Simulate ONE model writing/committing code: it walks to its desk and only
      // its terminal appears (proves screens are per-model, not simultaneous).
      code: (modelId: SpriteModelId = 'gpt') => this.simulateCodeSession(modelId),
    }
    if (import.meta.env.DEV) {
      console.log('%c🧪 Debug interface available: window.lab', 'color: #ff9800; font-weight: bold')
      console.log('  Try: lab.testTask("executor") or lab.testTask("reviewer", "review_code")')
      console.log('  Try: lab.exec("gpt", "ls -la") or lab.showTerminal("claude")')
      console.log('  Try: lab.north()  — North runs an experiment and grows a green leaf')
    }
  }

  // Simulated North experiment cycle: the robot wildcard "codes" then contributes
  // a green leaf to the plant. Mirrors what the live north-runner will trigger once
  // OpenRouter credits are available.
  private runNorthDemo(): void {
    if (!this.robot) {
      console.log('[North] robot not loaded yet')
      return
    }
    console.log(`%c🤖 North (${this.robot.modelId}) running an experiment…`, 'color:#39d98a;font-weight:bold')
    this.robot.reactToEvent('bug_fixing')
    this.uiOverlay?.showRobotStatus('{ }', `North · ${this.robot.name} experimenting`, 'working', 2200)
    setTimeout(() => {
      this.plant?.addNorthLeaf()
      this.robot?.reactToEvent('pr_merged')
      this.uiOverlay?.showRobotStatus('[✓]', 'North merged a green leaf', 'success', 3000)
      console.log('%c🌿 North contributed a green leaf to the plant', 'color:#39d98a')
    }, 2200)
  }

  // A scientist accesses Modal (GPU work) → walks to the compute rack, then back.
  // The real hook fires from the epoch flow when Modal is invoked; this is the demo.
  private simulateModalAccess(): void {
    const idle = this.scientists.filter(s => s.getBehavior() === 'idle')
    const pool = idle.length > 0 ? idle : this.scientists
    if (pool.length === 0) return
    const s = pool[Math.floor(Math.random() * pool.length)]
    s.goToRack()
    console.log(`%c🖥️ ${s.getModelId()} is accessing Modal — heading to the GPU rack`, 'color:#64b5f6')
  }

  // ---- Subagent drones ----
  // Any worker in the lab can deploy a subagent: the five model scientists plus
  // the two wildcards (North, GLM). At most MAX_VISIBLE_DRONES are shown at once.
  private static readonly MAX_VISIBLE_DRONES = 3
  private static readonly DRONE_DEPLOYERS = ['Claude', 'GPT-5.5', 'Gemini', 'Grok', 'DeepSeek-V4', 'North', 'GLM']

  // Spawn a "subagent" drone over the terrarium. Call when a model deploys a
  // subagent for a task; despawn it when that subagent finishes. Returns the
  // drone (so a caller can kill this specific one later) or null if capped.
  public async spawnSubagent(parentModel = ''): Promise<Drone | null> {
    // Cap how many drones are visible at once (ignore ones already dying).
    const live = this.drones.filter((d) => !d.dead).length
    if (live >= ObservableLab.MAX_VISIBLE_DRONES) return null

    const pool = ObservableLab.DRONE_DEPLOYERS
    const drone = new Drone()
    drone.parentModel = parentModel || pool[Math.floor(Math.random() * pool.length)]
    this.scene.add(drone.group)
    drone.labelEl = this.uiOverlay.addDroneLabel(drone.group, () => ({
      parent: drone.parentModel,
      task: drone.currentTask,
    }))
    this.drones.push(drone)
    try {
      await drone.load()
    } catch (e) {
      console.warn('[Drone] load failed:', e)
    }
    return drone
  }

  public despawnSubagent(): void {
    const d = this.drones.find((x) => !x.dead)
    if (d) d.kill()
  }

  public clearSubagents(): void {
    this.drones.forEach((d) => d.kill())
  }

  // Cycle which scientist is "active" (working at its desk) every ~12s, so the lab
  // reads as a rotating collaboration. Disabled once real epoch state arrives.
  private startLocalActivityCycle(): void {
    let i = 0
    window.setInterval(() => {
      if (this.liveExperiment || this.scientists.length === 0) return
      const n = this.scientists.length
      const activeIdx = i % n
      this.scientists.forEach((s, idx) => s.setActiveInEpoch(idx === activeIdx))

      // Every model writes code in its own sandbox, surfacing its terminal at the
      // desk — except the whiteboard desk (station 0), which has no screen.
      const active = this.scientists[activeIdx]
      if (active.getStationIndex() !== 0) {
        this.simulateCodeSession(active.getModelId() as SpriteModelId)
      }
      i++
    }, 12000)
  }

  // Simulate a single model writing & committing code: it walks to its own desk and
  // ONLY its terminal screen appears. Demonstrates per-model (not simultaneous) behavior.
  private simulateCodeSession(modelId: SpriteModelId): void {
    const scientist = this.scientists.find(s => s.getModelId() === modelId)
    if (!scientist) {
      console.log(`[code] no scientist for "${modelId}". Try gpt|claude|gemini|grok|deepseek`)
      return
    }
    this.codingModels.add(modelId)
    scientist.returnToStation()
    const terminal = this.terminalScreens.get(modelId)
    if (terminal) {
      // Screen appears once the scientist reaches the desk (update-loop gate),
      // then the code streams in.
      // Placeholder text only: no experiment is connected, so nothing here
      // may look like a real build or commit.
      terminal.streamSession('# simulation: no experiment connected', [
        { text: 'Placeholder activity for the room.' },
        { text: 'No model, build or commit is running.' },
      ])
    }
    // End the session after the stream + reading time so the screen later hides.
    window.setTimeout(() => this.codingModels.delete(modelId), 12000)
    if (import.meta.env.DEV) console.log(`%c💻 ${modelId} walked to its desk (simulated session)`, 'color:#4fc3f7')
  }

  // Helper to get screen for a role by finding scientist's station index
  private getScreenForRole(role: StationRole): AbstractScreen | undefined {
    const scientist = this.scientists.find(s => s.getRole() === role)
    if (!scientist) return undefined
    const stationIndex = scientist.getStationIndex()
    return this.stationScreens.get(stationIndex)
  }

  // Helper to get human-readable task label for scientist cards
  private getTaskLabel(taskType: TaskType, role: StationRole): string {
    const taskLabels: Record<TaskType, string> = {
      'implement_feature': 'Writing feature code...',
      'write_test': 'Writing tests...',
      'fix_bug': 'Fixing bug...',
      'review_code': 'Reviewing code...',
      'refactor': 'Refactoring...',
      'document': 'Writing docs...',
      'challenge_design': 'Challenging approach...',
      'plan_architecture': 'Setting direction...',
    }
    return taskLabels[taskType] || `Working as ${role}...`
  }

  // Helper to get robot status for task type
  private getRobotStatusForTask(taskType: TaskType, role: StationRole): { icon: string; text: string } {
    const statusMap: Record<TaskType, { icon: string; text: string }> = {
      'implement_feature': { icon: '[>]', text: 'Writing Code' },
      'write_test': { icon: '[~]', text: 'Writing Tests' },
      'fix_bug': { icon: '[!]', text: 'Fixing Bug' },
      'review_code': { icon: '[?]', text: 'Code Review' },
      'refactor': { icon: '[*]', text: 'Refactoring' },
      'document': { icon: '[#]', text: 'Documenting' },
      'challenge_design': { icon: '[!]', text: 'Challenging' },
      'plan_architecture': { icon: '[+]', text: 'Planning Direction' },
    }
    return statusMap[taskType] || { icon: '[.]', text: `${role} working` }
  }

  // Helper to get completion status message
  private getCompletionStatus(taskType: TaskType): { icon: string; text: string } {
    const completionMap: Record<TaskType, { icon: string; text: string }> = {
      'implement_feature': { icon: '[ok]', text: 'Code Committed' },
      'write_test': { icon: '[ok]', text: 'Tests Passed' },
      'fix_bug': { icon: '[ok]', text: 'Bug Fixed' },
      'review_code': { icon: '[ok]', text: 'Review Complete' },
      'refactor': { icon: '[ok]', text: 'Refactored' },
      'document': { icon: '[ok]', text: 'Documented' },
      'challenge_design': { icon: '[ok]', text: 'Challenge Noted' },
      'plan_architecture': { icon: '[ok]', text: 'Direction Set' },
    }
    return completionMap[taskType] || { icon: '[ok]', text: 'Task Complete' }
  }

  private initializeTaskOrchestrator(): void {
    const orchestrator = getTaskOrchestrator()

    // Wire task events to scientist behaviors
    orchestrator.on('task:assigned', (task: Task) => {
      if (task.assignedRole) {
        // Update scientist label with task
        const scientist = this.scientists.find(s => s.getRole() === task.assignedRole)
        if (scientist) {
          this.uiOverlay.setScientistTask(scientist, 'Preparing...')
        }

        // Update screen to show activity (find screen by scientist's station)
        if (task.assignedRole !== 'planner') {
          const screen = this.getScreenForRole(task.assignedRole)
          if (screen) {
            screen.setActivity('reading')
          }
        }
      }
    })

    orchestrator.on('task:started', (task: Task) => {
      if (task.assignedRole) {
        // Find scientist with this role and make them work
        const scientist = this.scientists.find(s => s.getRole() === task.assignedRole)
        if (scientist) {
          scientist.setActiveInEpoch(true)

          // Update label with specific task description
          const taskLabel = this.getTaskLabel(task.type, task.assignedRole)
          this.uiOverlay.setScientistTask(scientist, taskLabel)
        }

        // Show robot status for the active work
        const robotStatus = this.getRobotStatusForTask(task.type, task.assignedRole)
        this.uiOverlay.showRobotStatus(robotStatus.icon, robotStatus.text, 'working', 8000)

        // Update screen based on task type (find screen by scientist's station)
        if (task.assignedRole !== 'planner') {
          const screen = this.getScreenForRole(task.assignedRole)
          if (screen) {
            if (task.type === 'write_test') {
              screen.setActivity('testing')
            } else if (task.type === 'review_code') {
              screen.setActivity('reading')
            } else {
              screen.setActivity('writing')
            }
          }
        }

        // Robot reactions based on task type
        if (this.robot) {
          if (task.type === 'plan_architecture') {
            this.robot.reactToEvent('epoch_start')
          } else if (task.type === 'fix_bug') {
            this.robot.reactToEvent('bug_fixing')
          }
        }
      }
    })

    orchestrator.on('task:completed', (task: Task) => {
      if (task.assignedRole) {
        // Scientist stops working and clear label
        const scientist = this.scientists.find(s => s.getRole() === task.assignedRole)
        if (scientist) {
          scientist.setActiveInEpoch(false)
          scientist.triggerEureka()
          this.uiOverlay.clearScientistTask(scientist)
        }

        // Show robot completion status
        const completionStatus = this.getCompletionStatus(task.type)
        this.uiOverlay.showRobotStatus(completionStatus.icon, completionStatus.text, 'success', 5000)

        // Screen shows commit flash (find screen by scientist's station)
        if (task.assignedRole !== 'planner') {
          const screen = this.getScreenForRole(task.assignedRole)
          if (screen) {
            screen.setActivity('committing')
            setTimeout(() => screen.setActivity('idle'), 2000)
          }
        }

        // Robot celebrates based on task type
        if (this.robot) {
          switch (task.type) {
            case 'write_test':
              this.robot.reactToEvent('all_tests_pass')
              break
            case 'implement_feature':
              this.robot.reactToEvent('pr_merged')
              break
            case 'fix_bug':
              this.robot.reactToEvent('tests_pass')
              break
            case 'review_code':
              this.robot.reactToEvent('tests_pass')
              break
            default:
              this.robot.celebrate()
          }
        }
      }
    })

    orchestrator.on('task:failed', (task: Task) => {
      if (task.assignedRole) {
        // Scientist shows frustration and clear label
        const scientist = this.scientists.find(s => s.getRole() === task.assignedRole)
        if (scientist) {
          scientist.setActiveInEpoch(false)
          scientist.triggerFrustration()
          this.uiOverlay.clearScientistTask(scientist)
        }

        // Show robot error status
        this.uiOverlay.showRobotStatus('[x]', 'Task Failed', 'error', 5000)

        // Screen shows error (find screen by scientist's station)
        if (task.assignedRole !== 'planner') {
          const screen = this.getScreenForRole(task.assignedRole)
          if (screen) {
            screen.setActivity('error')
            setTimeout(() => screen.setActivity('idle'), 3000)
          }
        }

        // Robot reacts
        if (this.robot) {
          this.robot.reactToEvent('tests_fail')
        }
      }
    })

    orchestrator.on('task:blocked', (task: Task) => {
      if (task.assignedRole && task.assignedRole !== 'planner') {
        const screen = this.getScreenForRole(task.assignedRole)
        if (screen) {
          screen.setActivity('idle')
        }
      }

      // Robot shows concern
      if (this.robot) {
        this.robot.reactToEvent('build_broken')
      }
    })
  }

  private initializeSpritesService(): void {
    const spritesService = getSpritesService()

    // Set the AI Agent repository URL
    spritesService.setRepoUrl('https://github.com/DervinEvolve/AI-Agent.git')

    // Wire up activity events from Sprites for robot reactions only
    // (AbstractScreens are NOT updated here - TerminalScreens handle code streaming visualization)
    spritesService.onActivity((event: SpritesActivityEvent) => {

      // Robot reactions to certain events
      if (this.robot) {
        if (event.type === 'testing') {
          // Testing in progress
        } else if (event.type === 'committing') {
          this.robot.reactToEvent('tests_pass')
        } else if (event.type === 'error') {
          this.robot.reactToEvent('tests_fail')
        }
      }
    })

    // Wire up streaming output to terminal screens
    spritesService.onStreamOutput((event: StreamOutputEvent) => {
      const terminal = this.terminalScreens.get(event.modelId)
      if (!terminal) return

      switch (event.type) {
        case 'start':
          // This model has work to do: it walks back to its OWN desk. The screen
          // only becomes visible once it arrives (gated in the update loop), and
          // hides again if it wanders off. North has no terminal, so it's unaffected.
          this.codingModels.add(event.modelId)
          this.scientists.find(s => s.getModelId() === event.modelId)?.returnToStation()
          if (event.command) {
            terminal.addCommand(event.command)
          }
          break
        case 'output':
          if (event.text) {
            terminal.addOutput(event.text, 'normal')
          }
          break
        case 'error':
          if (event.text) {
            terminal.addOutput(event.text, 'error')
          }
          terminal.setActivity('error')
          break
        case 'exit':
          if (event.exitCode === 0) {
            terminal.setActivity('success')
          } else {
            terminal.setActivity('error')
          }
          break
        case 'done':
          this.codingModels.delete(event.modelId)
          terminal.setActivity('idle')
          break
      }
    })

    // Sprites status and commands are operator routes (they need the operator
    // credential), so the anonymous viewer does not call them on load. An
    // operator client can call spritesService.initializeSprites() itself.
  }

  private handleStateUpdate(state: ExperimentState): void {
    // Real backend state is driving the lab now — stand down the local demo cycle.
    this.liveExperiment = true
    this.uiOverlay.setSimulationMode(false)
    this.lastState = state
    if (import.meta.env.DEV) {
      console.log(`State update: Epoch ${state.current_epoch}, Status: ${state.status}`)
    }

    // Fallback stability score if missing from API (legacy data)
    const stabilityScore = state.current_spec.meta.stability_score ?? 0.85

    // Update UI overlay with epoch, stability, and seed purpose
    this.uiOverlay.updateExperimentState(
      state.current_epoch,
      stabilityScore,
      state.current_spec.identity?.purpose || 'An autonomous agent'
    )

    // Update lighting based on stability
    if (this.lightingController) {
      this.lightingController.updateFromStability(stabilityScore)
    }

    // Update particles based on status and stability
    if (this.particleSystem) {
      this.particleSystem.updateFromState(
        state.status as ExperimentStatus,
        stabilityScore
      )
    }

    // Update patina based on epoch count
    if (this.patinaSystem) {
      this.patinaSystem.updateFromEpoch(state.current_epoch)
    }

    // Update transcript panel with recent epochs
    if (this.transcriptPanel) {
      this.transcriptPanel.updateEpochs(state.recent_epochs)
    }

    // Update whiteboard with Gemini's output from latest epoch
    this.updateGeminiWhiteboard(state)

    // Update plant state from spec
    this.updatePlantFromSpec(state)

    // Handle persisted glass shattered state (page reload)
    if (state.glass_shattered) {
      this.glassTerrarium.setShatteredState(true)
    }

    // Check plant bounds against terrarium (physics-based breaking)
    // This happens every state update as the plant may have changed
    this.glassTerrarium.checkPlantBounds(this.plant.group)

    // Scanner probes work harder while an epoch is computing
    for (const sd of this.scanners) sd.setBusy(!!state.epoch_in_progress)

    // Epoch just started (rising edge) — the lab lights warm up
    if (state.epoch_in_progress && !this.wasEpochInProgress) {
      this.lightingController?.epochWarmUp()
    }
    this.wasEpochInProgress = !!state.epoch_in_progress

    // Capture each model's latest real reasoning/remark for the J-space lens.
    {
      const roles = ['planner', 'executor', 'challenger', 'reviewer', 'commentator'] as const
      const epochsOldestFirst = [...state.recent_epochs].sort((a, b) => a.epoch_number - b.epoch_number)
      for (const ep of epochsOldestFirst) {
        if (!ep.role_assignments) continue
        for (const role of roles) {
          const backendId = (ep.role_assignments as Record<string, string>)[role]
          const out = (ep as unknown as Record<string, unknown>)[`${role}_output`] as
            | { reasoning?: string; remark?: string }
            | undefined
          if (!backendId || !out || (!out.reasoning && !out.remark)) continue
          const frontendId = (BACKEND_TO_FRONTEND_MODEL as Record<string, string>)[backendId]
          if (!frontendId) continue
          this.latestVoice.set(frontendId, {
            reasoning: out.reasoning ?? '',
            remark: out.remark ?? '',
          })
        }
      }
    }

    // GPU training visibility: the in-progress epoch has started a research
    // run (call_id) that hasn't returned a result yet → the rack is HOT.
    {
      const inProg = state.recent_epochs.find(e => !e.completed_at)
      const training = !!(state.epoch_in_progress && inProg?.research_run?.call_id && !inProg?.research_run?.result)
      this.trainingRig?.setActive(training)
      const research = state.current_spec.meta.research
      this.trainingRig?.setResearch(research?.best_bpb ?? null, research?.baseline_bpb ?? null)
    }

    // The archive wall fills up with what the agent has actually earned
    if (this.archive) {
      const spec = state.current_spec
      const activeCaps = spec.capabilities.filter(c => c.status === 'active').length
      const merges =
        spec.capabilities.filter(c => c.status === 'active' && c.code_pr_url).length +
        spec.behaviors.filter(b => b.status === 'active' && b.code_pr_url).length
      this.archive.setState(activeCaps, merges, state.current_epoch)
      this.archive.setBusy(!!state.epoch_in_progress)
      // index-aligned metadata so clicking a jar names its capability
      this.archive.setCapabilityList(
        spec.capabilities
          .filter(c => c.status === 'active')
          .map(c => ({ name: c.id.replace(/^cap_/, '').replace(/_/g, ' '), pr: c.code_pr_url ?? null }))
      )
    }

    // GitHub icon notification bubble: the repo's ACTUAL commit count,
    // reported by the backend (which holds the private repo's token).
    if (state.repo_commit_count !== undefined) {
      this.uiOverlay.setCommitBadge(state.repo_commit_count)
    }

    // Wall clock counts down to the next epoch. The cron fires at the top of
    // each hour and runs an epoch only if the self-governed interval has
    // elapsed — so the next epoch is the first hour boundary past
    // (last epoch + interval).
    {
      const clock = getWallClock()
      if (clock) {
        const intervalMin = state.current_spec.meta.experiment_params?.epoch_interval_minutes ?? 60
        const lastDone = state.recent_epochs.find(e => e.completed_at)?.completed_at
        let nextAt: number | null = null
        if (lastDone) {
          const earliest = new Date(lastDone).getTime() + intervalMin * 60000
          const d = new Date(Math.max(earliest, Date.now()))
          d.setMinutes(0, 0, 0)
          if (d.getTime() < Math.max(earliest, Date.now())) d.setHours(d.getHours() + 1)
          nextAt = d.getTime()
        }
        const inProgE = state.recent_epochs.find(e => !e.completed_at)
        const gpuLive = !!(state.epoch_in_progress && inProgE?.research_run?.call_id && !inProgE?.research_run?.result)
        clock.setEpochInfo(nextAt, !!state.epoch_in_progress, gpuLive)
      }
    }

    // The lab records progress in its furniture too: behavior cards pile onto
    // the corkboard, chalk tallies accumulate on the planner's board, and the
    // room's light warms as the agent matures.
    this.syncBehaviorBoard(
      state.current_spec.behaviors.filter(b => b.status === 'active').length
    )
    this.syncEpochTallies(state.current_epoch)
    this.killWall?.setState(state.current_spec.meta.total_prunings ?? 0)
    this.lightingController?.setGrowthWarmth(
      this.mapGrowthStage(state.current_spec.meta.growth_stage)
    )

    // Handle epoch-in-progress station activation
    if (state.epoch_in_progress && state.epoch_progress !== undefined) {
      this.updateStationActivation(state.epoch_progress, state.role_assignments)
      // Drive live per-role activity from the in-progress epoch's partial
      // outputs (which fill in one role at a time on the backend).
      const inProgress = state.recent_epochs.find(e => !e.completed_at)
      if (inProgress) this.driveLiveEpochActivity(inProgress)
    } else if (!state.epoch_in_progress && this.activeStationIndex !== -1) {
      // Epoch ended, deactivate all stations
      this.deactivateAllStations()
      this.uiOverlay.hideLiveStatus()
    }

    // Update scientist roles if epoch changed
    // Use the LATEST COMPLETED epoch's role assignments (what they DID), not next epoch's (what they WILL do)
    if (state.current_epoch !== this.currentEpoch) {
      this.currentEpoch = state.current_epoch
      const latestCompletedEpoch = state.recent_epochs.find(e => e.completed_at && e.role_assignments)
      if (latestCompletedEpoch) {
        this.updateScientistRoles(latestCompletedEpoch.role_assignments)
      } else {
        // Fallback to next epoch's assignments if no completed epochs
        this.updateScientistRoles(state.role_assignments)
      }

      // Generate tasks from spec changes
      this.generateTasksFromSpecChanges(state)

      // Robot waves at new epoch
      if (this.robot) {
        this.robot.waveHello()
      }

      // Stream any real code a scientist just pushed to AI-Agent into their desk terminal
      this.checkForLiveCodeContributions(state.current_epoch)

      // Stream what each panel model actually browsed this epoch
      if (latestCompletedEpoch) {
        this.streamEpochBrowsing(latestCompletedEpoch)
      }
    }
  }

  // Live per-role activity while an epoch is still computing. The backend
  // writes each role's output to the DB as it finishes, so as the panel works
  // through planner → executor → challenger → rebuttal → reviewer →
  // commentator, we react to each one the instant it appears: name it in the
  // top ticker, walk that scientist to their desk with a speech bubble of
  // their real remark, and (via streamEpochBrowsing) stream what they browsed.
  private liveAnnouncedKeys: Set<string> = new Set()
  private driveLiveEpochActivity(epoch: ExperimentState['recent_epochs'][0]): void {
    const seq: Array<{ key: string; role: string; assignKey: string; output: unknown }> = [
      { key: 'planner', role: 'Planner', assignKey: 'planner', output: epoch.planner_output },
      { key: 'executor', role: 'Executor', assignKey: 'executor', output: epoch.executor_output },
      { key: 'challenger', role: 'Challenger', assignKey: 'challenger', output: epoch.challenger_output },
      { key: 'rebuttal', role: 'Executor · rebuttal', assignKey: 'executor', output: epoch.executor_rebuttal },
      { key: 'reviewer', role: 'Reviewer', assignKey: 'reviewer', output: epoch.reviewer_output },
      { key: 'commentator', role: 'Commentator', assignKey: 'commentator', output: epoch.commentator_output },
    ]

    for (const step of seq) {
      if (!step.output || typeof step.output !== 'object') continue
      const uid = `${epoch.id}-${step.key}`
      if (this.liveAnnouncedKeys.has(uid)) continue
      this.liveAnnouncedKeys.add(uid)

      const assignedModelId = epoch.role_assignments[step.assignKey as keyof typeof epoch.role_assignments]
      // A fallback model may have answered for the assigned one (`served_by`).
      const servedBy = (step.output as { served_by?: { model?: unknown; fallback?: unknown } }).served_by
      const fellBack = servedBy?.fallback === true && typeof servedBy.model === 'string' && servedBy.model !== ''
      const backendModelId = (fellBack ? servedBy.model : assignedModelId) as typeof assignedModelId
      const frontendModelId = (BACKEND_TO_FRONTEND_MODEL as Record<string, SpriteModelId>)[backendModelId]
      const name = (MODEL_DISPLAY_NAMES[backendModelId] || backendModelId) +
        (fellBack ? ` (fallback for ${MODEL_DISPLAY_NAMES[assignedModelId] || assignedModelId})` : '')
      const accentHex = frontendModelId
        ? '#' + (COLORS.models[frontendModelId] ?? 0x9aa4ad).toString(16).padStart(6, '0')
        : '#9aa4ad'

      // Ticker: who's up + a summary of what they actually DID this turn
      // (drawn from the real output, not the in-character remark).
      const summary = this.summarizeRoleAction(step.key, step.output as Record<string, unknown>)
      this.uiOverlay.showLiveStatus(`${step.role} · ${name}`, summary, accentHex)

      // Physically enact the pipeline as a relay of real handoffs and the
      // rebuttal debate — the scientists move and talk to each other in the
      // actual order the panel works, not randomly.
      this.choreographRole(step.key, epoch)
    }

    // Reuse the existing browsing-stream path (terminal + real page shots).
    this.streamEpochBrowsing(epoch)
  }

  private sci(epoch: ExperimentState['recent_epochs'][0], roleKey: string): Scientist | undefined {
    const backendId = epoch.role_assignments[roleKey as keyof typeof epoch.role_assignments]
    const fid = (BACKEND_TO_FRONTEND_MODEL as Record<string, SpriteModelId>)[backendId]
    return fid ? this.scientists.find(s => s.getModelId() === fid) : undefined
  }

  // Stage the scientists' movement for a role as its output lands. Handoffs
  // and the rebuttal are real two-model interactions, so they're shown as the
  // pair walking to each other and talking; solo roles work at their desk.
  private choreographRole(roleKey: string, epoch: ExperimentState['recent_epochs'][0]): void {
    const setActive = (s?: Scientist) => {
      if (!s) return
      this.scientists.forEach(x => x.setActiveInEpoch(x === s))
      s.returnToStation()
    }
    switch (roleKey) {
      case 'planner': // opens the epoch — thinking at their station
        setActive(this.sci(epoch, 'planner'))
        break
      case 'executor': { // the Planner briefs the Executor
        const planner = this.sci(epoch, 'planner'), executor = this.sci(epoch, 'executor')
        if (planner && executor) planner.converseWith(executor, 5)
        else setActive(executor)
        break
      }
      case 'challenger': { // the Executor presents to the Challenger
        const executor = this.sci(epoch, 'executor'), challenger = this.sci(epoch, 'challenger')
        if (executor && challenger) executor.converseWith(challenger, 5)
        else setActive(challenger)
        break
      }
      case 'rebuttal': { // the debate — Executor answers the Challenger
        const executor = this.sci(epoch, 'executor'), challenger = this.sci(epoch, 'challenger')
        if (executor && challenger) executor.converseWith(challenger, 8)
        break
      }
      case 'reviewer': // rules alone at their station
        setActive(this.sci(epoch, 'reviewer'))
        break
      case 'commentator': // narrates — steps back to take in the plant
        this.scientists.forEach(x => x.setActiveInEpoch(false))
        break
    }
  }

  // Turn a role's raw output into a plain-language summary of what it did —
  // this is what the live ticker narrates, not the in-character remark.
  private summarizeRoleAction(key: string, o: Record<string, unknown>): string {
    const arr = (v: unknown) => (Array.isArray(v) ? v : [])
    switch (key) {
      case 'planner': {
        const dir = String(o.direction || '').trim()
        return dir ? `Setting direction — ${dir}` : 'Setting this epoch’s direction'
      }
      case 'executor': {
        const n = arr(o.mutations).length
        return n ? `Proposed ${n} concrete change${n === 1 ? '' : 's'} to the spec` : 'Drafting changes to the spec'
      }
      case 'challenger': {
        const n = arr(o.challenges).length
        const risk = o.overall_risk ? `, ${o.overall_risk} risk` : ''
        return n ? `Stress-testing — raised ${n} concern${n === 1 ? '' : 's'}${risk}` : 'Stress-testing the proposal'
      }
      case 'rebuttal': {
        const r = arr(o.responses) as Array<{ stance?: string }>
        const c = r.filter(x => x.stance === 'concede').length
        const d = r.filter(x => x.stance === 'defend').length
        const v = r.filter(x => x.stance === 'revise').length
        const parts = [d && `defended ${d}`, v && `revised ${v}`, c && `conceded ${c}`].filter(Boolean)
        return parts.length ? `Answering the challenges — ${parts.join(', ')}` : 'Answering the challenges'
      }
      case 'reviewer': {
        const d = arr(o.decisions) as Array<{ verdict?: string }>
        const a = d.filter(x => x.verdict === 'approve').length
        const m = d.filter(x => x.verdict === 'modify').length
        const rj = d.filter(x => x.verdict === 'reject').length
        return d.length ? `Ruling — approved ${a}, modified ${m}, rejected ${rj}` : 'Ruling on the proposed changes'
      }
      case 'commentator': {
        const mood = o.mood ? `${o.mood}: ` : ''
        const sum = String(o.summary || '').trim()
        return sum ? `${mood}${sum.split(/(?<=[.!?])\s/)[0]}` : 'Summarizing the epoch'
      }
      default:
        return 'Working…'
    }
  }

  // Every panel role runs with real web search — each role's output carries
  // "web_searches" (the queries the model says it ran) and "web_sources" (the
  // pages OpenRouter's web plugin actually cited). Stream that browsing into
  // the matching scientist's terminal, staggered so screens don't all pop at
  // the same instant.
  private streamedBrowsingKeys: Set<string> = new Set()
  private streamEpochBrowsing(epoch: ExperimentState['recent_epochs'][0]): void {
    const roleOutputs: Array<[string, unknown]> = [
      ['planner', epoch.planner_output],
      ['executor', epoch.executor_output],
      ['challenger', epoch.challenger_output],
      ['reviewer', epoch.reviewer_output],
      ['commentator', epoch.commentator_output],
    ]
    const domainOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url } }

    let stagger = 0
    for (const [role, output] of roleOutputs) {
      if (!output || typeof output !== 'object') continue
      const key = `${epoch.id}-${role}`
      if (this.streamedBrowsingKeys.has(key)) continue

      const obj = output as Record<string, unknown>
      const searches = Array.isArray(obj.web_searches) ? (obj.web_searches as string[]).filter(s => typeof s === 'string' && s.trim()) : []
      const sources = Array.isArray(obj.web_sources) ? (obj.web_sources as Array<{ url: string; title?: string }>) : []
      if (!searches.length && !sources.length) continue
      this.streamedBrowsingKeys.add(key)

      const backendModelId = epoch.role_assignments[role as keyof typeof epoch.role_assignments]
      const modelId = (BACKEND_TO_FRONTEND_MODEL as Record<string, SpriteModelId>)[backendModelId]
      if (!modelId) continue

      window.setTimeout(() => {
        const scientist = this.scientists.find(s => s.getModelId() === modelId)
        const terminal = this.terminalScreens.get(modelId)
        if (!scientist || !terminal) return
        this.codingModels.add(modelId)
        scientist.returnToStation()
        const domains = [...new Set(sources.map(s => domainOf(s.url)))].slice(0, 4)
        const lead = searches.length ? `web search: "${searches[0]}"` : `browsing (${role} research)`
        terminal.streamSession(lead, [
          ...domains.map(d => ({ text: `  ↳ ${d}` })),
          ...searches.slice(1, 3).map(q => ({ text: `web search: "${q}"` })),
          { text: `✓ research folded into ${role} decision`, type: 'success' as const },
        ])
        // Show REAL screenshots of the pages it read, on this same terminal:
        // search lines type first, the page appears over them, then clears to
        // reveal the rest of the stream.
        sources.slice(0, 2).forEach((s, i) => {
          window.setTimeout(() => terminal.showPageShot(s.url), 1500 + i * 5800)
        })
        window.setTimeout(() => this.codingModels.delete(modelId), 16000)
      }, stagger)
      stagger += 7000 // one screen at a time, reads as a sequence of researchers
    }
  }

  // Fetch real code contributions for this epoch and stream any not yet shown
  // into the matching scientist's terminal — the actual written code, not a
  // canned simulation. Wildcard (North/GLM) contributions have no terminal by
  // design, so only ones mapping to a panel model are streamed.
  private async checkForLiveCodeContributions(epochNumber: number): Promise<void> {
    try {
      const response = await fetch(`/api/experiment/code-contributions?since_epoch=${epochNumber}`)
      if (!response.ok) return
      const data = await response.json() as {
        contributions: Array<{
          id: string
          model_id: string
          author_name: string
          branch: string
          merged: boolean
          pr_url: string | null
          files: Array<{ path: string; content: string }>
          subagent_files: Array<{ path: string; content: string }>
          explorer_task: string | null
          explorer_findings: string | null
          web_searches?: string[]
          web_sources?: Array<{ url: string; title: string }>
        }>
      }

      for (const contribution of data.contributions) {
        if (this.streamedContributionIds.has(contribution.id)) continue
        this.streamedContributionIds.add(contribution.id)

        const frontendModelId = (BACKEND_TO_FRONTEND_MODEL as Record<string, SpriteModelId>)[contribution.model_id]
        if (frontendModelId && contribution.files.length) {
          this.streamRealCodeSession(frontendModelId, contribution)
        }

        // Pop a gold twig in immediately on a real merge, rather than waiting
        // for the next full state poll to recompute the count and rebuild.
        if (contribution.merged) {
          this.plant?.addCodePrLeaf()
          this.plant?.burstSpores()
          // The author celebrates their code actually landing.
          if (frontendModelId) this.scientists.find(s => s.getModelId() === frontendModelId)?.celebrate()
        } else {
          // PR closed without merging — CI rejected it. Warning lamps flare.
          this.lightingController?.ciFailFlash()
        }

        // A subagent really did something for this contribution — either
        // explored the problem before any code was written, or wrote a test
        // after. Deploy a real drone for it, tagged with its actual parent
        // and showing the REAL task instead of the generic simulated pool.
        // Covers panel models AND wildcards (North/GLM), since subagents
        // aren't tied to having a desk terminal.
        if (contribution.subagent_files.length > 0 || contribution.explorer_task) {
          // Prefer the real web search as the drone's live task when present.
          const droneTask = contribution.web_searches?.[0]
            ? `Searching: ${contribution.web_searches[0]}`
            : contribution.explorer_task ?? undefined
          this.spawnRealSubagentDrone(contribution.author_name, droneTask)
        }

      }
    } catch (e) {
      console.warn('[ObservableLab] Failed to fetch code contributions:', e)
    }
  }

  // Deploy a drone for a subagent that really did something (explored a
  // problem or wrote a test — not the debug/random simulation) and despawn
  // that exact drone once its work is done.
  private async spawnRealSubagentDrone(parentModel: string, realTask?: string): Promise<void> {
    const drone = await this.spawnSubagent(parentModel)
    if (!drone) return // at the visible cap right now — skip rather than evict another one
    if (realTask) drone.lockedTask = realTask
    // Linger long enough for a viewer to notice, hover, and read the task the
    // subagent worked on this epoch (they don't do real work every second, so
    // a short life made them easy to miss).
    window.setTimeout(() => {
      if (!drone.dead) drone.kill()
    }, 90000)
  }

  // Stream a real, merged (or closed) code contribution into a scientist's
  // terminal — same walk-to-desk + streamSession mechanism as the old fake
  // simulation, but with the actual file path and actual written lines, and
  // (when its explorer subagent browsed the web) the real searches + sources.
  private streamRealCodeSession(
    modelId: SpriteModelId,
    contribution: {
      branch: string
      merged: boolean
      pr_url: string | null
      files: Array<{ path: string; content: string }>
      web_searches?: string[]
      web_sources?: Array<{ url: string; title: string }>
    }
  ): void {
    const scientist = this.scientists.find(s => s.getModelId() === modelId)
    if (!scientist) return

    this.codingModels.add(modelId)
    scientist.returnToStation()
    const terminal = this.terminalScreens.get(modelId)
    if (terminal) {
      const file = contribution.files[0]
      const codeLines = file.content.split('\n').filter(l => l.trim().length > 0).slice(0, 14)
      const moreFilesLine = contribution.files.length > 1
        ? [{ text: `+ ${contribution.files.length - 1} more file(s)` }]
        : []

      // Lead with the real web browsing the explorer subagent did, if any.
      const searches = contribution.web_searches ?? []
      const sources = contribution.web_sources ?? []
      const domainOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url } }
      const webLines = [
        ...searches.map(q => ({ text: `web search: "${q}"` })),
        ...sources.slice(0, 4).map(s => ({ text: `  ↳ ${domainOf(s.url)}` })),
      ]

      // If it browsed, open on the first search as the typed command; otherwise
      // open on the file write like before.
      const leadCommand = searches.length ? `web search: "${searches[0]}"` : `cat > ${file.path}`
      const bodyWebLines = searches.length ? webLines.slice(1) : []

      terminal.streamSession(leadCommand, [
        ...bodyWebLines,
        ...(searches.length ? [{ text: `cat > ${file.path}` }] : []),
        ...codeLines.map(line => ({ text: line })),
        ...moreFilesLine,
        { text: `git push origin ${contribution.branch}` },
        { text: 'Opening pull request…' },
        contribution.merged
          ? { text: `✓ merged to main — ${contribution.branch}`, type: 'success' as const }
          : { text: `PR closed (not approved) — ${contribution.branch}`, type: 'error' as const },
      ])

      // The REAL pages the explorer browsed appear on this screen while the
      // search lines type, then clear to reveal the code being written.
      sources.slice(0, 2).forEach((s, i) => {
        window.setTimeout(() => terminal.showPageShot(s.url, 4500), 1200 + i * 5200)
      })
    }
    window.setTimeout(() => this.codingModels.delete(modelId), 14000)
  }

  private generateTasksFromSpecChanges(state: ExperimentState): void {
    const spec = state.current_spec
    const orchestrator = getTaskOrchestrator()

    // Create current snapshot using IDs
    const currentSnapshot = {
      capabilities: spec.capabilities.filter(c => c.status === 'active').map(c => c.id),
      behaviors: spec.behaviors.filter(b => b.status === 'active').map(b => b.id),
      constraints: spec.constraints.filter(c => c.status === 'active').map(c => c.id),
      conflicts: spec.conflicts.filter(c => !c.resolved).map(c => c.id),
    }

    // If no previous snapshot, this is first load - just store and return
    if (!this.previousSpecSnapshot) {
      this.previousSpecSnapshot = currentSnapshot
      return
    }

    const prev = this.previousSpecSnapshot

    // Find new capabilities
    const newCapabilities = currentSnapshot.capabilities.filter(c => !prev.capabilities.includes(c))
    newCapabilities.forEach(capId => {
      const cap = spec.capabilities.find(c => c.id === capId)
      if (cap) {
        orchestrator.createTasksFromSpecChange({
          type: 'capability',
          action: 'added',
          item: { id: capId, name: cap.description.slice(0, 50), description: cap.description },
        })
      }
    })

    // Find new behaviors
    const newBehaviors = currentSnapshot.behaviors.filter(b => !prev.behaviors.includes(b))
    newBehaviors.forEach(behId => {
      const beh = spec.behaviors.find(b => b.id === behId)
      if (beh) {
        orchestrator.createTasksFromSpecChange({
          type: 'behavior',
          action: 'added',
          item: { id: behId, name: beh.description.slice(0, 50), description: beh.description },
        })
      }
    })

    // Find new conflicts
    const newConflicts = currentSnapshot.conflicts.filter(c => !prev.conflicts.includes(c))
    newConflicts.forEach(confId => {
      const conf = spec.conflicts.find(c => c.id === confId)
      if (conf) {
        orchestrator.createTasksFromSpecChange({
          type: 'conflict',
          action: 'added',
          item: { id: confId, name: `Conflict: ${conf.severity}`, description: conf.description },
        })
      }
    })

    // Find resolved conflicts
    const resolvedConflicts = prev.conflicts.filter(c => !currentSnapshot.conflicts.includes(c))
    if (resolvedConflicts.length > 0 && this.robot) {
      // Celebrate resolved conflicts
      this.robot.reactToEvent('milestone')
    }

    // Update snapshot for next comparison
    this.previousSpecSnapshot = currentSnapshot

    // Log task generation
    const totalNew = newCapabilities.length + newBehaviors.length + newConflicts.length
    if (totalNew > 0 && import.meta.env.DEV) {
      console.log(`[TaskOrchestrator] Generated tasks from epoch ${state.current_epoch}:`)
      console.log(`  - ${newCapabilities.length} new capabilities`)
      console.log(`  - ${newBehaviors.length} new behaviors`)
      console.log(`  - ${newConflicts.length} new conflicts`)
      console.log(`  - ${resolvedConflicts.length} resolved conflicts`)
    }
  }

  private updateGeminiWhiteboard(state: ExperimentState): void {
    // Find what role Gemini is playing and get their output
    const latestEpoch = state.recent_epochs[0]
    if (!latestEpoch || !latestEpoch.role_assignments) return

    // Find which role Gemini has
    let geminiRole: string | null = null
    let geminiOutput: unknown = null

    for (const [role, modelId] of Object.entries(latestEpoch.role_assignments)) {
      // Check if this is Gemini (google/gemini-*)
      if (modelId.includes('gemini')) {
        geminiRole = role
        // Get the corresponding output
        switch (role) {
          case 'planner':
            geminiOutput = latestEpoch.planner_output
            break
          case 'executor':
            geminiOutput = latestEpoch.executor_output
            break
          case 'challenger':
            geminiOutput = latestEpoch.challenger_output
            break
          case 'reviewer':
            geminiOutput = latestEpoch.reviewer_output
            break
          case 'commentator':
            geminiOutput = latestEpoch.commentator_output
            break
        }
        break
      }
    }

    if (geminiRole && geminiOutput) {
      this.uiOverlay.updateWhiteboard(geminiOutput, geminiRole, latestEpoch.epoch_number)
    }
  }

  private updatePlantFromSpec(state: ExperimentState): void {
    // Prefer backend-generated geometry (deterministic, epoch-unique)
    // A reviewer pruned something since last update → leaves fall
    const prunings = state.current_spec.meta.total_prunings ?? 0
    if (this.lastPrunings >= 0 && prunings > this.lastPrunings) {
      this.plant.dropLeaf(prunings - this.lastPrunings)
    }
    this.lastPrunings = prunings

    if (state.plant_geometry && state.plant_geometry.nodes && state.plant_geometry.nodes.length > 0) {
      this.plant.setGeometry(state.plant_geometry)
      return
    }

    // Fallback: count-based rendering for old epochs without stored geometry
    const spec = state.current_spec

    // Fallback stability score if missing from API (legacy data)
    const stabilityScore = spec.meta.stability_score ?? 0.85

    // Map spec to plant state
    const plantState: Partial<PlantState> = {
      growthStage: this.mapGrowthStage(spec.meta.growth_stage),
      healthScore: stabilityScore,
      stabilityScore: stabilityScore,
      capabilities: spec.capabilities.filter((c) => c.status === 'active').length,
      constraints: spec.constraints.filter((c) => c.status === 'active').length,
      behaviors: spec.behaviors.filter((b) => b.status === 'active' && b.source !== 'north').length,
      conflicts: spec.conflicts.filter((c) => !c.resolved).length,
      // North's accepted experiments render as a distinct green cluster
      northLeaves: spec.behaviors.filter((b) => b.status === 'active' && b.source === 'north').length,
      // Anything backed by a real, merged code contribution renders as a
      // distinct gold cluster — capabilities and non-wildcard behaviors
      // (wildcard ones already show as green above, even if also code-backed).
      codePrLeaves:
        spec.capabilities.filter((c) => c.status === 'active' && c.code_pr_url).length +
        spec.behaviors.filter((b) => b.status === 'active' && b.source !== 'north' && b.code_pr_url).length,
    }

    this.plant.setState(plantState)
  }

  // -------------------------------------------------------------------------
  // Click-to-inspect: everything in the room represents real data — clicking
  // it should answer "what is that?". Raycast on clean clicks (not drags).
  // -------------------------------------------------------------------------
  private setupInspector(): void {
    const el = this.renderer.domElement
    el.addEventListener('pointerdown', (e) => {
      this.inspectDown = { x: e.clientX, y: e.clientY, t: performance.now() }
    })
    el.addEventListener('pointerup', (e) => {
      const d = this.inspectDown
      this.inspectDown = null
      if (!d) return
      const dist = Math.hypot(e.clientX - d.x, e.clientY - d.y)
      if (dist > 6 || performance.now() - d.t > 500) return // it was a drag
      this.handleInspectClick(e.clientX, e.clientY)
    })

    // tag the static inspectables (jars + scientists tag themselves)
    const dome = this.glassTerrarium.group.getObjectByName('terrariumDome')
    if (dome) dome.userData.inspect = { kind: 'plant' }
    const atmo = this.glassTerrarium.group.getObjectByName('terrariumAtmosphere')
    if (atmo) atmo.userData.inspect = { kind: 'plant' }
    const cork = this.scene.getObjectByName('corkboard')
    if (cork) cork.traverse(o => { o.userData.inspect = { kind: 'behaviors' } })
    if (this.killWall) {
      this.killWall.group.traverse(o => { o.userData.inspect = { kind: 'pruned' } })
    }
  }

  private handleInspectClick(x: number, y: number): void {
    const ndc = new THREE.Vector2(
      (x / window.innerWidth) * 2 - 1,
      -(y / window.innerHeight) * 2 + 1
    )
    this.inspectRay.setFromCamera(ndc, this.camera)
    const hits = this.inspectRay.intersectObjects(this.scene.children, true)

    for (const hit of hits) {
      // walk up the parent chain for an inspect tag
      let o: THREE.Object3D | null = hit.object
      while (o) {
        const tag = o.userData?.inspect as { kind: string; index?: number; modelId?: string } | undefined
        if (tag) {
          const html = this.buildInspectorHtml(tag)
          if (html) {
            this.uiOverlay.showInspectorCard(html, x, y)
            return
          }
        }
        o = o.parent
      }
      // an untagged solid surface blocks the ray — stop at the first real hit
      if ((hit.object as THREE.Mesh).isMesh && hit.object.visible) break
    }
    this.uiOverlay.hideInspectorCard()
  }

  private buildInspectorHtml(tag: { kind: string; index?: number; modelId?: string }): string | null {
    const s = this.lastState
    const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    const row = (l: string, v: string) => `<div class="insp-row"><span>${l}</span><b>${esc(v)}</b></div>`

    switch (tag.kind) {
      case 'plant': {
        if (!s) return null
        const spec = s.current_spec
        const caps = spec.capabilities.filter(c => c.status === 'active').length
        const behs = spec.behaviors.filter(b => b.status === 'active').length
        const cons = spec.constraints.filter(c => c.status === 'active').length
        const confl = spec.conflicts.filter(c => !c.resolved).length
        return `
          <div class="insp-title">The Agent</div>
          <div class="insp-sub">what the plant is</div>
          <div class="insp-body">${esc(spec.identity.purpose)}</div>
          <div style="margin-top:8px">
            ${row('Capabilities (branches)', String(caps))}
            ${row('Behaviors (leaves)', String(behs))}
            ${row('Constraints (roots)', String(cons))}
            ${row('Open conflicts', String(confl))}
            ${row('Stability', `${Math.round((spec.meta.stability_score ?? 0) * 100)}%`)}
            ${row('Epoch', String(s.current_epoch))}
          </div>`
      }
      case 'capability': {
        const info = this.archive?.getCapabilityInfo(tag.index ?? -1)
        if (!info) return null
        const pr = /^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*$/.test(info.pr || '') ? info.pr : null
        return `
          <div class="insp-title">${esc(info.name)}</div>
          <div class="insp-sub">earned capability</div>
          <div class="insp-body">Survived challenge, review${info.pr ? ', and CI' : ''} to earn its jar.</div>
          ${pr ? `<div style="margin-top:6px"><a href="${pr}" target="_blank" rel="noopener noreferrer">View the merged PR →</a></div>` : ''}`
      }
      case 'scientist': {
        if (!s || !tag.modelId) return null
        const backendId = Object.entries(BACKEND_TO_FRONTEND_MODEL).find(([, f]) => f === tag.modelId)?.[0]
        const name = backendId ? (MODEL_DISPLAY_NAMES as Record<string, string>)[backendId] ?? backendId : tag.modelId
        const role = backendId
          ? Object.entries(s.role_assignments).find(([, m]) => m === backendId)?.[0]
          : undefined
        return `
          <div class="insp-title">${esc(name)}</div>
          <div class="insp-sub">researcher</div>
          ${role ? row('Role this epoch', role) : ''}
          ${row('Epochs completed', String(s.current_epoch))}
          <div class="insp-body" style="margin-top:6px">One of five frontier models growing the agent together. Roles change every epoch.</div>`
      }
      case 'behaviors': {
        if (!s) return null
        const active = s.current_spec.behaviors.filter(b => b.status === 'active')
        const items = active.slice(0, 8)
          .map(b => `<li>${esc(b.id.replace(/^beh_/, '').replace(/_/g, ' '))}</li>`).join('')
        return `
          <div class="insp-title">Behavior Board</div>
          <div class="insp-sub">${active.length} active behaviors</div>
          <div class="insp-body"><ul>${items}</ul>${active.length > 8 ? `<div style="margin-top:4px;opacity:0.6">+${active.length - 8} more</div>` : ''}</div>`
      }
      case 'pruned': {
        if (!s) return null
        const pruned = s.current_spec.meta.total_prunings ?? 0
        return `
          <div class="insp-title">The Kill-Wall</div>
          <div class="insp-sub">challenger's record</div>
          ${row('Ideas pruned', String(pruned))}
          <div class="insp-body" style="margin-top:6px">Every idea counted here was challenged, reviewed and pruned from the specification.</div>`
      }
    }
    return null
  }

  // One pinned index card per active behavior (cap 12). First sync lays the
  // board out instantly; behaviors gained while watching pop in.
  private corkNotes: THREE.Mesh[] = []
  private syncBehaviorBoard(count: number): void {
    const board = this.scene.getObjectByName('corkboard')
    if (!board) return
    const target = Math.min(count, 12)
    const colors = [0xf6e08a, 0xbfe3c0, 0xf3b8b0, 0xbcd3ef]
    const animate = this.corkNotes.length > 0
    while (this.corkNotes.length < target) {
      const i = this.corkNotes.length
      const note = new THREE.Mesh(
        new THREE.PlaneGeometry(0.14, 0.14),
        new THREE.MeshStandardMaterial({ color: colors[i % colors.length], roughness: 0.9 })
      )
      note.position.set(-0.36 + (i % 4) * 0.24, 0.2 - Math.floor(i / 4) * 0.22, 0.03)
      note.rotation.z = ((i * 29) % 11 - 5) * 0.03
      board.add(note)
      this.corkNotes.push(note)
      if (animate) {
        note.scale.setScalar(0.01)
        gsap.to(note.scale, { x: 1, y: 1, z: 1, duration: 0.6, ease: 'back.out(2.5)' })
      }
    }
  }

  // Chalk-style tally marks on the planner's whiteboard, one per epoch,
  // bundled in groups of five (four bars + a diagonal strike).
  private tallyCount = 0
  private tallyGroup: THREE.Group | null = null
  private syncEpochTallies(epochs: number): void {
    const props = this.scene.getObjectByName('station_planner')
    if (!props) return
    if (!this.tallyGroup) {
      this.tallyGroup = new THREE.Group()
      this.tallyGroup.name = 'epochTallies'
      props.add(this.tallyGroup)
    }
    const target = Math.min(epochs, 40)
    const ink = new THREE.MeshBasicMaterial({ color: 0x3a4a56 })
    while (this.tallyCount < target) {
      const n = this.tallyCount
      const g = Math.floor(n / 5)
      const inGroup = n % 5
      const baseX = 0.16 + (g % 4) * 0.15
      const baseY = 1.5 - Math.floor(g / 4) * 0.16
      const isStrike = inGroup === 4
      const mark = new THREE.Mesh(
        new THREE.BoxGeometry(0.012, isStrike ? 0.13 : 0.09, 0.004),
        ink
      )
      mark.position.set(baseX + (isStrike ? 0.036 : inGroup * 0.024), baseY, -0.525)
      mark.rotation.z = isStrike ? 1.1 : ((n * 13) % 5 - 2) * 0.02
      this.tallyGroup.add(mark)
      this.tallyCount++
    }
  }

  private mapGrowthStage(stage: string): number {
    const stages: Record<string, number> = {
      seed: 0.1,
      sprout: 0.3,
      growing: 0.6,
      mature: 0.85,
      stable: 1.0,
    }
    return stages[stage] || 0.5
  }

  private updateStationActivation(
    progress: number,
    roleAssignments: Record<string, string>
  ): void {
    // Determine which station should be active based on progress
    // 0-20%: Planner, 20-40%: Executor, 40-60%: Challenger, 60-80%: Reviewer, 80-100%: Commentator
    const stationIndex = Math.min(Math.floor(progress * 5), 4)

    if (stationIndex !== this.activeStationIndex) {
      // Deactivate previous station's scientist
      if (this.activeStationIndex >= 0) {
        const prevRole = ROLES[this.activeStationIndex]
        const prevModelId = roleAssignments[prevRole]
        if (prevModelId) {
          const frontendId = BACKEND_TO_FRONTEND_MODEL[prevModelId as keyof typeof BACKEND_TO_FRONTEND_MODEL]
          const scientist = this.scientists.find((s) => s.getModelId() === frontendId)
          if (scientist) {
            scientist.setActiveInEpoch(false)
          }
        }
      }

      // Activate new station's scientist
      const currentRole = ROLES[stationIndex]
      const currentModelId = roleAssignments[currentRole]
      if (currentModelId) {
        const frontendId = BACKEND_TO_FRONTEND_MODEL[currentModelId as keyof typeof BACKEND_TO_FRONTEND_MODEL]
        const scientist = this.scientists.find((s) => s.getModelId() === frontendId)
        if (scientist) {
          scientist.setActiveInEpoch(true)
          if (import.meta.env.DEV) console.log(`Station activated: ${currentRole} (${frontendId})`)
        }
      }

      this.activeStationIndex = stationIndex
    }
  }

  private deactivateAllStations(): void {
    this.scientists.forEach((scientist) => {
      if (scientist.isActive()) {
        scientist.setActiveInEpoch(false)
      }
    })
    this.activeStationIndex = -1
    if (import.meta.env.DEV) console.log('All stations deactivated')
  }

  private updateScientistRoles(roleAssignments: Record<string, string>): void {
    // Update each scientist's role based on new assignments
    for (const [role, modelId] of Object.entries(roleAssignments)) {
      const frontendId = BACKEND_TO_FRONTEND_MODEL[modelId as keyof typeof BACKEND_TO_FRONTEND_MODEL]
      const scientist = this.scientists.find((s) => s.getModelId() === frontendId)
      if (scientist && ROLE_TO_STATION[role]) {
        scientist.changeRole(ROLE_TO_STATION[role])
      }
    }
  }

  private handleGlassShatter(): void {
    // The animation plays locally. Persisting the shattered state is an
    // operator action (POST /api/experiment/shatter needs the operator
    // credential), so the anonymous viewer no longer calls it.
    if (import.meta.env.DEV) {
      console.log('%c🔮 Glass terrarium shattered! Spec has matured.', 'color: #64b5f6; font-weight: bold')
    }
  }

  private createDevEpochButton(): void {
    if (!import.meta.env.DEV) return // development builds only; the minifier drops the rest
    const button = document.createElement('button')
    button.id = 'dev-run-epoch'
    button.innerHTML = '🧪 Run Epoch'
    button.style.cssText = `
      position: fixed;
      bottom: 20px;
      left: 20px;
      padding: 12px 20px;
      background: linear-gradient(135deg, #7cb342 0%, #558b2f 100%);
      color: white;
      border: none;
      border-radius: 8px;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(124, 179, 66, 0.4);
      transition: all 0.2s ease;
      z-index: 1000;
    `

    button.addEventListener('mouseenter', () => {
      button.style.transform = 'translateY(-2px)'
      button.style.boxShadow = '0 6px 16px rgba(124, 179, 66, 0.5)'
    })

    button.addEventListener('mouseleave', () => {
      button.style.transform = 'translateY(0)'
      button.style.boxShadow = '0 4px 12px rgba(124, 179, 66, 0.4)'
    })

    button.addEventListener('click', async () => {
      button.disabled = true
      button.innerHTML = '⏳ Running...'
      button.style.background = 'linear-gradient(135deg, #888 0%, #666 100%)'
      button.style.cursor = 'wait'

      console.log('%c🚀 Triggering epoch...', 'color: #7cb342; font-weight: bold; font-size: 14px')

      try {
        const response = await fetch('/api/epoch/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })

        const result = await response.json()

        if (response.ok) {
          console.log('%c✅ Epoch completed!', 'color: #7cb342; font-weight: bold; font-size: 14px')
          console.log('Result:', result)
          console.log('New spec:', result.new_spec)
          console.log('Commentator:', result.commentator)

          button.innerHTML = '✅ Done!'
          button.style.background = 'linear-gradient(135deg, #4caf50 0%, #388e3c 100%)'

          setTimeout(() => {
            button.innerHTML = '🧪 Run Epoch'
            button.style.background = 'linear-gradient(135deg, #7cb342 0%, #558b2f 100%)'
            button.disabled = false
            button.style.cursor = 'pointer'
          }, 2000)
        } else {
          console.error('%c❌ Epoch failed:', 'color: #e57373; font-weight: bold', result.error)

          button.innerHTML = '❌ Failed'
          button.style.background = 'linear-gradient(135deg, #e57373 0%, #c62828 100%)'

          setTimeout(() => {
            button.innerHTML = '🧪 Run Epoch'
            button.style.background = 'linear-gradient(135deg, #7cb342 0%, #558b2f 100%)'
            button.disabled = false
            button.style.cursor = 'pointer'
          }, 3000)
        }
      } catch (error) {
        console.error('%c❌ Network error:', 'color: #e57373; font-weight: bold', error)

        button.innerHTML = '❌ Error'
        button.style.background = 'linear-gradient(135deg, #e57373 0%, #c62828 100%)'

        setTimeout(() => {
          button.innerHTML = '🧪 Run Epoch'
          button.style.background = 'linear-gradient(135deg, #7cb342 0%, #558b2f 100%)'
          button.disabled = false
          button.style.cursor = 'pointer'
        }, 3000)
      }
    })

    document.body.appendChild(button)
  }

  private setupDebugControls(): void {
    if (!import.meta.env.DEV) return // development builds only; the minifier drops the rest
    // Add "Run Epoch" button to UI (dev only)
    this.createDevEpochButton()

    // Expose controls for debugging in console
    const win = window as Window & {
      setPlantState?: (state: Partial<PlantState>) => void
      plantPresets?: Record<string, Partial<PlantState>>
      scientists?: {
        startWorking: (modelId: ModelId) => void
        stopWorking: (modelId: ModelId) => void
        allWork: () => void
        allIdle: () => void
        rotateRoles: () => void
        activateInEpoch: (modelId: ModelId) => void
        deactivateAll: () => void
      }
      experiment?: {
        seed: () => Promise<void>
        getState: () => ExperimentState | null
      }
      lighting?: {
        setPreset: (preset: string) => void
      }
      particles?: {
        setPreset: (preset: string) => void
      }
      terrarium?: {
        checkBounds: () => void
        getState: () => string
        forceShatter: () => void
      }
      robot?: {
        react: (event: CodeEvent) => void
        celebrate: () => void
        bigCelebration: () => void
        fail: () => void
        wave: () => void
      }
      screens?: {
        setActivity: (role: StationRole, activity: ScreenActivity) => void
        allWriting: () => void
        allTesting: () => void
        allIdle: () => void
        allError: () => void
        commit: (role: StationRole) => void
      }
      tasks?: {
        create: (type: TaskType, title: string) => void
        assign: (role: StationRole) => void
        start: (role: StationRole) => void
        complete: (role: StationRole) => void
        fail: (role: StationRole) => void
        list: () => void
        demo: () => void
      }
    }

    // Plant controls
    win.setPlantState = (state: Partial<PlantState>) => {
      this.plant.setState(state)
      console.log('Plant state updated:', state)
    }

    win.plantPresets = {
      seed: {
        growthStage: 0.1,
        healthScore: 0.9,
        stabilityScore: 0.3,
        capabilities: 1,
        constraints: 1,
        behaviors: 1,
        conflicts: 0,
      },
      sprout: {
        growthStage: 0.3,
        healthScore: 0.85,
        stabilityScore: 0.4,
        capabilities: 2,
        constraints: 2,
        behaviors: 2,
        conflicts: 0,
      },
      growing: {
        growthStage: 0.6,
        healthScore: 0.8,
        stabilityScore: 0.5,
        capabilities: 4,
        constraints: 3,
        behaviors: 3,
        conflicts: 1,
      },
      mature: {
        growthStage: 0.85,
        healthScore: 0.75,
        stabilityScore: 0.7,
        capabilities: 6,
        constraints: 5,
        behaviors: 4,
        conflicts: 2,
      },
      stable: {
        growthStage: 1.0,
        healthScore: 0.9,
        stabilityScore: 0.95,
        capabilities: 8,
        constraints: 6,
        behaviors: 5,
        conflicts: 0,
      },
      struggling: {
        growthStage: 0.7,
        healthScore: 0.35,
        stabilityScore: 0.3,
        capabilities: 5,
        constraints: 4,
        behaviors: 3,
        conflicts: 6,
      },
      critical: {
        growthStage: 0.5,
        healthScore: 0.15,
        stabilityScore: 0.2,
        capabilities: 3,
        constraints: 2,
        behaviors: 2,
        conflicts: 8,
      },
    }

    // Scientist controls
    win.scientists = {
      startWorking: (modelId: ModelId) => {
        const scientist = this.scientists.find((s) => s.getModelId() === modelId)
        if (scientist) {
          scientist.startWorking()
          console.log(`${modelId} started working`)
        }
      },
      stopWorking: (modelId: ModelId) => {
        const scientist = this.scientists.find((s) => s.getModelId() === modelId)
        if (scientist) {
          scientist.stopWorking()
          console.log(`${modelId} stopped working`)
        }
      },
      allWork: () => {
        this.scientists.forEach((s) => s.startWorking())
        console.log('All scientists working')
      },
      allIdle: () => {
        this.scientists.forEach((s) => s.stopWorking())
        console.log('All scientists idle')
      },
      rotateRoles: () => {
        const roles: StationRole[] = [
          'planner',
          'executor',
          'reviewer',
          'challenger',
          'commentator',
        ]
        this.scientists.forEach((scientist, i) => {
          const newRole = roles[(i + 1) % 5]
          scientist.changeRole(newRole)
        })
        console.log('Roles rotated')
      },
      activateInEpoch: (modelId: ModelId) => {
        const scientist = this.scientists.find((s) => s.getModelId() === modelId)
        if (scientist) {
          scientist.setActiveInEpoch(true)
          console.log(`${modelId} activated in epoch (glowing)`)
        }
      },
      deactivateAll: () => {
        this.deactivateAllStations()
      },
    }

    // Experiment controls
    win.experiment = {
      seed: async () => {
        const stateManager = getStateManager()
        const id = await stateManager.seedExperiment()
        console.log('Experiment seeded:', id)
      },
      getState: () => {
        const stateManager = getStateManager()
        return stateManager.getState()
      },
    }

    // Lighting controls
    win.lighting = {
      setPreset: (preset: string) => {
        if (this.lightingController) {
          this.lightingController.transitionTo(preset)
          console.log(`Lighting preset: ${preset}`)
        }
      },
    }

    // Particle controls
    win.particles = {
      setPreset: (preset: string) => {
        if (this.particleSystem) {
          this.particleSystem.transitionTo(preset as 'green_spores' | 'red_chaotic' | 'blue_orbital' | 'gold_dust')
          console.log(`Particle preset: ${preset}`)
        }
      },
    }

    // Terrarium controls
    win.terrarium = {
      checkBounds: () => {
        this.glassTerrarium.checkPlantBounds(this.plant.group)
        console.log(`Terrarium state: ${this.glassTerrarium.getState()}, contacts: ${this.glassTerrarium.getContactCount()}, branches outside: ${this.glassTerrarium.getBranchesOutside()}`)
      },
      getState: () => {
        return `State: ${this.glassTerrarium.getState()}, Contacts: ${this.glassTerrarium.getContactCount()}, Branches outside: ${this.glassTerrarium.getBranchesOutside()}`
      },
      forceShatter: () => {
        // For testing: set plant to a size that will trigger shatter
        this.plant.setState({
          growthStage: 1.0,
          capabilities: 8,
          behaviors: 5,
        })
        this.glassTerrarium.checkPlantBounds(this.plant.group)
        console.log('Plant grown to max - checking bounds...')
      },
    }

    // Robot controls
    win.robot = {
      react: (event: CodeEvent) => {
        if (this.robot) {
          this.robot.reactToEvent(event)
          console.log(`Robot reacting to: ${event}`)
        }
      },
      celebrate: () => {
        if (this.robot) {
          this.robot.celebrate()
          console.log('Robot celebrating!')
        }
      },
      bigCelebration: () => {
        if (this.robot) {
          this.robot.bigCelebration()
          console.log('Robot big celebration!')
        }
      },
      fail: () => {
        if (this.robot) {
          this.robot.showDisappointment()
          console.log('Robot disappointed')
        }
      },
      wave: () => {
        if (this.robot) {
          this.robot.waveHello()
          console.log('Robot waving!')
        }
      },
    }

    // Screen controls
    win.screens = {
      setActivity: (role: StationRole, activity: ScreenActivity) => {
        const screen = this.getScreenForRole(role)
        if (screen) {
          screen.setActivity(activity)
          console.log(`${role} screen set to: ${activity}`)
        } else {
          console.log(`No screen for role: ${role} (planner has whiteboard)`)
        }
      },
      allWriting: () => {
        this.stationScreens.forEach((screen) => {
          screen.setActivity('writing')
        })
        console.log('All screens: writing')
      },
      allTesting: () => {
        this.stationScreens.forEach((screen) => {
          screen.setActivity('testing')
        })
        console.log('All screens: testing')
      },
      allIdle: () => {
        this.stationScreens.forEach((screen) => {
          screen.setActivity('idle')
        })
        console.log('All screens: idle')
      },
      allError: () => {
        this.stationScreens.forEach((screen) => {
          screen.setActivity('error')
        })
        console.log('All screens: error')
      },
      commit: (role: StationRole) => {
        const screen = this.getScreenForRole(role)
        if (screen) {
          screen.setActivity('committing')
          setTimeout(() => screen.setActivity('idle'), 2000)
          console.log(`${role} screen: commit flash`)
        }
      },
    }

    // Task controls
    const orchestrator = getTaskOrchestrator()
    win.tasks = {
      create: (type: TaskType, title: string) => {
        const task = orchestrator.createTask({
          type,
          title,
          description: `Task: ${title}`,
        })
        console.log(`Task created: ${task.id} - ${title}`)
      },
      assign: (role: StationRole) => {
        const task = orchestrator.getNextTaskForRole(role)
        if (task) {
          orchestrator.assignTask(task.id, role)
        } else {
          console.log(`No pending tasks for role: ${role}`)
        }
      },
      start: (role: StationRole) => {
        const task = orchestrator.getActiveTaskForRole(role)
        if (task) {
          orchestrator.startTask(task.id)
        } else {
          console.log(`No active task for role: ${role}`)
        }
      },
      complete: (role: StationRole) => {
        const task = orchestrator.getActiveTaskForRole(role)
        if (task) {
          orchestrator.completeTask(task.id)
        } else {
          console.log(`No active task for role: ${role}`)
        }
      },
      fail: (role: StationRole) => {
        const task = orchestrator.getActiveTaskForRole(role)
        if (task) {
          orchestrator.failTask(task.id, 'Manual failure')
        } else {
          console.log(`No active task for role: ${role}`)
        }
      },
      list: () => {
        const tasks = orchestrator.getAllTasks()
        console.log('All tasks:', tasks)
        console.log('Pending:', orchestrator.getPendingTasks())
      },
      demo: async () => {
        console.log('Running task demo...')
        // Create a task
        const task = orchestrator.createTask({
          type: 'implement_feature',
          title: 'Demo Feature',
          description: 'A demo feature for testing',
          priority: 'high',
        })
        await new Promise(r => setTimeout(r, 500))

        // Assign to executor
        orchestrator.assignTask(task.id, 'executor')
        await new Promise(r => setTimeout(r, 1000))

        // Start task
        orchestrator.startTask(task.id)
        await new Promise(r => setTimeout(r, 3000))

        // Complete task
        orchestrator.completeTask(task.id)
        console.log('Demo complete!')
      },
    }

    console.log(
      '%c🌱 Observable Lab Debug Controls',
      'color: #7cb342; font-weight: bold; font-size: 14px'
    )
    console.log('')
    console.log('%cPlant Controls:', 'font-weight: bold')
    console.log('  setPlantState({ growthStage: 0.5, healthScore: 0.8, ... })')
    console.log('  setPlantState(plantPresets.seed | sprout | growing | mature | stable | struggling | critical)')
    console.log('')
    console.log('%cScientist Controls:', 'font-weight: bold')
    console.log('  scientists.startWorking("claude" | "gemini" | "deepseek" | "gpt" | "grok")')
    console.log('  scientists.stopWorking("claude")')
    console.log('  scientists.allWork()')
    console.log('  scientists.allIdle()')
    console.log('  scientists.rotateRoles()')
    console.log('  scientists.activateInEpoch("claude") // Glow effect')
    console.log('  scientists.deactivateAll()')
    console.log('')
    console.log('%cExperiment Controls:', 'font-weight: bold')
    console.log('  experiment.seed() // Start new experiment')
    console.log('  experiment.getState() // Get current state')
    console.log('')
    console.log('%cVisual Controls:', 'font-weight: bold')
    console.log('  lighting.setPreset("thriving" | "healthy" | "struggling" | "critical")')
    console.log('  particles.setPreset("green_spores" | "red_chaotic" | "blue_orbital" | "gold_dust")')
    console.log('')
    console.log('%cTerrarium Controls:', 'font-weight: bold')
    console.log('  terrarium.checkBounds() // Check plant against glass')
    console.log('  terrarium.getState() // Get current state + contacts')
    console.log('  terrarium.forceShatter() // Grow plant to max and check')
    console.log('')
    console.log('%cRobot Controls:', 'font-weight: bold')
    console.log('  robot.react("idle" | "tests_pass" | "all_tests_pass" | "tests_fail" | "build_broken" | "bug_fixing" | "pr_merged" | "epoch_start" | "milestone")')
    console.log('  robot.celebrate() // Quick celebration')
    console.log('  robot.bigCelebration() // Dance!')
    console.log('  robot.fail() // Show disappointment')
    console.log('  robot.wave() // Wave hello')
    console.log('')
    console.log('%cScreen Controls:', 'font-weight: bold')
    console.log('  screens.setActivity("executor" | "reviewer" | "challenger" | "commentator", "idle" | "writing" | "reading" | "testing" | "committing" | "error")')
    console.log('  screens.allWriting() // All screens show writing activity')
    console.log('  screens.allTesting() // All screens show testing')
    console.log('  screens.allIdle() // Reset all to idle')
    console.log('  screens.allError() // All screens show error')
    console.log('  screens.commit("executor") // Golden commit flash')
    console.log('')
    console.log('%cTask Controls:', 'font-weight: bold')
    console.log('  tasks.create("implement_feature", "Build login") // Create task')
    console.log('  tasks.assign("executor") // Assign next task to role')
    console.log('  tasks.start("executor") // Start the assigned task')
    console.log('  tasks.complete("executor") // Complete task (triggers celebration)')
    console.log('  tasks.fail("executor") // Fail task (triggers error)')
    console.log('  tasks.list() // Show all tasks')
    console.log('  tasks.demo() // Run full task demo')
  }

  private onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(window.innerWidth, window.innerHeight)
  }

  private animate(): void {
    requestAnimationFrame(this.animate.bind(this))

    const deltaTime = this.clock.getDelta()

    // Update plant animation (SDF raymarch billboard needs the frame's proj*view)
    this.scannerProjView.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse)
    this.plant.setProjView(this.scannerProjView)
    this.plant.update(deltaTime, this.camera)

    // Update glass terrarium animation (for shatter physics)
    this.glassTerrarium.update(deltaTime)

    // Archive wall: jar orbs float; faster while an epoch computes
    this.archive?.update(deltaTime)

    // Update all scientists
    this.scientists.forEach((scientist) => {
      scientist.update(deltaTime)
    })

    // Update robot mascot
    if (this.robot) {
      this.robot.update(deltaTime)
    }

    // Training rig (lamps, fan, data pulses, gauge)
    this.trainingRig?.update(deltaTime)

    // J-space lens follows its scientist
    this.jspaceLens?.update(deltaTime, this.camera)

    // Scanner probes share the plant's proj*view (computed above)
    if (this.scanners.length) {
      const plantH = 0.5 + (this.plant ? this.plant.getTrunkKeepout() * 2.2 : 0.4)
      for (const sd of this.scanners) {
        sd.update(deltaTime, this.camera, plantH)
        sd.setProjView(this.scannerProjView)
      }
    }

    // Update GLM wildcard (paces in front of the NN artwork)
    if (this.glm) {
      this.glm.update(deltaTime)
    }

    // Update subagent drones; remove any that finished despawning
    const trunkKeepout = this.plant.getTrunkKeepout()
    for (let i = this.drones.length - 1; i >= 0; i--) {
      const drone = this.drones[i]
      drone.update(deltaTime, this.drones, trunkKeepout)
      if (drone.dead) {
        this.uiOverlay.removeDroneLabel(drone.labelEl)
        this.scene.remove(drone.group)
        drone.dispose()
        this.drones.splice(i, 1)
      }
    }

    // Update station screens
    this.stationScreens.forEach((screen) => {
      screen.update(deltaTime)
    })

    // Update terminal screens — each only shows while its model is coding AND
    // physically at its own desk. Walk away and the screen vanishes.
    this.terminalScreens.forEach((terminal, modelId) => {
      terminal.update(deltaTime, this.camera)

      const scientist = this.scientists.find(s => s.getModelId() === modelId)
      if (!scientist) return
      const atDesk =
        scientist.group.position.distanceTo(scientist.getStationPosition()) < 1.3
      const shouldShow = this.codingModels.has(modelId) && atDesk

      if (shouldShow && !terminal.isShowing()) {
        terminal.setVisible(true)
      } else if (!shouldShow && terminal.isShowing()) {
        terminal.setVisible(false)
      }
    })

    // Update UI overlay (label positions)
    this.uiOverlay.update()

    // Update particle system
    if (this.particleSystem) {
      this.particleSystem.update(deltaTime)
    }

    // Update patina system (dust particles)
    if (this.patinaSystem) {
      this.patinaSystem.update(deltaTime)
    }

    // Update wall clock
    const wallClock = getWallClock()
    if (wallClock) {
      wallClock.update(deltaTime)
    }

    // Update controls
    this.controls.update()

    // Render
    this.renderer.render(this.scene, this.camera)
  }
}

// Initialize
new ObservableLab()

