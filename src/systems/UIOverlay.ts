import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import gsap from 'gsap'
import { Scientist, ModelId } from '../entities/Scientist'
import { StationRole } from '../scene/colors'
import { MODEL_PROVIDER_NAMES, MODEL_PROVIDER_LOGOS, PROVIDER_LOGOS } from '../shared/types'
import { panelName, panelModelId, shortName, modelSlug, providerName, wildcardName, wildcardModelId } from './modelLabels'
import { defaultRepoLinks, type RepoLink } from './repoLinks'
import { installPaperTheme, paperFocusRing } from './paperTheme'

// Personalities stay with the scientist; the model names come from the shared
// maps so a panel change shows everywhere without editing this file.
// GitHub mark (the one the room has always used)
const GITHUB_MARK_PATH = 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z'

const MODEL_PERSONALITY: Record<ModelId, string> = {
  gemini: 'Exploratory, multimodal',
  deepseek: 'Methodical, structured',
  claude: 'Safety-conscious, nuanced',
  gpt: 'Agentic, general-purpose',
  grok: 'Edgy, adversarial',
}

const ROLE_INFO: Record<StationRole, { title: string; description: string }> = {
  planner: { title: 'Planner', description: 'Sets direction: "What should we explore next?"' },
  executor: { title: 'Executor', description: 'Implements: "Here\'s how that capability would work"' },
  reviewer: { title: 'Reviewer', description: 'Judges: "Approve, reject, or modify"' },
  challenger: { title: 'Challenger', description: 'Attacks: "Here\'s how this could fail"' },
  commentator: { title: 'Commentator', description: 'Narrates: "Here\'s what happened"' },
}

const MODEL_COLORS_HEX: Record<ModelId, string> = {
  gemini: '#4285F4',
  deepseek: '#10A37F',
  claude: '#D97706',
  gpt: '#412991',
  grok: '#1DA1F2',
}

// Whiteboard note entry
interface WhiteboardNote {
  text: string
  role: string
  epoch: number
}

export class UIOverlay {
  private container: HTMLDivElement
  private labelsContainer: HTMLDivElement
  private tooltipElement: HTMLDivElement
  private infoPanelElement: HTMLDivElement | null = null
  private whiteboardElement: HTMLDivElement | null = null
  private robotStatusCard: HTMLDivElement | null = null
  private robotGroup: THREE.Group | null = null
  private robotStatusTimeout: number | null = null
  private robotLabel: HTMLDivElement | null = null
  private glmLabel: { el: HTMLDivElement; target: THREE.Object3D } | null = null
  private droneLabels: { el: HTMLDivElement; target: THREE.Object3D }[] = []
  private hoveredDroneTip: { label: HTMLElement; getInfo: () => { parent: string; task: string }; accent: string } | null = null
  // Set by main.ts: toggle the J-space lens for a scientist; returns whether
  // the lens is now active on them (so the button can reflect state).
  public onJSpaceToggle: ((scientist: Scientist) => boolean) | null = null
  private agentSpeechBubble: HTMLDivElement | null = null
  private liveStatusEl: HTMLDivElement | null = null
  private plantGroup: THREE.Group | null = null
  private _agentName: string = 'Agent'
  private isAgentAwake: boolean = false
  private camera: THREE.PerspectiveCamera
  private controls: OrbitControls
  private scientists: Scientist[]
  private labels: Map<Scientist, HTMLDivElement> = new Map()
  private _hoveredScientist: Scientist | null = null
  private focusedScientist: Scientist | null = null
  private isAnimating: boolean = false
  // Where the camera goes to read the practice bench, which stands at the edge of the default view.
  private benchView: { position: [number, number, number]; target: [number, number, number] } | null = null
  private benchFocused: boolean = false
  private isInfoExpanded: boolean = false
  private currentEpoch: number = 0
  private stabilityScore: number = 0.5
  private seedPurpose: string = 'An autonomous agent'
  // True until stored experiment state arrives: the room is then playing a
  // local simulation, and the info panel says so.
  private simulationMode: boolean = true
  private whiteboardNotes: WhiteboardNote[] = []
  private scientistTasks: Map<Scientist, string> = new Map()

