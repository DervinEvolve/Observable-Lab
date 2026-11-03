import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import gsap from 'gsap'
import { Scientist, ModelId } from '../entities/Scientist'
import { StationRole } from '../scene/colors'
import { MODEL_PROVIDER_NAMES } from '../shared/types'

// Model display info
const MODEL_INFO: Record<ModelId, { name: string; personality: string }> = {
  gemini: { name: 'Gemini 3.5 Flash', personality: 'Exploratory, multimodal' },
  deepseek: { name: 'DeepSeek-V4', personality: 'Methodical, structured' },
  claude: { name: 'Claude Opus 4.8', personality: 'Safety-conscious, nuanced' },
  gpt: { name: 'GPT-5.5', personality: 'Agentic, general-purpose' },
  grok: { name: 'Grok 4.3', personality: 'Edgy, adversarial' },
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
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
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
          background: rgba(255, 255, 255, 0.95);
          box-shadow: 0 4px 16px rgba(0,0,0,0.12);
        }

        .scientist-label.focused {
          transform: translate(-50%, -100%) scale(1.12);
          z-index: 10;
        }

        .scientist-label.focused .label-card {
          background: rgba(255, 255, 255, 0.98);
          box-shadow: 0 4px 20px rgba(0,0,0,0.15), 0 0 0 2px var(--accent-color);
        }

        .scientist-label.focused .label-indicator {
          animation: focusPulse 1s ease-in-out infinite;
        }

        @keyframes focusPulse {
          0%, 100% { transform: scale(1); box-shadow: 0 0 8px var(--accent-color); }
          50% { transform: scale(1.4); box-shadow: 0 0 12px var(--accent-color); }
        }

        .label-card {
          background: rgba(255, 255, 255, 0.75);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          border-radius: 16px;
          padding: 4px 10px 5px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.08);
          border: 1px solid rgba(255,255,255,0.5);
          text-align: center;
          min-width: 56px;
        }

        .label-name {
          font-weight: 600;
          font-size: 10px;
          color: #1a1a1a;
          letter-spacing: -0.2px;
          white-space: nowrap;
        }

        .label-role {
          font-size: 7px;
          color: var(--accent-color);
          text-transform: uppercase;
          letter-spacing: 0.8px;
          font-weight: 500;
          opacity: 0.9;
        }

        .label-status {
          font-size: 6px;
          color: #666;
          margin-top: 2px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 80px;
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
          box-shadow: 0 0 6px var(--accent-color);
          animation: pulse 2.5s ease-in-out infinite;
        }

        .label-indicator.blink {
          animation: subagentBlink 1.1s steps(1) infinite;
        }
        @keyframes subagentBlink { 0%, 100% { opacity: 1; } 50% { opacity: 0.12; } }

        .jspace-btn {
          display: block;
          margin: 4px auto 0;
          padding: 2px 8px;
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.4px;
          font-family: 'SF Mono', 'Courier New', monospace;
          color: var(--accent-color);
          background: transparent;
          border: 1px solid var(--accent-color);
          border-radius: 999px;
          cursor: pointer;
          opacity: 0.75;
          transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease;
          pointer-events: auto;
        }
        .scientist-label:hover .jspace-btn,
        .jspace-btn:hover,
        .jspace-btn.active {
          opacity: 1;
        }
        .jspace-btn.active {
          background: var(--accent-color);
          color: #fff;
        }

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

        @keyframes pulse {
          0%, 100% { opacity: 1; box-shadow: 0 0 6px var(--accent-color); }
          50% { opacity: 0.6; box-shadow: 0 0 10px var(--accent-color); }
        }

        #tooltip {
          position: absolute;
          background: rgba(20, 20, 20, 0.88);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          color: #f5f2eb;
          padding: 14px;
          border-radius: 14px;
          max-width: 220px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.25);
          border: 1px solid rgba(255,255,255,0.08);
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
          border-bottom: 1px solid rgba(255,255,255,0.08);
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

        /* Plain provider name in the avatar slot; no provider logos are shipped. */
        .tooltip-avatar.provider-name {
          width: auto;
          min-width: 32px;
          padding: 0 8px;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.2px;
          white-space: nowrap;
          box-sizing: border-box;
        }

        .tooltip-title {
          flex: 1;
        }

        .tooltip-name {
          font-weight: 600;
          font-size: 12px;
          margin-bottom: 1px;
        }

        .tooltip-provider {
          font-size: 9px;
          opacity: 0.5;
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
          font-size: 8px;
          text-transform: uppercase;
          letter-spacing: 0.8px;
          opacity: 0.4;
          margin-bottom: 3px;
        }

        .tooltip-section-content {
          font-size: 10px;
          line-height: 1.4;
          opacity: 0.9;
        }

        .tooltip-role-badge {
          display: inline-block;
          padding: 3px 8px;
          border-radius: 6px;
          font-size: 9px;
          font-weight: 600;
        }

        #experiment-info {
          position: fixed;
          top: 16px;
          left: 16px;
          background: rgba(255, 255, 255, 0.85);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          padding: 14px 16px;
          border-radius: 14px;
          box-shadow: 0 2px 16px rgba(0,0,0,0.08);
          border: 1px solid rgba(255,255,255,0.6);
          pointer-events: auto;
          max-width: 260px;
          overflow: hidden;
        }

        #github-link {
          position: fixed;
          bottom: 20px;
          left: 20px;
          width: 44px;
          height: 44px;
          border-radius: 50%;
          background: rgba(255, 255, 255, 0.9);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          border: 1px solid rgba(0, 0, 0, 0.1);
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
          transition: all 0.2s ease;
          pointer-events: auto;
          z-index: 150;
          text-decoration: none;
        }

        #github-link:hover {
          transform: scale(1.05);
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
        }

        #github-link svg {
          width: 22px;
          height: 22px;
          opacity: 0.75;
        }

        #github-commit-badge {
          position: absolute;
          top: -5px;
          right: -5px;
          min-width: 18px;
          height: 18px;
          padding: 0 4px;
          border-radius: 9px;
          background: #2ea043;
          color: #fff;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          font-size: 10px;
          font-weight: 700;
          line-height: 18px;
          text-align: center;
          box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
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
          background: rgba(255, 255, 255, 0.94);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          border: 1px solid rgba(0, 0, 0, 0.08);
          border-radius: 14px;
          box-shadow: 0 8px 30px rgba(0, 0, 0, 0.18);
          padding: 12px 14px;
          z-index: 300;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          pointer-events: auto;
          opacity: 0;
          transform: translateY(6px) scale(0.96);
          transition: opacity 0.18s ease, transform 0.22s cubic-bezier(0.2, 1.4, 0.4, 1);
        }
        #inspector-card.show { opacity: 1; transform: translateY(0) scale(1); }
        #inspector-card .insp-title {
          font-size: 13px; font-weight: 700; color: #1a1a1a;
          margin: 0 18px 2px 0; letter-spacing: 0.2px;
        }
        #inspector-card .insp-sub {
          font-size: 10px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase;
          color: rgba(0,0,0,0.4); margin-bottom: 8px;
        }
        #inspector-card .insp-row {
          display: flex; justify-content: space-between; gap: 12px;
          font-size: 11.5px; line-height: 1.7; color: #333;
        }
        #inspector-card .insp-row b { font-weight: 600; color: #111; text-align: right; }
        #inspector-card .insp-body {
          font-size: 11.5px; line-height: 1.55; color: #333; margin-top: 2px;
        }
        #inspector-card .insp-body ul { margin: 4px 0 0 14px; padding: 0; }
        #inspector-card a {
          color: #2ea043; font-weight: 600; text-decoration: none; font-size: 11.5px;
        }
        #inspector-card a:hover { text-decoration: underline; }
        #inspector-card .insp-close {
          position: absolute; top: 8px; right: 10px; cursor: pointer;
          font-size: 13px; color: rgba(0,0,0,0.35); border: none; background: none; padding: 2px;
        }
        #inspector-card .insp-close:hover { color: rgba(0,0,0,0.7); }

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
          background: rgba(255, 255, 255, 0.85);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          border: 1px solid rgba(255,255,255,0.6);
          border-radius: 14px;
          box-shadow: 0 2px 16px rgba(0,0,0,0.08);
          font-family: 'Inter', -apple-system, sans-serif;
          font-size: 12px;
          color: #1a1a1a;
          opacity: 0;
          transition: opacity 0.3s ease, transform 0.3s ease;
          pointer-events: auto;
          z-index: 160;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        #live-status.visible { opacity: 1; transform: translateX(-50%) translateY(0); }
        #live-status .live-role { font-weight: 700; flex-shrink: 0; letter-spacing: -0.1px; }
        #live-status .live-close {
          flex-shrink: 0; margin-left: 4px; border: none; background: none; cursor: pointer;
          color: rgba(0,0,0,0.35); font-size: 15px; line-height: 1; padding: 0 2px;
          transition: color 0.15s ease;
        }
        #live-status .live-close:hover { color: rgba(0,0,0,0.7); }
        #live-status .live-remark { color: rgba(0,0,0,0.6); overflow: hidden; text-overflow: ellipsis; }
        #live-status .live-caret {
          display: inline-block; width: 1px; height: 12px; margin-left: 1px;
          background: rgba(0,0,0,0.55); vertical-align: -1px;
          animation: liveCaret 0.9s step-end infinite;
        }
        @keyframes liveCaret { 50% { opacity: 0; } }



        .info-header {
          margin-bottom: 10px;
        }

        .info-title {
          font-size: 15px;
          font-weight: 700;
          color: #1a1a1a;
          margin: 0 0 2px 0;
          letter-spacing: -0.3px;
        }

        .info-subtitle {
          font-size: 10px;
          color: #888;
          margin: 0;
          letter-spacing: 0.2px;
        }

        .info-simulation {
          display: inline-block;
          margin: 0 0 8px;
          padding: 2px 8px;
          border-radius: 4px;
          background: rgba(229, 115, 115, 0.15);
          color: #a33a3a;
          font-size: 10.5px;
          font-weight: 600;
          letter-spacing: 0.2px;
        }

        .info-stats {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 10px;
          font-size: 11px;
          color: #555;
        }

        .info-epoch {
          font-weight: 600;
          color: #333;
        }

        .info-health {
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .info-health-label {
          color: #666;
        }

        .health-dots {
          display: flex;
          gap: 3px;
        }

        .health-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          transition: background-color 0.3s ease;
        }

        .health-dot.filled {
          box-shadow: 0 0 4px currentColor;
        }

        .health-dot.empty {
          background: rgba(0,0,0,0.12);
        }

        .info-toggle {
          display: flex;
          align-items: center;
          gap: 6px;
          cursor: pointer;
          font-size: 11px;
          color: #666;
          padding: 4px 0;
          transition: color 0.15s ease;
          user-select: none;
        }

        .info-toggle:hover {
          color: #333;
        }

        .info-toggle-arrow {
          font-size: 8px;
          transition: transform 0.2s ease;
        }

        .info-toggle.expanded .info-toggle-arrow {
          transform: rotate(180deg);
        }

        .info-content {
          max-height: 0;
          overflow: hidden;
          transition: max-height 0.2s ease-out, opacity 0.15s ease;
          opacity: 0;
        }

        .info-content.expanded {
          max-height: 70vh;
          overflow-y: auto;
          opacity: 1;
          transition: max-height 0.2s ease-in, opacity 0.2s ease 0.05s;
        }

        .info-divider {
          height: 1px;
          background: rgba(0,0,0,0.08);
          margin: 10px 0;
        }

        .info-description {
          font-size: 11px;
          color: #555;
          line-height: 1.55;
          margin: 0;
        }

        .info-description + .info-description {
          margin-top: 10px;
        }

        .info-seed {
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px solid rgba(0,0,0,0.08);
        }

        .info-seed-label {
          font-size: 9px;
          color: #888;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 4px;
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .info-seed-purpose {
          font-size: 12px;
          color: #333;
          font-style: italic;
          line-height: 1.4;
        }

        .info-section {
          margin-top: 12px;
          padding-top: 10px;
          border-top: 1px solid rgba(0,0,0,0.1);
        }

        .info-section-label {
          font-size: 10px;
          color: #666;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 6px;
          font-weight: 600;
        }

        .info-section-content {
          font-size: 11px;
          color: #444;
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
          color: #333;
        }

        .info-note {
          font-size: 10px;
          color: #666;
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
          background: rgba(20, 20, 20, 0.9);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          border-radius: 12px;
          padding: 8px 14px;
          box-shadow: 0 4px 16px rgba(0,0,0,0.3);
          border: 1px solid rgba(255,255,255,0.1);
          display: flex;
          align-items: center;
          gap: 8px;
          white-space: nowrap;
        }

        .robot-status-icon {
          font-size: 14px;
        }

        .robot-status-text {
          font-size: 11px;
          font-weight: 600;
          color: #fff;
          letter-spacing: 0.3px;
        }

        .robot-status-content.success {
          border-color: rgba(79, 195, 247, 0.5);
          box-shadow: 0 4px 16px rgba(79, 195, 247, 0.2);
        }

        .robot-status-content.error {
          border-color: rgba(229, 115, 115, 0.5);
          box-shadow: 0 4px 16px rgba(229, 115, 115, 0.2);
        }

        .robot-status-content.working {
          border-color: rgba(255, 183, 77, 0.5);
          box-shadow: 0 4px 16px rgba(255, 183, 77, 0.2);
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
          background: linear-gradient(135deg, rgba(40, 35, 25, 0.95), rgba(30, 25, 20, 0.95));
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          border-radius: 16px;
          padding: 14px 18px;
          box-shadow: 0 8px 32px rgba(255, 215, 0, 0.15), 0 0 60px rgba(255, 215, 0, 0.1);
          border: 1px solid rgba(255, 215, 0, 0.3);
          position: relative;
        }

        .agent-speech-content::after {
          content: '';
          position: absolute;
          bottom: -10px;
          left: 50%;
          transform: translateX(-50%);
          border-width: 10px 10px 0 10px;
          border-style: solid;
          border-color: rgba(30, 25, 20, 0.95) transparent transparent transparent;
        }

        .agent-speech-header {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;
          padding-bottom: 8px;
          border-bottom: 1px solid rgba(255, 215, 0, 0.2);
        }

        .agent-speech-name {
          font-size: 12px;
          font-weight: 700;
          color: #ffd700;
          letter-spacing: 0.5px;
          text-transform: uppercase;
        }

        .agent-speech-indicator {
          width: 8px;
          height: 8px;
          background: #ffd700;
          border-radius: 50%;
          animation: agent-pulse 2s ease-in-out infinite;
        }

        @keyframes agent-pulse {
          0%, 100% { opacity: 0.5; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.2); }
        }

        .agent-speech-text {
          font-size: 13px;
          color: #f5f5dc;
          line-height: 1.5;
          font-style: italic;
        }

        .agent-speech-close {
          position: absolute;
          top: 8px;
          right: 10px;
          background: none;
          border: none;
          color: rgba(255, 215, 0, 0.5);
          cursor: pointer;
          font-size: 16px;
          padding: 4px;
          line-height: 1;
        }

        .agent-speech-close:hover {
          color: rgba(255, 215, 0, 0.8);
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
        <div class="tooltip-avatar" style="background:${accent};display:flex;align-items:center;justify-content:center;color:#06231f;font-weight:700;">⬡</div>
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
        <div class="label-name">GLM</div>
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
        <div class="tooltip-avatar provider-name" style="background: ${accent}20; color: ${accent};">Z.ai</div>
        <div class="tooltip-title">
          <div class="tooltip-name">GLM</div>
          <div class="tooltip-provider">glm-5.2</div>
        </div>
      </div>
      <div class="tooltip-section">
        <div class="tooltip-section-title">Current Role</div>
        <div class="tooltip-section-content">
          <span class="tooltip-role-badge" style="background: ${accent}20; color: ${accent};">Wildcard · R&amp;D</span>
        </div>
      </div>
      <div class="tooltip-section">
        <div class="tooltip-section-title">Role Description</div>
        <div class="tooltip-section-content">Autonomous R&amp;D agent. Runs its own coding experiments in a sandbox on its own branch — accepted work merges to main.</div>
      </div>
      <div class="tooltip-section">
        <div class="tooltip-section-title">Working with</div>
        <div class="tooltip-section-content">North</div>
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
        <div class="tooltip-avatar provider-name" style="background: ${accent}20; color: ${accent};">Cohere</div>
        <div class="tooltip-title">
          <div class="tooltip-name">North</div>
          <div class="tooltip-provider">north-mini-code</div>
        </div>
      </div>
      <div class="tooltip-section">
        <div class="tooltip-section-title">Current Role</div>
        <div class="tooltip-section-content">
          <span class="tooltip-role-badge" style="background: ${accent}20; color: ${accent};">Wildcard · R&amp;D</span>
        </div>
      </div>
      <div class="tooltip-section">
        <div class="tooltip-section-title">Role Description</div>
        <div class="tooltip-section-content">Autonomous R&amp;D agent. Runs its own coding experiments in a sandbox on its own branch — accepted work sprouts as green leaves.</div>
      </div>
      <div class="tooltip-section">
        <div class="tooltip-section-title">Pairs with</div>
        <div class="tooltip-section-content">GLM — they write code together</div>
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
      <span class="live-role" style="color:${esc(accentHex)}">${esc(role)}</span>
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

  // Link to the AI-Agent repo — where the scientists', wildcards', and
  // subagents' real commits actually land. Private for now; will point at
  // the same URL once the repo goes public.
  private createGithubLink(): void {
    const link = document.createElement('a')
    link.id = 'github-link'
    link.href = 'https://github.com/DervinEvolve/AI-Agent'
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.title = 'View the AI-Agent repo'
    link.innerHTML = `
      <svg viewBox="0 0 16 16" fill="#1a1a1a">
        <path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
      </svg>
      <span id="github-commit-badge"></span>
    `
    this.container.appendChild(link)
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
        <p class="info-subtitle">Hon AI Research, a personal experiment</p>
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
      <div class="info-toggle ${toggleClass}" id="info-about-toggle">
        <span class="info-toggle-arrow">▼</span>
        <span>About</span>
      </div>
      <div class="info-content ${toggleClass}" id="info-about-content">
        <div class="info-divider"></div>
        <p class="info-description">
          Five AI models from different labs collaborate to design an autonomous agent.
        </p>
        <p class="info-description">
          Watch the specification grow as a plant—branches are capabilities, roots are constraints.
        </p>
        <p class="info-description">
          The scene shows stored experiment state and polls for updates.
        </p>
        <p class="info-description">
          With no experiment connected, the room plays a local simulation. Its desk terminals show placeholder activity; no model, build or commit is behind it.
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
              <li><strong>Planner</strong> — "What direction should we explore next?"</li>
              <li><strong>Executor</strong> — "Here's how that would work"</li>
              <li><strong>Challenger</strong> — "Here's how this could fail"</li>
              <li><strong>Reviewer</strong> — "Approve, reject, or modify"</li>
              <li><strong>Commentator</strong> — "Here's what happened"</li>
              <li><strong>Wildcard</strong> — North, an autonomous R&D agent (does not rotate)</li>
            </ul>
            <p class="info-note">Every 5 epochs, each of the five models has played each rotating role exactly once. North always holds the Wildcard role — it never rotates. Labels show roles from the last completed epoch and update when each new epoch finishes.</p>
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
              <li><strong>Growth</strong> = coherence</li>
            </ul>
          </div>
        </div>
      </div>
    `

    // Add click handler for toggle
    const toggle = this.infoPanelElement.querySelector('#info-about-toggle')
    toggle?.addEventListener('click', () => this.toggleInfoPanel())
  }

  private toggleInfoPanel(): void {
    this.isInfoExpanded = !this.isInfoExpanded
    localStorage.setItem('observableLab_infoExpanded', String(this.isInfoExpanded))

    const toggle = this.infoPanelElement?.querySelector('#info-about-toggle')
    const content = this.infoPanelElement?.querySelector('#info-about-content')

    if (toggle && content) {
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
      color = '#7cb342' // green
    } else if (this.stabilityScore > 0.3) {
      color = '#ffb74d' // yellow/orange
    } else {
      color = '#e57373' // red
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
      const info = MODEL_INFO[modelId]
      const color = MODEL_COLORS_HEX[modelId]

      const label = document.createElement('div')
      label.className = 'scientist-label'
      label.style.setProperty('--accent-color', color)
      label.innerHTML = `
        <div class="label-card">
          <div class="label-indicator"></div>
          <div class="label-name">${info.name.split(' ')[0]}</div>
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
    const info = MODEL_INFO[modelId]
    const roleInfo = ROLE_INFO[role]
    const color = MODEL_COLORS_HEX[modelId]

    this.tooltipElement.innerHTML = `
      <div class="tooltip-header">
        <div class="tooltip-avatar provider-name" style="background: ${color}20; color: ${color};">${MODEL_PROVIDER_NAMES[modelId]}</div>
        <div class="tooltip-title">
          <div class="tooltip-name">${info.name}</div>
        </div>
      </div>
      <div class="tooltip-section">
        <div class="tooltip-section-title">Current Role</div>
        <div class="tooltip-section-content">
          <span class="tooltip-role-badge" style="background: ${color}20; color: ${color};">
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
        <div class="tooltip-section-content">${info.personality}</div>
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