  constructor(camera: THREE.PerspectiveCamera, controls: OrbitControls, scientists: Scientist[]) {
    this.camera = camera
    this.controls = controls
    this.scientists = scientists

    // Create main container
    installPaperTheme()
    this.container = document.createElement('div')
    this.container.id = 'ui-overlay'
    this.container.innerHTML = `
      <style>
        #ui-overlay {
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          pointer-events: none;
          z-index: 100;
          font-family: var(--paper-sans);
        }

        #labels-container {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
        }

        .scientist-label {
          position: absolute;
          transform: translate(-50%, -100%);
          pointer-events: auto;
          cursor: pointer;
          transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .scientist-label:hover {
          transform: translate(-50%, -100%) scale(1.08);
        }

        .scientist-label:hover .label-card {
          background: var(--paper-surface);
          border-color: var(--paper-ink);
          box-shadow: var(--paper-shadow-lift);
        }

        .scientist-label.focused {
          transform: translate(-50%, -100%) scale(1.12);
          z-index: 10;
        }

        .scientist-label.focused .label-card {
          background: var(--paper-raised);
          border-color: var(--paper-brass-edge);
          box-shadow: var(--paper-shadow-lift), 0 0 0 2px var(--paper-brass-edge);
        }

        .scientist-label.focused .label-indicator {
          animation: focusPulse 1s ease-in-out infinite;
        }

        @keyframes focusPulse {
          0%, 100% { transform: scale(1); box-shadow: 0 0 0 1px var(--paper-line); }
          50% { transform: scale(1.4); box-shadow: 0 0 0 1px var(--paper-line); }
        }

        .label-card {
          background: var(--paper-raised-veil);
          border-radius: 16px;
          padding: 4px 10px 5px;
          box-shadow: var(--paper-shadow-soft);
          border: 1px solid var(--paper-line);
          text-align: center;
          min-width: 56px;
        }

        .label-name {
          font-weight: 600;
          font-size: 13px;
          color: var(--paper-ink);
          letter-spacing: -0.2px;
          white-space: nowrap;
        }

        /* The model accent stays as the small dot above the name; text is ink. */
        .label-role {
          font-size: 13px;
          color: var(--paper-ink-2);
          text-transform: uppercase;
          letter-spacing: 0.4px;
          font-weight: 500;
        }

        .label-status {
          font-size: 13px;
          color: var(--paper-ink-2);
          margin-top: 2px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 120px;
          opacity: 0;
          max-height: 0;
          transition: opacity 0.3s ease, max-height 0.3s ease;
        }

        .label-status.active {
          opacity: 1;
          max-height: 20px;
        }

        .label-indicator {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: var(--accent-color);
          margin: 0 auto 3px;
          box-shadow: 0 0 0 1px var(--paper-line);
          animation: pulse 2.5s ease-in-out infinite;
        }

        .label-indicator.blink {
          animation: subagentBlink 1.1s steps(1) infinite;
        }
        @keyframes subagentBlink { 0%, 100% { opacity: 1; } 50% { opacity: 0.12; } }

        .jspace-btn {
          display: block;
          margin: 5px auto 0;
          padding: 3px 10px;
          font-size: 13px;
          font-weight: 700;
          letter-spacing: 0.2px;
          font-family: var(--paper-mono);
          line-height: 14px;
          color: var(--paper-ink);
          border: 1px solid var(--paper-line);
          border-radius: 999px;
          cursor: pointer;
          opacity: 1;
          background: var(--paper-raised);
          transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease;
          pointer-events: auto;
        }
        .scientist-label:hover .jspace-btn,
        .jspace-btn:hover,
        .jspace-btn.active {
          opacity: 1;
        }
        .jspace-btn:hover {
          background: var(--paper-sunk);
          border-color: var(--paper-ink);
        }
        .jspace-btn.active {
          background: var(--paper-brass);
          border-color: var(--paper-brass-edge);
          color: var(--paper-ink);
        }
        .jspace-btn.active:hover {
          background: var(--paper-brass);
          border-color: var(--paper-ink);
        }
        ${paperFocusRing('#ui-overlay')}

        /* While a scientist's lens is up, their label steps aside so the
           readout isn't blocked; hover brings it back to toggle off. */
        .scientist-label.jspace-dimmed {
          opacity: 0.28;
        }
        .scientist-label.jspace-dimmed:hover {
          opacity: 1;
        }

        .scientist-label.drone-mini .label-card {
          transform: scale(0.74);
          transform-origin: center bottom;
        }
        .scientist-label.drone-mini .label-task {
          max-width: 170px;
          margin-top: 2px;
          font-size: 13px;
          line-height: 1.3;
          font-weight: 500;
          color: var(--paper-ink-2);
          white-space: normal;
          text-align: center;
        }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }

        #tooltip {
          position: absolute;
          background: var(--paper-raised);
          color: var(--paper-ink);
          padding: 14px;
          border-radius: var(--paper-radius-panel);
          max-width: 220px;
          box-shadow: var(--paper-shadow);
          border: 1px solid var(--paper-line);
          pointer-events: none;
          opacity: 0;
          transition: opacity 0.2s ease, transform 0.2s ease;
          transform: translateY(4px);
          z-index: 200;
        }

        #tooltip.visible {
          opacity: 1;
          transform: translateY(0);
        }

        .tooltip-header {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 10px;
          padding-bottom: 8px;
          border-bottom: 1px solid var(--paper-hair);
        }

        .tooltip-avatar {
          width: 32px;
          height: 32px;
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 600;
          font-size: 13px;
          overflow: hidden;
          padding: 4px;
        }

        .tooltip-avatar.provider-logo {
          flex: 0 0 32px;
          background: var(--paper-white);
          box-shadow: inset 0 0 0 1px var(--paper-hair);
          padding: 5px;
          box-sizing: border-box;
        }

        .tooltip-avatar.provider-logo img {
          width: 100%;
          height: 100%;
          object-fit: contain;
        }

        .tooltip-title {
          flex: 1;
        }

        .tooltip-name {
          font-family: var(--paper-serif);
          font-weight: 700;
          font-size: 13px;
          margin-bottom: 1px;
        }

        .tooltip-provider {
          font-size: 13px;
          color: var(--paper-ink-2);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .tooltip-section {
          margin-bottom: 8px;
        }

        .tooltip-section:last-child {
          margin-bottom: 0;
        }

        .tooltip-section-title {
          font-size: 13px;
          text-transform: uppercase;
          letter-spacing: 0.8px;
          color: var(--paper-ink-2);
          margin-bottom: 3px;
        }

        .tooltip-section-content {
          font-size: 13px;
          line-height: 1.4;
          color: var(--paper-ink);
        }

        /* The model accent is a small bar on the badge edge; the words are ink. */
        .tooltip-role-badge {
          display: inline-block;
          padding: 3px 8px;
          border-radius: 6px;
          font-size: 13px;
          font-weight: 600;
          background: var(--paper-sunk);
          color: var(--paper-ink);
          box-shadow: inset 3px 0 0 var(--accent-color);
        }

        #experiment-info {
          position: fixed;
          top: 16px;
          left: 16px;
          background: var(--paper-raised);
          color: var(--paper-ink);
          padding: 12px 16px 14px;
          border-radius: var(--paper-radius-panel);
          box-shadow: var(--paper-shadow-soft);
          border: 1px solid var(--paper-line);
          border-top: 3px solid var(--paper-brass);
          pointer-events: auto;
          max-width: 260px;
          overflow: hidden;
        }

        #github-links {
          position: fixed;
          bottom: 20px;
          left: 20px;
          display: flex;
          gap: 10px;
          pointer-events: auto;
          z-index: 150;
        }

        .gh-btn {
          position: relative;
          width: 44px;
          height: 44px;
          border-radius: 50%;
          background: var(--paper-raised-veil);
          color: var(--paper-ink);
          border: 1px solid var(--paper-line);
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: var(--paper-shadow-soft);
          transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
          text-decoration: none;
          -webkit-tap-highlight-color: transparent;
        }

        .gh-btn:hover,
        .gh-btn.tip-open {
          transform: translateY(-2px);
          border-color: var(--paper-ink);
          box-shadow: var(--paper-shadow-lift);
        }

        .gh-btn:focus { outline: none; }
        .gh-btn:focus-visible {
          outline: 2px solid var(--paper-focus);
          outline-offset: 2px;
        }

        .gh-btn svg {
          width: 22px;
          height: 22px;
        }

        /* Small letter under the mark so the three read apart at a glance */
        .gh-tag {
          position: absolute;
          bottom: 3px;
          right: 5px;
          font: 700 9px/1 var(--paper-sans);
          color: var(--paper-ink);
          letter-spacing: 0.2px;
        }

        .gh-tip {
          position: absolute;
          bottom: calc(100% + 10px);
          left: 0;
          width: max-content;
          max-width: min(240px, calc(100vw - 40px));
          padding: 8px 10px;
          border-radius: var(--paper-radius-sm);
          background: var(--paper-raised);
          border: 1px solid var(--paper-line);
          color: var(--paper-ink);
          font: 500 12px/1.4 var(--paper-sans);
          box-shadow: var(--paper-shadow-soft);
          opacity: 0;
          transform: translateY(4px);
          transition: opacity 0.15s ease, transform 0.15s ease;
          pointer-events: none;
          white-space: normal;
        }

        .gh-tip strong { color: var(--paper-brass-ink); font-weight: 700; }
        .gh-tip .gh-tip-hint { display: block; margin-top: 3px; color: var(--paper-ink-2); font-size: 13px; }

        .gh-btn:hover .gh-tip,
        .gh-btn:focus-visible .gh-tip,
        .gh-btn.tip-open .gh-tip {
          opacity: 1;
          transform: translateY(0);
        }

        .gh-btn.tip-dismissed .gh-tip { opacity: 0; }

        @media (prefers-reduced-motion: reduce) {
          .gh-btn, .gh-tip { transition: none; }
          .gh-btn:hover, .gh-btn.tip-open { transform: none; }
          .label-indicator, .scientist-label.focused .label-indicator,
          #live-status .live-caret { animation: none; }
        }

        #github-commit-badge {
          position: absolute;
          pointer-events: none;
          top: -5px;
          right: -5px;
          min-width: 18px;
          height: 18px;
          padding: 0 4px;
          border-radius: 9px;
          background: var(--paper-ink);
          color: var(--paper-raised);
          font-family: var(--paper-sans);
          font-size: 10px;
          font-weight: 700;
          line-height: 18px;
          text-align: center;
          box-shadow: 0 0 0 1px var(--paper-raised);
          transform: scale(0);
          transition: transform 0.3s cubic-bezier(0.34, 1.8, 0.4, 1);
        }

        #github-commit-badge.show {
          transform: scale(1);
        }

        #inspector-card {
          position: fixed;
          min-width: 220px;
          max-width: 300px;
          background: var(--paper-raised);
          border: 1px solid var(--paper-line);
          border-radius: var(--paper-radius-panel);
          box-shadow: var(--paper-shadow);
          color: var(--paper-ink);
          padding: 12px 14px;
          z-index: 300;
          font-family: var(--paper-sans);
          pointer-events: auto;
          opacity: 0;
          transform: translateY(6px) scale(0.96);
          transition: opacity 0.18s ease, transform 0.22s cubic-bezier(0.2, 1.4, 0.4, 1);
        }
        #inspector-card.show { opacity: 1; transform: translateY(0) scale(1); }
        #inspector-card .insp-title {
          font-family: var(--paper-serif);
          font-size: 13px; font-weight: 700; color: var(--paper-ink);
          margin: 0 18px 2px 0; letter-spacing: 0.2px;
        }
        #inspector-card .insp-sub {
          font-size: 13px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase;
          color: var(--paper-ink-2); margin-bottom: 8px;
        }
        #inspector-card .insp-row {
          display: flex; justify-content: space-between; gap: 12px;
          font-size: 13px; line-height: 1.7; color: var(--paper-ink-2);
        }
        #inspector-card .insp-row b { font-weight: 600; color: var(--paper-ink); text-align: right; }
        #inspector-card .insp-body {
          font-size: 13px; line-height: 1.55; color: var(--paper-ink); margin-top: 2px;
        }
        #inspector-card .insp-body ul { margin: 4px 0 0 14px; padding: 0; }
        #inspector-card a {
          color: var(--paper-brass-ink); font-weight: 600; text-decoration: underline; font-size: 13px;
        }
        #inspector-card a:hover { color: var(--paper-ink); }
        #inspector-card .insp-close {
          position: absolute; top: 8px; right: 10px; cursor: pointer;
          font-size: 13px; color: var(--paper-ink-2); border: none; background: none; padding: 2px;
        }
        #inspector-card .insp-close:hover { color: var(--paper-ink); }

        #live-status {
          position: fixed;
          bottom: 20px;
          left: 50%;
          transform: translateX(-50%) translateY(8px);
          max-width: min(560px, calc(100vw - 160px));
          display: flex;
          align-items: center;
          gap: 9px;
          padding: 10px 16px;
          background: var(--paper-raised);
          border: 1px solid var(--paper-line);
          border-radius: var(--paper-radius-panel);
          box-shadow: var(--paper-shadow-soft);
          font-family: var(--paper-sans);
          font-size: 13px;
          color: var(--paper-ink);
          opacity: 0;
          transition: opacity 0.3s ease, transform 0.3s ease;
          pointer-events: auto;
          z-index: 160;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        #live-status.visible { opacity: 1; transform: translateX(-50%) translateY(0); }
        /* The model accent is a 2px underline mark; the role name itself is ink. */
        #live-status .live-role {
          font-weight: 700; flex-shrink: 0; letter-spacing: -0.1px; color: var(--paper-ink);
          text-decoration: underline; text-decoration-color: var(--accent-color);
          text-decoration-thickness: 2px; text-underline-offset: 3px;
        }
        #live-status .live-close {
          flex-shrink: 0; margin-left: 4px; border: none; background: none; cursor: pointer;
          color: var(--paper-ink-2); font-size: 15px; line-height: 1; padding: 0 2px;
          transition: color 0.15s ease;
        }
        #live-status .live-close:hover { color: var(--paper-ink); }
        #live-status .live-remark { color: var(--paper-ink-2); overflow: hidden; text-overflow: ellipsis; }
        #live-status .live-caret {
          display: inline-block; width: 1px; height: 12px; margin-left: 1px;
          background: var(--paper-ink); vertical-align: -1px;
          animation: liveCaret 0.9s step-end infinite;
        }
        @keyframes liveCaret { 50% { opacity: 0; } }



        .info-header {
          margin-bottom: 10px;
        }

        .info-title {
          font-family: var(--paper-serif);
          font-size: 15px;
          line-height: 19px;
          font-weight: 700;
          color: var(--paper-ink);
          margin: 0 0 2px 0;
          letter-spacing: 0;
        }

        .info-subtitle {
          font-size: 13px;
          color: var(--paper-ink-2);
          margin: 0;
          letter-spacing: 0.2px;
        }

        .info-simulation {
          display: inline-block;
          margin: 0 0 8px;
          padding: 2px 8px;
          border-radius: 4px;
          background: var(--paper-visitor);
          color: var(--paper-ink);
          font-size: 13px;
          font-weight: 600;
          letter-spacing: 0.2px;
        }

        .info-stats {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 10px;
          font-size: 13px;
          color: var(--paper-ink-2);
        }

        .info-epoch {
          font-weight: 600;
          color: var(--paper-ink);
        }

        .info-health {
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .info-health-label {
          color: var(--paper-ink-2);
        }

        .health-dots {
          display: flex;
          gap: 3px;
        }

        /* Each dot carries a thin ink ring so the status colour never has to
           stand alone against paper. */
        .health-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          transition: background-color 0.3s ease;
        }

        .health-dot.filled {
          box-shadow: 0 0 0 1px var(--paper-ink-2);
        }

        .health-dot.empty {
          background: var(--paper-sunk);
          box-shadow: 0 0 0 1px var(--paper-line);
        }

        .info-toggle {
          display: flex;
          align-items: center;
          gap: 6px;
          cursor: pointer;
          font: inherit;
          font-size: 13px;
          color: var(--paper-ink-2);
          padding: 4px 0;
          transition: color 0.15s ease;
          user-select: none;
          /* a real button, so the keyboard can open the card: no button chrome */
          background: none;
          border: 0;
          width: 100%;
          text-align: left;
        }

        .info-toggle:focus-visible {
          outline: 2px solid var(--paper-ink);
          outline-offset: 2px;
        }

        .info-toggle:hover {
          color: var(--paper-ink);
        }

        .info-toggle-arrow {
          font-size: 13px;
          transition: transform 0.2s ease;
        }

        .info-toggle.expanded .info-toggle-arrow {
          transform: rotate(180deg);
        }

        /* While collapsed the content is hidden for real (after its closing transition), so its buttons are not in the Tab order. */
        .info-content {
          max-height: 0;
          overflow: hidden;
          transition: max-height 0.2s ease-out, opacity 0.15s ease, visibility 0s linear 0.2s;
          opacity: 0;
          visibility: hidden;
        }

        .info-content.expanded {
          max-height: 70vh;
          overflow-y: auto;
          opacity: 1;
          visibility: visible;
          transition: max-height 0.2s ease-in, opacity 0.2s ease 0.05s, visibility 0s;
        }

        .info-divider {
          height: 1px;
          background: var(--paper-hair);
          margin: 10px 0;
        }

        .info-description {
          font-size: 13px;
          color: var(--paper-ink-2);
          line-height: 1.55;
          margin: 0;
        }

        .info-bench-button {
          margin-top: 8px;
          min-height: 44px;
          min-width: 44px;
          padding: 0 14px;
          font: inherit;
          font-size: 13px;
          color: var(--paper-ink);
          background: var(--paper-raised);
          border: 1px solid var(--paper-line);
          border-radius: var(--paper-radius);
          cursor: pointer;
          pointer-events: auto;
        }

        .info-bench-button:hover {
          background: var(--paper-sunk);
          border-color: var(--paper-ink);
        }

        .info-description + .info-description {
          margin-top: 10px;
        }

        .info-seed {
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px solid var(--paper-hair);
        }

        .info-seed-label {
          font-size: 13px;
          color: var(--paper-ink-2);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 4px;
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .info-seed-purpose {
          font-size: 13px;
          color: var(--paper-ink);
          font-style: italic;
          line-height: 1.4;
        }

        .info-section {
          margin-top: 12px;
          padding-top: 10px;
          border-top: 1px solid var(--paper-hair);
        }

        .info-section-label {
          font-size: 13px;
          color: var(--paper-ink-2);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 6px;
          font-weight: 600;
        }

        .info-section-content {
          font-size: 13px;
          color: var(--paper-ink-2);
          line-height: 1.5;
        }

        .info-list {
          margin: 6px 0;
          padding-left: 16px;
        }

        .info-list li {
          margin-bottom: 3px;
        }

        .info-list.compact li {
          margin-bottom: 2px;
        }

        .info-list strong {
          color: var(--paper-ink);
        }

        .info-note {
          font-size: 13px;
          color: var(--paper-ink-2);
          font-style: italic;
          margin-top: 6px;
        }

        /* Whiteboard Notes Overlay - DISABLED: white text on white board not readable */
        #whiteboard-overlay {
          display: none;
        }

        /* Robot Status Card */
        #robot-status-card {
          position: absolute;
          transform: translate(-50%, -100%);
          pointer-events: none;
          opacity: 0;
          transition: opacity 0.3s ease, transform 0.3s ease;
        }

        #robot-status-card.visible {
          opacity: 1;
        }

        .robot-status-content {
          background: var(--paper-raised);
          border-radius: var(--paper-radius);
          padding: 8px 14px;
          box-shadow: var(--paper-shadow-soft);
          border: 1px solid var(--paper-line);
          display: flex;
          align-items: center;
          gap: 8px;
          white-space: nowrap;
        }

        .robot-status-icon {
          font-size: 14px;
          color: var(--paper-ink);
        }

        .robot-status-text {
          font-size: 13px;
          font-weight: 600;
          color: var(--paper-ink);
          letter-spacing: 0.3px;
        }

        /* States tell apart by edge and wash, and always by their words. Red is for errors only. */
        .robot-status-content.success {
          border-color: var(--paper-ink);
        }

        .robot-status-content.error {
          background: var(--paper-danger-bg);
          border-color: var(--paper-danger);
        }

        .robot-status-content.error .robot-status-icon,
        .robot-status-content.error .robot-status-text {
          color: var(--paper-danger);
        }

        .robot-status-content.working {
          background: var(--paper-visitor);
          border-color: var(--paper-brass-edge);
        }

        /* Agent Speech Bubble */
        #agent-speech-bubble {
          position: absolute;
          transform: translate(-50%, -100%);
          pointer-events: auto;
          opacity: 0;
          transition: opacity 0.5s ease, transform 0.5s ease;
          max-width: 320px;
        }

        #agent-speech-bubble.visible {
          opacity: 1;
        }

        .agent-speech-content {
          background: var(--paper-raised);
          color: var(--paper-ink);
          border-radius: var(--paper-radius-panel);
          padding: 14px 18px;
          box-shadow: var(--paper-shadow);
          border: 1px solid var(--paper-line);
          position: relative;
        }

        .agent-speech-content::before,
        .agent-speech-content::after {
          content: '';
          position: absolute;
          left: 50%;
          transform: translateX(-50%);
          border-style: solid;
        }

        .agent-speech-content::before {
          bottom: -11px;
          border-width: 11px 11px 0 11px;
          border-color: var(--paper-line) transparent transparent transparent;
        }

        .agent-speech-content::after {
          bottom: -10px;
          border-width: 10px 10px 0 10px;
          border-color: var(--paper-raised) transparent transparent transparent;
        }

        .agent-speech-header {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;
          padding-bottom: 8px;
          border-bottom: 1px solid var(--paper-hair);
        }

        .agent-speech-name {
          font-family: var(--paper-serif);
          font-size: 13px;
          font-weight: 700;
          color: var(--paper-ink);
          letter-spacing: 0.5px;
          text-transform: uppercase;
        }

        .agent-speech-indicator {
          width: 8px;
          height: 8px;
          background: var(--paper-ink-2);
          box-shadow: 0 0 0 1px var(--paper-line);
          border-radius: 50%;
        }

        .agent-speech-text {
          font-size: 13px;
          color: var(--paper-ink);
          line-height: 1.5;
          font-style: italic;
        }

        .agent-speech-close {
          position: absolute;
          top: 8px;
          right: 10px;
          background: none;
          border: none;
          color: var(--paper-ink-2);
          cursor: pointer;
          font-size: 16px;
          padding: 4px;
          line-height: 1;
        }

        .agent-speech-close:hover {
          color: var(--paper-ink);
        }
      </style>
    `
    document.body.appendChild(this.container)

    // Create labels container
    this.labelsContainer = document.createElement('div')
    this.labelsContainer.id = 'labels-container'
    this.container.appendChild(this.labelsContainer)

    // Create tooltip
    this.tooltipElement = document.createElement('div')
    this.tooltipElement.id = 'tooltip'
    this.container.appendChild(this.tooltipElement)

    // Create experiment info panel
    this.createExperimentInfo()

    // Create GitHub link (bottom-left, matches the transcript toggle's style)
    this.createGithubLink()

    // Create whiteboard overlay
    this.createWhiteboardOverlay()

    // Create robot status card
    this.createRobotStatusCard()

    // Create agent speech bubble
    this.createAgentSpeechBubble()

    // Create labels for each scientist
    this.createLabels()
  }

  private createRobotStatusCard(): void {
    this.robotStatusCard = document.createElement('div')
    this.robotStatusCard.id = 'robot-status-card'
    this.robotStatusCard.innerHTML = `
      <div class="robot-status-content">
        <span class="robot-status-icon"></span>
        <span class="robot-status-text"></span>
      </div>
    `
    this.container.appendChild(this.robotStatusCard)
  }

  // Set robot reference for status card positioning
  public setRobot(robotGroup: THREE.Group, identity?: { name: string; role: string; accent: string }): void {
    this.robotGroup = robotGroup
    if (identity && !this.robotLabel) {
      this.createRobotLabel(identity.name, identity.role, identity.accent)
    }
  }

  // Subagent drones get the same nameplate design as the scientists, plus a
  // blinking indicator dot. Returns the element so the caller can remove it.
  public addDroneLabel(
    target: THREE.Object3D,
    getInfo: () => { parent: string; task: string },
    accent: string = '#6ed2f0'
  ): HTMLDivElement {
    const label = document.createElement('div')
    label.className = 'scientist-label drone-mini'
    label.style.setProperty('--accent-color', accent)
    label.innerHTML = `
      <div class="label-card">
        <div class="label-indicator blink"></div>
        <div class="label-name">Subagent</div>
      </div>
    `
    label.addEventListener('mouseenter', () => { this.hoveredDroneTip = { label, getInfo, accent } })
    label.addEventListener('mouseleave', () => { this.hoveredDroneTip = null; this.tooltipElement.classList.remove('visible') })
    this.labelsContainer.appendChild(label)
    this.droneLabels.push({ el: label, target })
    return label
  }

  /** A drone sent on a stored task (an explorer run) carries that task on its nameplate. */
  public setDroneTask(label: HTMLElement | null, parent: string, task: string): void {
    const card = label?.querySelector('.label-card')
    if (!card) return
    const name = card.querySelector('.label-name')
    if (name) name.textContent = `Explorer for ${parent}`
    let line = card.querySelector('.label-task') as HTMLDivElement | null
    if (!line) {
      line = document.createElement('div')
      line.className = 'label-task'
      card.appendChild(line)
    }
    line.textContent = task
  }

  public removeDroneLabel(el: HTMLElement | null): void {
    if (!el) return
    if (this.hoveredDroneTip?.label === el) { this.hoveredDroneTip = null; this.tooltipElement.classList.remove('visible') }
    this.droneLabels = this.droneLabels.filter((d) => d.el !== el)
    el.remove()
  }

  // Live hover card for a subagent — shows what it's doing right now, refreshed
  // each frame so the task updates in real time.
  private renderDroneTooltip(label: HTMLElement, getInfo: () => { parent: string; task: string }, accent: string): void {
    const info = getInfo()
    this.tooltipElement.innerHTML = `
      <div class="tooltip-header">
        <div class="tooltip-avatar" style="background:${accent};display:flex;align-items:center;justify-content:center;color:var(--paper-ink);font-weight:700;">⬡</div>
        <div class="tooltip-title">
          <div class="tooltip-name">Subagent</div>
          <div class="tooltip-provider">${info.parent ? 'deployed by ' + info.parent : 'autonomous helper'}</div>
        </div>
      </div>
      <div class="tooltip-section">
        <div class="tooltip-section-title">Doing now</div>
        <div class="tooltip-section-content"><span style="color:${accent};">●</span> ${this.escapeHtml(info.task)}…</div>
      </div>
    `
    const rect = label.getBoundingClientRect()
    this.tooltipElement.style.left = `${rect.right + 10}px`
    this.tooltipElement.style.top = `${rect.top}px`
    const tr = this.tooltipElement.getBoundingClientRect()
    if (tr.right > window.innerWidth) this.tooltipElement.style.left = `${rect.left - tr.width - 10}px`
    if (tr.bottom > window.innerHeight) this.tooltipElement.style.top = `${window.innerHeight - tr.height - 10}px`
    this.tooltipElement.classList.add('visible')
  }

  // GLM (the Machine Man wildcard) gets the same nameplate + a North-style hover card.
  public addGlmLabel(target: THREE.Object3D, accent: string = '#b07cff'): HTMLDivElement {
    const label = document.createElement('div')
    label.className = 'scientist-label'
    label.style.setProperty('--accent-color', accent)
    label.innerHTML = `
      <div class="label-card">
        <div class="label-indicator"></div>
        <div class="label-name">${this.escapeHtml(wildcardName('glm'))}</div>
        <div class="label-role">WILDCARD</div>
      </div>
    `
    label.addEventListener('mouseenter', () => this.onGlmLabelHover(label, accent))
    label.addEventListener('mouseleave', () => this.onLabelLeave())
    this.labelsContainer.appendChild(label)
    this.glmLabel = { el: label, target }
    return label
  }

  private onGlmLabelHover(label: HTMLElement, accent: string): void {
    this.tooltipElement.innerHTML = `
      <div class="tooltip-header">
        <div class="tooltip-avatar provider-logo"><img src="${PROVIDER_LOGOS['z-ai']}" alt="Z.ai logo" width="22" height="22"></div>
        <div class="tooltip-title">
          <div class="tooltip-name">${this.escapeHtml(wildcardName('glm'))}</div>
          <div class="tooltip-provider">${this.escapeHtml(providerName(wildcardModelId('glm')))} · ${this.escapeHtml(modelSlug(wildcardModelId('glm')))}</div>
        </div>
      </div>
      <div class="tooltip-section">
        <div class="tooltip-section-title">Current Role</div>
        <div class="tooltip-section-content">
          <span class="tooltip-role-badge" style="--accent-color: ${accent};">Wildcard · R&amp;D</span>
        </div>
      </div>
      <div class="tooltip-section">
        <div class="tooltip-section-title">Role Description</div>
        <div class="tooltip-section-content">Autonomous R&amp;D agent. Runs its own coding experiments in a sandbox on its own branch; accepted work merges to main.</div>
      </div>
      <div class="tooltip-section">
        <div class="tooltip-section-title">Working with</div>
        <div class="tooltip-section-content">${this.escapeHtml(wildcardName('north'))}</div>
      </div>
    `
    const rect = label.getBoundingClientRect()
    this.tooltipElement.style.left = `${rect.right + 10}px`
    this.tooltipElement.style.top = `${rect.top}px`
    const tr = this.tooltipElement.getBoundingClientRect()
    if (tr.right > window.innerWidth) this.tooltipElement.style.left = `${rect.left - tr.width - 10}px`
    if (tr.bottom > window.innerHeight) this.tooltipElement.style.top = `${window.innerHeight - tr.height - 10}px`
    this.tooltipElement.classList.add('visible')
  }

  // North gets the same nameplate design (and hover tooltip) as the scientists.
  private createRobotLabel(name: string, role: string, accent: string): void {
    const label = document.createElement('div')
    label.className = 'scientist-label'
    label.style.setProperty('--accent-color', accent)
    label.innerHTML = `
      <div class="label-card">
        <div class="label-indicator"></div>
        <div class="label-name">${name}</div>
        <div class="label-role">${role}</div>
        <div class="label-status">Idle</div>
      </div>
    `
    label.addEventListener('mouseenter', () => this.onRobotLabelHover(label, accent))
    label.addEventListener('mouseleave', () => this.onLabelLeave())
    this.labelsContainer.appendChild(label)
    this.robotLabel = label
  }

  private onRobotLabelHover(label: HTMLElement, accent: string): void {
    this.tooltipElement.innerHTML = `
      <div class="tooltip-header">
        <div class="tooltip-avatar provider-logo"><img src="${PROVIDER_LOGOS.cohere}" alt="Cohere logo" width="22" height="22"></div>
        <div class="tooltip-title">
          <div class="tooltip-name">${this.escapeHtml(wildcardName('north'))}</div>
          <div class="tooltip-provider">${this.escapeHtml(providerName(wildcardModelId('north')))} · ${this.escapeHtml(modelSlug(wildcardModelId('north')))}</div>
        </div>
      </div>
      <div class="tooltip-section">
        <div class="tooltip-section-title">Current Role</div>
        <div class="tooltip-section-content">
          <span class="tooltip-role-badge" style="--accent-color: ${accent};">Wildcard · R&amp;D</span>
        </div>
      </div>
      <div class="tooltip-section">
        <div class="tooltip-section-title">Role Description</div>
        <div class="tooltip-section-content">Autonomous R&amp;D agent. Runs its own coding experiments in a sandbox on its own branch; accepted work sprouts as green leaves.</div>
      </div>
      <div class="tooltip-section">
        <div class="tooltip-section-title">Pairs with</div>
        <div class="tooltip-section-content">${this.escapeHtml(wildcardName('glm'))}, they write code together</div>
      </div>
    `

    const rect = label.getBoundingClientRect()
    this.tooltipElement.style.left = `${rect.right + 10}px`
    this.tooltipElement.style.top = `${rect.top}px`
    const tooltipRect = this.tooltipElement.getBoundingClientRect()
    if (tooltipRect.right > window.innerWidth) {
      this.tooltipElement.style.left = `${rect.left - tooltipRect.width - 10}px`
    }
    if (tooltipRect.bottom > window.innerHeight) {
      this.tooltipElement.style.top = `${window.innerHeight - tooltipRect.height - 10}px`
    }
    this.tooltipElement.classList.add('visible')
  }

  // Show status card above robot
  public showRobotStatus(icon: string, text: string, type: 'success' | 'error' | 'working' | 'neutral' = 'neutral', duration: number = 4000): void {
    if (!this.robotStatusCard) return

    const content = this.robotStatusCard.querySelector('.robot-status-content') as HTMLElement
    const iconEl = this.robotStatusCard.querySelector('.robot-status-icon') as HTMLElement
    const textEl = this.robotStatusCard.querySelector('.robot-status-text') as HTMLElement

    if (content && iconEl && textEl) {
      // Clear previous type classes
      content.classList.remove('success', 'error', 'working')
      if (type !== 'neutral') {
        content.classList.add(type)
      }

      iconEl.textContent = icon
      textEl.textContent = text
      this.robotStatusCard.classList.add('visible')

      // Clear any existing timeout
      if (this.robotStatusTimeout) {
        clearTimeout(this.robotStatusTimeout)
      }

      // Auto-hide after duration
      this.robotStatusTimeout = window.setTimeout(() => {
        this.hideRobotStatus()
      }, duration)
    }
  }

  // Hide robot status card
  public hideRobotStatus(): void {
    if (this.robotStatusCard) {
      this.robotStatusCard.classList.remove('visible')
    }
    if (this.robotStatusTimeout) {
      clearTimeout(this.robotStatusTimeout)
      this.robotStatusTimeout = null
    }
  }

  // Create agent speech bubble
  private createAgentSpeechBubble(): void {
    this.agentSpeechBubble = document.createElement('div')
    this.agentSpeechBubble.id = 'agent-speech-bubble'
    this.agentSpeechBubble.innerHTML = `
      <div class="agent-speech-content">
        <button class="agent-speech-close">[x]</button>
        <div class="agent-speech-header">
          <div class="agent-speech-indicator"></div>
          <span class="agent-speech-name">Agent</span>
        </div>
        <div class="agent-speech-text"></div>
      </div>
    `
    this.container.appendChild(this.agentSpeechBubble)

    // Add close button handler
    const closeBtn = this.agentSpeechBubble.querySelector('.agent-speech-close')
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.hideAgentSpeech())
    }
  }

  // Set plant reference for speech bubble positioning
  public setPlant(plantGroup: THREE.Group): void {
    this.plantGroup = plantGroup
  }

  // Set agent awakening state
  public setAgentAwake(awake: boolean, name?: string): void {
    this.isAgentAwake = awake
    if (name) {
      this._agentName = name
      // Update the name in the speech bubble
      const nameEl = this.agentSpeechBubble?.querySelector('.agent-speech-name')
      if (nameEl) {
        nameEl.textContent = name
      }
    }
  }

  // Show agent speech bubble above plant
  public showAgentSpeech(text: string, duration?: number): void {
    if (!this.agentSpeechBubble || !this.isAgentAwake) return

    const textEl = this.agentSpeechBubble.querySelector('.agent-speech-text') as HTMLElement
    if (textEl) {
      textEl.textContent = text
      this.agentSpeechBubble.classList.add('visible')

      // Auto-hide after duration if specified
      if (duration) {
        setTimeout(() => {
          this.hideAgentSpeech()
        }, duration)
      }
    }
  }

  // Hide agent speech bubble
  public hideAgentSpeech(): void {
    if (this.agentSpeechBubble) {
      this.agentSpeechBubble.classList.remove('visible')
    }
  }

  // Get agent name
  public getAgentName(): string {
    return this._agentName
  }

  // Update agent speech bubble position (call in animation loop)
  private updateAgentSpeechPosition(): void {
    if (!this.agentSpeechBubble || !this.plantGroup) return
    if (!this.agentSpeechBubble.classList.contains('visible')) return

    // Get plant world position (slightly above the plant)
    const plantPos = new THREE.Vector3()
    this.plantGroup.getWorldPosition(plantPos)
    plantPos.y += 1.2 // Position above plant

    // Project to screen
    plantPos.project(this.camera)

    const x = (plantPos.x * 0.5 + 0.5) * window.innerWidth
    const y = (-plantPos.y * 0.5 + 0.5) * window.innerHeight

    this.agentSpeechBubble.style.left = `${x}px`
    this.agentSpeechBubble.style.top = `${y}px`
  }

  private createWhiteboardOverlay(): void {
    this.whiteboardElement = document.createElement('div')
    this.whiteboardElement.id = 'whiteboard-overlay'
    this.whiteboardElement.classList.add('hidden')
    this.container.appendChild(this.whiteboardElement)
  }

  // Update whiteboard with Gemini's output
  public updateWhiteboard(geminiOutput: unknown, geminiRole: string, epochNumber: number): void {
    if (!geminiOutput || !this.whiteboardElement) return

    // Extract a short summary from Gemini's output based on role
    const noteText = this.extractNoteFromOutput(geminiOutput, geminiRole)
    if (!noteText) return

    // Add new note
    this.whiteboardNotes.unshift({
      text: noteText,
      role: geminiRole,
      epoch: epochNumber
    })

    // Keep only last 3 notes
    this.whiteboardNotes = this.whiteboardNotes.slice(0, 3)

    // Render notes
    this.renderWhiteboardNotes()
  }

  private extractNoteFromOutput(output: unknown, role: string): string {
    if (typeof output !== 'object' || output === null) return ''
    const obj = output as Record<string, unknown>

    switch (role) {
      case 'planner':
        return obj.direction ? String(obj.direction).slice(0, 80) : ''
      case 'executor':
        const mutations = obj.mutations as Array<{ value?: { description?: string } }> | undefined
        if (mutations && mutations.length > 0) {
          const desc = mutations[0].value?.description
          return desc ? `Added: ${String(desc).slice(0, 60)}` : ''
        }
        return ''
      case 'challenger':
        const challenges = obj.challenges as Array<{ issue: string }> | undefined
        if (challenges && challenges.length > 0) {
          return `⚠ ${String(challenges[0].issue).slice(0, 60)}`
        }
        return ''
      case 'reviewer':
        const decisions = obj.decisions as Array<{ verdict: string; reason: string }> | undefined
        if (decisions && decisions.length > 0) {
          const d = decisions[0]
          const mark = d.verdict === 'approve' ? '✓' : d.verdict === 'reject' ? '✗' : '~'
          return `${mark} ${String(d.reason).slice(0, 60)}`
        }
        return ''
      case 'commentator':
        return obj.highlight ? String(obj.highlight).slice(0, 80) : ''
      default:
        return ''
    }
  }

  private renderWhiteboardNotes(): void {
    if (!this.whiteboardElement) return

    const notesHtml = this.whiteboardNotes.map((note, i) => {
      const rotation = (Math.random() - 0.5) * 4 // -2 to 2 degrees
      const fadedClass = i > 0 ? 'faded' : ''
      return `
        <div class="whiteboard-note ${fadedClass}" style="transform: rotate(${rotation}deg);">
          "${this.escapeHtml(note.text)}"
        </div>
      `
    }).join('')

    this.whiteboardElement.innerHTML = notesHtml

    this.whiteboardElement.classList.remove('hidden')
  }

  private createExperimentInfo(): void {
    // Load saved preference
    this.isInfoExpanded = localStorage.getItem('observableLab_infoExpanded') === 'true'

    const info = document.createElement('div')
    info.id = 'experiment-info'
    this.infoPanelElement = info

    this.renderInfoPanel()
    this.container.appendChild(info)
  }

  // ---- Live epoch activity (real-time, mid-run) ----
  // Bottom-center ticker naming the role currently working + its spoken remark,
  // which types out character-by-character on each update. Collapsible: the ×
  // dismisses it for the session (re-shown on reload).
  private liveTypeTimer: number | null = null
  private liveStatusDismissed = false
  public showLiveStatus(role: string, remark: string, accentHex: string): void {
    if (this.liveStatusDismissed) return
    if (!this.liveStatusEl) {
      this.liveStatusEl = document.createElement('div')
      this.liveStatusEl.id = 'live-status'
      this.container.appendChild(this.liveStatusEl)
    }
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    this.liveStatusEl.innerHTML = `
      <span class="live-role" style="--accent-color:${esc(accentHex)}">${esc(role)}</span>
      <span class="live-remark"></span><span class="live-caret"></span>
      <button class="live-close" title="Hide live status" aria-label="Hide">×</button>
    `
    const closeBtn = this.liveStatusEl.querySelector('.live-close') as HTMLButtonElement | null
    closeBtn?.addEventListener('click', () => {
      this.liveStatusDismissed = true
      this.hideLiveStatus()
    })
    this.liveStatusEl.classList.add('visible')

    // Typewriter the remark. Cap the visual length so a long remark doesn't
    // type forever; the ellipsis keeps the pill from growing unbounded.
    const remarkEl = this.liveStatusEl.querySelector('.live-remark') as HTMLElement
    const caretEl = this.liveStatusEl.querySelector('.live-caret') as HTMLElement
    const full = remark.length > 140 ? remark.slice(0, 139) + '…' : remark
    if (this.liveTypeTimer) window.clearInterval(this.liveTypeTimer)
    let i = 0
    this.liveTypeTimer = window.setInterval(() => {
      i++
      remarkEl.textContent = full.slice(0, i)
      if (i >= full.length) {
        if (this.liveTypeTimer) window.clearInterval(this.liveTypeTimer)
        this.liveTypeTimer = null
        // Retire the caret shortly after typing finishes.
        window.setTimeout(() => { if (caretEl) caretEl.style.display = 'none' }, 700)
      }
    }, 18)
  }

  public hideLiveStatus(): void {
    if (this.liveTypeTimer) { window.clearInterval(this.liveTypeTimer); this.liveTypeTimer = null }
    this.liveStatusEl?.classList.remove('visible')
  }

  // GitHub buttons for the three repositories: the specimen (AI-Agent, with
  // the commit-count bubble), the room's own code, and the research record.
  // Hover or keyboard focus shows what each holds; on touch the first tap
  // shows it and a second tap opens the repo.
  private githubGroup: HTMLDivElement | null = null
  private repoLinksKey = ''
  private createGithubLink(): void {
    const group = document.createElement('div')
    group.id = 'github-links'
    group.setAttribute('role', 'group')
    group.setAttribute('aria-label', 'Source code on GitHub')
    this.container.appendChild(group)
    this.githubGroup = group
    this.setRepoLinks(defaultRepoLinks())

    // a tap anywhere else closes an open tooltip
    document.addEventListener('pointerdown', (e) => {
      if (!group.contains(e.target as Node)) this.closeRepoTips()
    })
  }

  private closeRepoTips(except?: Element): void {
    this.githubGroup?.querySelectorAll('.gh-btn.tip-open').forEach(b => {
      if (b !== except) b.classList.remove('tip-open')
    })
  }

  public setRepoLinks(links: RepoLink[]): void {
    const group = this.githubGroup
    if (!group) return
    const key = links.map(l => l.key + l.url).join('|')
    if (key === this.repoLinksKey) return
    this.repoLinksKey = key
    group.textContent = ''
    const tags: Record<string, string> = { ai_agent: 'A', observable_lab: 'L', research_lab: 'R' }
    for (const link of links) {
      const a = document.createElement('a')
      a.className = 'gh-btn'
      a.href = link.url
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      a.dataset.repo = link.key
      a.setAttribute('aria-label', `${link.name} on GitHub, opens in a new tab`)
      const tipId = `gh-tip-${link.key}`
      a.setAttribute('aria-describedby', tipId)
      a.innerHTML = `
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
          <path fill-rule="evenodd" d="${GITHUB_MARK_PATH}"/>
        </svg>
        <span class="gh-tag" aria-hidden="true">${tags[link.key] || ''}</span>
        <span class="gh-tip" role="tooltip" id="${tipId}"></span>
        ${link.key === 'ai_agent' ? '<span id="github-commit-badge" aria-hidden="true"></span>' : ''}
      `
      const tip = a.querySelector('.gh-tip') as HTMLSpanElement
      const strong = document.createElement('strong')
      strong.textContent = `${link.name}:`
      tip.append(strong, ` ${link.blurb} `)
      const hint = document.createElement('span')
      hint.className = 'gh-tip-hint'
      hint.textContent = 'Opens on GitHub'
      tip.append(hint)

      let lastPointer = ''
      a.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType })
      a.addEventListener('click', (e) => {
        // touch: first tap explains, second tap opens
        if (lastPointer === 'touch' && !a.classList.contains('tip-open')) {
          e.preventDefault()
          this.closeRepoTips(a)
          a.classList.remove('tip-dismissed')
          a.classList.add('tip-open')
        }
        lastPointer = ''
      })
      a.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') a.classList.add('tip-dismissed')
      })
      a.addEventListener('blur', () => a.classList.remove('tip-dismissed', 'tip-open'))
      a.addEventListener('mouseleave', () => a.classList.remove('tip-dismissed'))
      group.appendChild(a)
    }
    // the bubble element was rebuilt; show the last known count again
    const count = this.commitBadgeCount
    this.commitBadgeCount = -1
    if (count >= 0) this.setCommitBadge(count)
  }

  // Click-to-inspect card: one reusable panel, positioned near the click,
  // clamped to the viewport. Content is trusted internal HTML.
  private inspectorEl: HTMLDivElement | null = null
  public showInspectorCard(html: string, x: number, y: number): void {
    if (!this.inspectorEl) {
      this.inspectorEl = document.createElement('div')
      this.inspectorEl.id = 'inspector-card'
      this.container.appendChild(this.inspectorEl)
    }
    const el = this.inspectorEl
    el.innerHTML = `<button class="insp-close">✕</button>${html}`
    el.querySelector('.insp-close')!.addEventListener('click', () => this.hideInspectorCard())
    el.classList.remove('show')
    el.style.left = '0px'
    el.style.top = '0px'
    // measure, then clamp into the viewport near the click
    requestAnimationFrame(() => {
      const w = el.offsetWidth
      const h = el.offsetHeight
      el.style.left = `${Math.min(Math.max(8, x + 14), window.innerWidth - w - 8)}px`
      el.style.top = `${Math.min(Math.max(8, y - h / 2), window.innerHeight - h - 8)}px`
      el.classList.add('show')
    })
  }

  public hideInspectorCard(): void {
    this.inspectorEl?.classList.remove('show')
  }

  // Green notification bubble on the GitHub icon — count of the agent's real
  // merged commits. Pops on first show and whenever the number changes.
  private commitBadgeCount = -1
  public setCommitBadge(count: number): void {
    if (count === this.commitBadgeCount) return
    this.commitBadgeCount = count
    const badge = document.getElementById('github-commit-badge')
    if (!badge) return
    if (count <= 0) {
      badge.classList.remove('show')
      return
    }
    badge.textContent = count > 99 ? '99+' : String(count)
    // re-pop when the count changes so a fresh merge draws the eye
    badge.classList.remove('show')
    requestAnimationFrame(() => requestAnimationFrame(() => badge.classList.add('show')))
  }

  private renderInfoPanel(): void {
    if (!this.infoPanelElement) return

    const healthDots = this.getHealthDotsHTML()
    const toggleClass = this.isInfoExpanded ? 'expanded' : ''

    this.infoPanelElement.innerHTML = `
      <div class="info-header">
        <h1 class="info-title">Observable Lab</h1>
        <p class="info-subtitle">by Dervin Dimanche, a personal experiment</p>
      </div>
      ${this.simulationMode
        ? '<div class="info-simulation" id="info-simulation" title="No experiment is connected. Desk activity and terminal text are a local simulation, not model work.">Simulation: no experiment connected</div>'
        : ''}
      <div class="info-stats">
        <span class="info-epoch">Epoch ${this.currentEpoch}</span>
        <span class="info-separator">·</span>
        <div class="info-health">
          <span class="info-health-label">Health</span>
          <div class="health-dots">${healthDots}</div>
        </div>
      </div>
      <button type="button" class="info-toggle ${toggleClass}" id="info-about-toggle" aria-expanded="${this.isInfoExpanded ? 'true' : 'false'}" aria-controls="info-about-content">
        <span class="info-toggle-arrow" aria-hidden="true">▼</span>
        <span>About</span>
      </button>
      <div class="info-content ${toggleClass}" id="info-about-content">
        <div class="info-divider"></div>
        <p class="info-description">
          Five AI models from five different labs (Gemini, DeepSeek, Claude, GPT and Grok) work together, round after round, to design an autonomous agent. They start from one seed purpose, below, and decide the rest themselves.
        </p>
        <p class="info-description">
          Each round, every model has a job: one plans, one builds, one looks for how it could fail, one decides what stays, and one explains what happened. The jobs rotate, so in every block of five rounds each model plays each job once.
        </p>
        <p class="info-description">
          What they agree on becomes their agent specification, drawn as the plant. They also write real code: changes go as pull requests to the AI-Agent repository, and only the ones that pass its tests are merged.
        </p>
        <p class="info-description">
          They have a memory. Everything they proposed, challenged and decided is kept in a knowledge graph, and they can ask it questions before they act. Open the knowledge graph to search it yourself, or to watch them recall.
        </p>
        <p class="info-description">
          When switched on, they can also use tools: a cloud computer to run commands, short GPU jobs, public model weights, a live model run by the lab, and fine-tuning small models of their own. Each tool comes with limits and a budget, never with a goal.
        </p>
        <p class="info-description">
          Beside them runs a second loop of machine learning research: the models take turns trying to improve a tiny language model that trains for five minutes, and every result goes to the Research-Lab repository. When the lab's repeat check is switched on, a research result only counts as the best after the lab runs it again and the average of the two printed scores beats the old best by more than the run-to-run spread the lab has measured. Both scores are printed by the models' own code, so a repeat checks luck, not honesty.
        </p>
        <p class="info-description">
          The stored record is the evidence. A score printed by the models' own code is marked unverified; a score the lab measured itself says so. When the lab itself changes during the run, the change is logged in the project's README.
        </p>
        <p class="info-description">
          What it asks: do the models come to agree or drift apart? Whose values win when they disagree? Can you predict what they will do next?
        </p>
        <p class="info-description">
          As the record grows (rounds, merged code, passing tests), the plant breaks out of its dome and slowly takes over the room. With no experiment connected, the room plays a local simulation instead: its desk terminals show placeholder activity, and no model, build or commit is behind it.
        </p>
        <p class="info-description">
          The practice bench by the compute corner draws the lab's reinforcement learning runs from the stored record: a pen charts the reward of each step, a jar stands for each answer, and the held-out scores are measured by the lab. Click it for the record. It rests when nothing is running.
          <br>
          <button type="button" class="info-bench-button" id="info-bench-button">${this.benchFocused ? 'Back to the room' : 'Look at the bench'}</button>
        </p>
        <p class="info-description">
          The framed sheet on the wall above the bench is the skill map of the newest Socratic lesson: a lab model teaches a small model by questions, and the lab counts which answers pass. Its small amber lamp is lit only while the stored record says the lesson is running. The same record, in text you can read, is in the lesson.
          <br>
          <button type="button" class="info-bench-button" id="info-lesson-button">Open the Lesson</button>
        </p>
        <p class="info-description">
          Click a scientist to see their current role.
        </p>
        <div class="info-seed">
          <div class="info-seed-label">
            <span>🌱</span>
            <span>Seed Purpose</span>
          </div>
          <div class="info-seed-purpose" id="seed-purpose-text">"${this.escapeHtml(this.seedPurpose)}"</div>
        </div>

        <div class="info-section">
          <div class="info-section-label">The Roles</div>
          <div class="info-section-content">
            Each epoch, models rotate through five roles:
            <ul class="info-list">
              <li><strong>Planner</strong>: "What direction should we explore next?"</li>
              <li><strong>Executor</strong>: "Here's how that would work"</li>
              <li><strong>Challenger</strong>: "Here's how this could fail"</li>
              <li><strong>Reviewer</strong>: "Approve, reject, or modify"</li>
              <li><strong>Commentator</strong>: "Here's what happened"</li>
              <li><strong>Wildcards</strong>: ${this.escapeHtml(wildcardName('north'))} and ${this.escapeHtml(wildcardName('glm'))}, a coding pair that works outside the rotation</li>
            </ul>
            <p class="info-note">Every 5 epochs, each of the five models has played each rotating role exactly once. ${this.escapeHtml(wildcardName('north'))} and ${this.escapeHtml(wildcardName('glm'))} always hold the Wildcard role; they never rotate. Labels show roles from the last completed epoch and update when each new epoch finishes.</p>
          </div>
        </div>

        <div class="info-section">
          <div class="info-section-label">The Plant</div>
          <div class="info-section-content">
            <ul class="info-list compact">
              <li><strong>Branches</strong> = capabilities</li>
              <li><strong>Roots</strong> = constraints</li>
              <li><strong>Leaves</strong> = behaviors</li>
              <li><strong>Wilting</strong> = conflict</li>
              <li><strong>Posture</strong> = stability</li>
              <li><strong>Spreading past the glass</strong> = the record growing</li>
            </ul>
          </div>
        </div>
      </div>
    `

    // Add click handler for toggle
    const toggle = this.infoPanelElement.querySelector('#info-about-toggle')
    toggle?.addEventListener('click', () => this.toggleInfoPanel())
    this.infoPanelElement.querySelector('#info-bench-button')?.addEventListener('click', () => this.onBenchButton())
    this.infoPanelElement.querySelector('#info-lesson-button')?.addEventListener('click', () => this.onOpenLesson?.())
  }

  /** Opens the lesson panel: the DOM way to the skill map's record, for keyboard and touch. Set by main.ts. */
  public onOpenLesson: (() => void) | null = null

  /** Sets the view the "Look at the bench" button flies the camera to. */
  public setBenchView(view: { position: [number, number, number]; target: [number, number, number] }): void {
    this.benchView = view
  }

  private onBenchButton(): void {
    if (this.benchFocused) {
      this.resetCameraView()
      return
    }
    if (!this.benchView || this.isAnimating) return
    const { position, target } = this.benchView
    this.focusedScientist = null
    this.labels.forEach(label => label.classList.remove('focused'))
    this.isAnimating = true
    this.benchFocused = true
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true
    const duration = reduced ? 0.01 : 1.2
    gsap.to(this.camera.position, { x: position[0], y: position[1], z: position[2], duration, ease: 'power2.inOut' })
    gsap.to(this.controls.target, {
      x: target[0], y: target[1], z: target[2], duration, ease: 'power2.inOut',
      onComplete: () => { this.isAnimating = false },
    })
    this.renderInfoPanel()
  }

  private toggleInfoPanel(): void {
    this.isInfoExpanded = !this.isInfoExpanded
    localStorage.setItem('observableLab_infoExpanded', String(this.isInfoExpanded))

    const toggle = this.infoPanelElement?.querySelector('#info-about-toggle')
    const content = this.infoPanelElement?.querySelector('#info-about-content')

    if (toggle && content) {
      toggle.setAttribute('aria-expanded', this.isInfoExpanded ? 'true' : 'false')
      if (this.isInfoExpanded) {
        toggle.classList.add('expanded')
        content.classList.add('expanded')
      } else {
        toggle.classList.remove('expanded')
        content.classList.remove('expanded')
      }
    }
  }

  private getHealthDotsHTML(): string {
    // Calculate filled dots based on stability score
    // 5 filled = > 0.8, 4 = 0.6-0.8, 3 = 0.4-0.6, 2 = 0.2-0.4, 1 = < 0.2
    let filledCount: number
    if (this.stabilityScore > 0.8) filledCount = 5
    else if (this.stabilityScore > 0.6) filledCount = 4
    else if (this.stabilityScore > 0.4) filledCount = 3
    else if (this.stabilityScore > 0.2) filledCount = 2
    else filledCount = 1

    // Determine color based on stability
    let color: string
    if (this.stabilityScore > 0.6) {
      color = 'var(--paper-ok)'
    } else if (this.stabilityScore > 0.3) {
      color = 'var(--paper-working)'
    } else {
      color = 'var(--paper-blocked)'
    }

    let dots = ''
    for (let i = 0; i < 5; i++) {
      if (i < filledCount) {
        dots += `<div class="health-dot filled" style="background: ${color}; color: ${color};"></div>`
      } else {
        dots += `<div class="health-dot empty"></div>`
      }
    }
    return dots
  }

  // Public method to update from API state
  /** Show or hide the "Simulation" marker in the info panel. */
  public setSimulationMode(on: boolean): void {
    if (this.simulationMode === on) return
    this.simulationMode = on
    this.renderInfoPanel()
  }

  public updateExperimentState(epoch: number, stabilityScore: number, seedPurpose?: string): void {
    const epochChanged = this.currentEpoch !== epoch
    const stabilityChanged = Math.abs(this.stabilityScore - stabilityScore) > 0.01
    const purposeChanged = seedPurpose && this.seedPurpose !== seedPurpose

    this.currentEpoch = epoch
    this.stabilityScore = stabilityScore
    if (seedPurpose) {
      this.seedPurpose = seedPurpose
    }

    if (epochChanged || stabilityChanged) {
      // Update just the dynamic parts instead of full re-render
      const epochEl = this.infoPanelElement?.querySelector('.info-epoch')
      const dotsEl = this.infoPanelElement?.querySelector('.health-dots')

      if (epochEl) {
        epochEl.textContent = `Epoch ${epoch}`
      }
      if (dotsEl) {
        dotsEl.innerHTML = this.getHealthDotsHTML()
      }
    }

    if (purposeChanged) {
      const purposeEl = this.infoPanelElement?.querySelector('#seed-purpose-text')
      if (purposeEl) {
        purposeEl.textContent = `"${seedPurpose}"`
      }
    }
  }

  // Set active task for a scientist (shown in label card)
  public setScientistTask(scientist: Scientist, task: string): void {
    this.scientistTasks.set(scientist, task)
    this.updateLabelTask(scientist)
  }

  // Clear active task for a scientist
  public clearScientistTask(scientist: Scientist): void {
    this.scientistTasks.delete(scientist)
    this.updateLabelTask(scientist)
  }

  // Update the task display in a scientist's label
  private updateLabelTask(scientist: Scientist): void {
    const label = this.labels.get(scientist)
    if (!label) return

    const statusEl = label.querySelector('.label-status') as HTMLElement
    if (!statusEl) return

    const task = this.scientistTasks.get(scientist)
    if (task) {
      statusEl.textContent = task
      statusEl.classList.add('active')
    } else {
      statusEl.textContent = ''
      statusEl.classList.remove('active')
    }
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }

  private createLabels(): void {
    this.scientists.forEach((scientist) => {
      const modelId = scientist.getModelId()
      const role = scientist.getRole()
      const color = MODEL_COLORS_HEX[modelId]

      const label = document.createElement('div')
      label.className = 'scientist-label'
      label.style.setProperty('--accent-color', color)
      label.innerHTML = `
        <div class="label-card">
          <div class="label-indicator"></div>
          <div class="label-name">${this.escapeHtml(shortName(panelName(modelId)))}</div>
          <div class="label-role">${ROLE_INFO[role].title}</div>
          <div class="label-status">Idle</div>
          <button class="jspace-btn" title="Jacobian-lens readout: what this researcher is about to say, before they say it">J-space</button>
        </div>
      `

      label.addEventListener('mouseenter', () => this.onLabelHover(scientist, label))
      label.addEventListener('mouseleave', () => this.onLabelLeave())
      label.addEventListener('click', () => this.onLabelClick(scientist))

      // J-space lens toggle — one scientist at a time; main.ts owns the lens.
      const jbtn = label.querySelector('.jspace-btn') as HTMLButtonElement
      jbtn.addEventListener('click', (e) => {
        e.stopPropagation()
        const nowActive = this.onJSpaceToggle?.(scientist) ?? false
        this.labelsContainer.querySelectorAll('.jspace-btn.active').forEach(b => b.classList.remove('active'))
        this.labelsContainer.querySelectorAll('.scientist-label.jspace-dimmed').forEach(l => l.classList.remove('jspace-dimmed'))
        if (nowActive) {
          jbtn.classList.add('active')
          label.classList.add('jspace-dimmed')
        }
      })

      this.labelsContainer.appendChild(label)
      this.labels.set(scientist, label)
    })
  }

  private onLabelHover(scientist: Scientist, label: HTMLElement): void {
    this._hoveredScientist = scientist
    const modelId = scientist.getModelId()
    const role = scientist.getRole()
    const roleInfo = ROLE_INFO[role]
    const color = MODEL_COLORS_HEX[modelId]

    this.tooltipElement.innerHTML = `
      <div class="tooltip-header">
        <div class="tooltip-avatar provider-logo"><img src="${MODEL_PROVIDER_LOGOS[modelId]}" alt="${MODEL_PROVIDER_NAMES[modelId]} logo" width="22" height="22"></div>
        <div class="tooltip-title">
          <div class="tooltip-name">${this.escapeHtml(panelName(modelId))}</div>
          <div class="tooltip-provider">${this.escapeHtml(MODEL_PROVIDER_NAMES[modelId])} · ${this.escapeHtml(modelSlug(panelModelId(modelId)))}</div>
        </div>
      </div>
      <div class="tooltip-section">
        <div class="tooltip-section-title">Current Role</div>
        <div class="tooltip-section-content">
          <span class="tooltip-role-badge" style="--accent-color: ${color};">
            ${roleInfo.title}
          </span>
        </div>
      </div>
      <div class="tooltip-section">
        <div class="tooltip-section-title">Role Description</div>
        <div class="tooltip-section-content">${roleInfo.description}</div>
      </div>
      <div class="tooltip-section">
        <div class="tooltip-section-title">Personality</div>
        <div class="tooltip-section-content">${MODEL_PERSONALITY[modelId]}</div>
      </div>
    `

    // Position tooltip near label
    const rect = label.getBoundingClientRect()
    this.tooltipElement.style.left = `${rect.right + 10}px`
    this.tooltipElement.style.top = `${rect.top}px`

    // Keep tooltip on screen
    const tooltipRect = this.tooltipElement.getBoundingClientRect()
    if (tooltipRect.right > window.innerWidth) {
      this.tooltipElement.style.left = `${rect.left - tooltipRect.width - 10}px`
    }
    if (tooltipRect.bottom > window.innerHeight) {
      this.tooltipElement.style.top = `${window.innerHeight - tooltipRect.height - 10}px`
    }

    this.tooltipElement.classList.add('visible')
  }

  private onLabelLeave(): void {
    this._hoveredScientist = null
    this.tooltipElement.classList.remove('visible')
  }

  private onLabelClick(scientist: Scientist): void {
    // If already focused on this scientist, reset to default view
    if (this.focusedScientist === scientist) {
      this.resetCameraView()
      return
    }

    // Don't start new animation if one is in progress
    if (this.isAnimating) return

    this.focusedScientist = scientist
    if (this.benchFocused) {
      this.benchFocused = false
      this.renderInfoPanel()
    }
    this.isAnimating = true

    // Get scientist position
    const scientistPos = new THREE.Vector3()
    scientist.group.getWorldPosition(scientistPos)

    // Calculate camera position - orbit to face the scientist
    const angle = Math.atan2(scientistPos.x, scientistPos.z)
    const distance = 6
    const height = 3

    const newCameraPos = new THREE.Vector3(
      Math.sin(angle) * distance,
      height,
      Math.cos(angle) * distance
    )

    // Target slightly above the scientist
    const newTarget = scientistPos.clone()
    newTarget.y = 1.2

    // Animate camera position
    gsap.to(this.camera.position, {
      x: newCameraPos.x,
      y: newCameraPos.y,
      z: newCameraPos.z,
      duration: 1.2,
      ease: 'power2.inOut',
    })

    // Animate controls target
    gsap.to(this.controls.target, {
      x: newTarget.x,
      y: newTarget.y,
      z: newTarget.z,
      duration: 1.2,
      ease: 'power2.inOut',
      onComplete: () => {
        this.isAnimating = false
      },
    })

    // Update focused label style
    this.updateFocusedLabel(scientist)
  }

  private resetCameraView(): void {
    if (this.isAnimating) return

    this.isAnimating = true
    this.focusedScientist = null
    if (this.benchFocused) {
      this.benchFocused = false
      this.renderInfoPanel()
    }

    // Animate back to default view
    gsap.to(this.camera.position, {
      x: 8,
      y: 5,
      z: 8,
      duration: 1.2,
      ease: 'power2.inOut',
    })

    gsap.to(this.controls.target, {
      x: 0,
      y: 1,
      z: 0,
      duration: 1.2,
      ease: 'power2.inOut',
      onComplete: () => {
        this.isAnimating = false
      },
    })

    // Clear all focused label styles
    this.labels.forEach((label) => {
      label.classList.remove('focused')
    })
  }

  private updateFocusedLabel(scientist: Scientist): void {
    // Remove focus from all labels
    this.labels.forEach((label) => {
      label.classList.remove('focused')
    })

    // Add focus to selected label
    const label = this.labels.get(scientist)
    if (label) {
      label.classList.add('focused')
    }
  }

  public update(): void {
    this.scientists.forEach((scientist) => {
      const label = this.labels.get(scientist)
      if (!label) return

      // Get scientist head position in world space
      const position = new THREE.Vector3()
      scientist.group.getWorldPosition(position)
      position.y += 2.0 // Above head

      // Convert to screen space
      const screenPos = position.clone().project(this.camera)

      // Check if in front of camera
      if (screenPos.z > 1) {
        label.style.opacity = '0'
        return
      }

      // Convert to CSS coordinates
      const x = (screenPos.x * 0.5 + 0.5) * window.innerWidth
      const y = (-screenPos.y * 0.5 + 0.5) * window.innerHeight

      label.style.left = `${x}px`
      label.style.top = `${y}px`
      // inline opacity would defeat the .jspace-dimmed class — let CSS own it
      // while a lens is up on this scientist
      label.style.opacity = label.classList.contains('jspace-dimmed') ? '' : '1'

      // Update status - only if no active task (task takes priority)
      const statusEl = label.querySelector('.label-status') as HTMLElement
      if (statusEl && !this.scientistTasks.has(scientist)) {
        // No active task - status remains hidden (controlled by CSS)
      }

      // Update role if changed
      const roleEl = label.querySelector('.label-role') as HTMLElement
      if (roleEl) {
        roleEl.textContent = ROLE_INFO[scientist.getRole()].title
      }
    })


    // Update North's nameplate position (same projection as scientists)
    if (this.robotLabel && this.robotGroup) {
      const position = new THREE.Vector3()
      this.robotGroup.getWorldPosition(position)
      position.y += 0.75 // above the small robot
      const screenPos = position.clone().project(this.camera)
      if (screenPos.z > 1) {
        this.robotLabel.style.opacity = '0'
      } else {
        this.robotLabel.style.left = `${(screenPos.x * 0.5 + 0.5) * window.innerWidth}px`
        this.robotLabel.style.top = `${(-screenPos.y * 0.5 + 0.5) * window.innerHeight}px`
        this.robotLabel.style.opacity = '1'
      }
    }

    // Update GLM's nameplate position
    if (this.glmLabel) {
      const position = new THREE.Vector3()
      this.glmLabel.target.getWorldPosition(position)
      position.y += 0.4 // just above the hovering ship's hull
      const sp = position.clone().project(this.camera)
      if (sp.z > 1) {
        this.glmLabel.el.style.opacity = '0'
      } else {
        this.glmLabel.el.style.left = `${(sp.x * 0.5 + 0.5) * window.innerWidth}px`
        this.glmLabel.el.style.top = `${(-sp.y * 0.5 + 0.5) * window.innerHeight}px`
        this.glmLabel.el.style.opacity = '1'
      }
    }

    // Update subagent drone labels (project their moving positions)
    for (const { el, target } of this.droneLabels) {
      const position = new THREE.Vector3()
      target.getWorldPosition(position)
      position.y += 0.32
      const sp = position.clone().project(this.camera)
      if (sp.z > 1) {
        el.style.opacity = '0'
        continue
      }
      el.style.left = `${(sp.x * 0.5 + 0.5) * window.innerWidth}px`
      el.style.top = `${(-sp.y * 0.5 + 0.5) * window.innerHeight}px`
      el.style.opacity = '1'
    }

    // Live-refresh the hovered subagent's task card (follows the moving label)
    if (this.hoveredDroneTip) {
      this.renderDroneTooltip(this.hoveredDroneTip.label, this.hoveredDroneTip.getInfo, this.hoveredDroneTip.accent)
    }

    // Update whiteboard overlay position
    this.updateWhiteboardPosition()

    // Update robot status card position
    this.updateRobotStatusPosition()

    // Update agent speech bubble position
    this.updateAgentSpeechPosition()
  }

  private updateRobotStatusPosition(): void {
    if (!this.robotStatusCard || !this.robotGroup) return
    if (!this.robotStatusCard.classList.contains('visible')) return

    // Get robot position in world space
    const position = new THREE.Vector3()
    this.robotGroup.getWorldPosition(position)
    position.y += 1.2 // Above robot's head

    // Convert to screen space
    const screenPos = position.clone().project(this.camera)

    // Check if in front of camera
    if (screenPos.z > 1) {
      this.robotStatusCard.style.opacity = '0'
      return
    }

    // Convert to CSS coordinates
    const x = (screenPos.x * 0.5 + 0.5) * window.innerWidth
    const y = (-screenPos.y * 0.5 + 0.5) * window.innerHeight

    this.robotStatusCard.style.left = `${x}px`
    this.robotStatusCard.style.top = `${y}px`
  }

  private updateWhiteboardPosition(): void {
    if (!this.whiteboardElement || this.whiteboardNotes.length === 0) return

    // Whiteboard position in world space (right side of planner's whiteboard)
    // Planner station is at (0, 0, -5.5), whiteboard is at relative (0.3, 1.7, -0.52)
    const whiteboardPos = new THREE.Vector3(0.3, 1.7, -6.02)

    // Convert to screen space
    const screenPos = whiteboardPos.clone().project(this.camera)

    // Check if in front of camera
    if (screenPos.z > 1) {
      this.whiteboardElement.classList.add('hidden')
      return
    }

    // Convert to CSS coordinates
    const x = (screenPos.x * 0.5 + 0.5) * window.innerWidth
    const y = (-screenPos.y * 0.5 + 0.5) * window.innerHeight

    this.whiteboardElement.style.left = `${x}px`
    this.whiteboardElement.style.top = `${y}px`
    this.whiteboardElement.classList.remove('hidden')

    // Scale based on distance (optional, for depth effect)
    // Align to right side of whiteboard so it doesn't block sticky notes
    const distance = this.camera.position.distanceTo(whiteboardPos)
    const scale = Math.max(0.5, Math.min(1.2, 8 / distance))
    this.whiteboardElement.style.transform = `translate(0%, -50%) scale(${scale})`
  }

  public getHoveredScientist(): Scientist | null {
    return this._hoveredScientist
  }

  public dispose(): void {
    this.container.remove()
  }
}

