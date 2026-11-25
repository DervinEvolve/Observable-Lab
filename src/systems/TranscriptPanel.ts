import type { Epoch, CommentatorOutput, ChallengerOutput, ReviewerOutput } from '../shared/types'
import { modelDisplayName, BACKEND_TO_FRONTEND_MODEL, MODEL_PROVIDER_NAMES, WILDCARD_ACCENTS, WILDCARD_DISPLAY_NAMES, providerLogoForModel, type ModelId } from '../shared/types'
import { COLORS } from '../scene/colors'
import { installPaperTheme, paperFocusRing, paperShell, paperHeader, paperHeading } from './paperTheme'

// Accent color for a model (matches the scientist/desk accents) so observers can
// track who said what across the conversation.
function modelColorHex(modelId: ModelId): string {
  const fid = BACKEND_TO_FRONTEND_MODEL[modelId]
  const hex = (fid && COLORS.models[fid]) || 0x9aa4ad
  return '#' + hex.toString(16).padStart(6, '0')
}

// The four state colours the room already uses, as CSS variables for the pills,
// rules and dots below. Each is only ever mixed with ink or paper before it
// carries text or an edge, so the word beside it always has the contrast.
const hexOf = (n: number): string => '#' + n.toString(16).padStart(6, '0')
const STATUS_VARS = `:root { --st-healthy: ${hexOf(COLORS.states.healthy)}; --st-working: ${hexOf(COLORS.states.working)}; --st-blocked: ${hexOf(COLORS.states.blocked)}; --st-stable: ${hexOf(COLORS.states.stable)}; }`

interface TranscriptPanelOptions {
  onOpen?: () => void
  onClose?: () => void
}

export class TranscriptPanel {
  private container: HTMLDivElement
  private toggleButton: HTMLButtonElement
  private panel: HTMLDivElement
  private isOpen: boolean = false
  private epochs: Epoch[] = []
  private wildcardTurns: Array<{ id: string; epoch_number: number; speaker: string; model_id: string; text: string }> = []
  private onOpen: (() => void) | null
  private onClose: (() => void) | null

  constructor(options: TranscriptPanelOptions = {}) {
    this.onOpen = options.onOpen || null
    this.onClose = options.onClose || null
    installPaperTheme()

    // Create container
    this.container = document.createElement('div')
    this.container.id = 'transcript-panel-container'
    this.container.innerHTML = `
      <style>
        ${STATUS_VARS}

        #transcript-panel-container {
          position: fixed;
          bottom: 20px;
          right: 20px;
          z-index: 150;
          font-family: var(--paper-sans);
        }
        ${paperFocusRing('#transcript-panel-container')}

        #transcript-toggle {
          width: 44px;
          height: 44px;
          border-radius: 50%;
          background: var(--paper-raised-veil);
          backdrop-filter: blur(8px);
          border: 1px solid var(--paper-line);
          color: var(--paper-ink);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: var(--paper-shadow-soft);
          transition: all 0.2s ease;
        }

        #transcript-toggle:hover {
          transform: scale(1.05);
          box-shadow: var(--paper-shadow-lift);
        }

        #transcript-toggle svg {
          width: 20px;
          height: 20px;
          opacity: 0.8;
        }

        #transcript-panel {
          position: absolute;
          bottom: 56px;
          right: 0;
          width: 340px;
          max-height: 70vh;
          opacity: 0;
          transform: translateY(10px) scale(0.95);
          pointer-events: none;
          transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
          overflow: hidden;
        }
        ${paperShell('#transcript-panel')}

        #transcript-panel.open {
          opacity: 1;
          transform: translateY(0) scale(1);
          pointer-events: auto;
        }

        .panel-header {
          padding: 11px 16px 14px;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        ${paperHeader('#transcript-panel .panel-header')}

        .panel-title { line-height: 1.25; }
        ${paperHeading('#transcript-panel .panel-title', 16)}

        .panel-subtitle {
          color: var(--paper-ink-2);
          font-size: 13px;
          line-height: 1.3;
        }

        .panel-content {
          max-height: calc(70vh - 71px);
          overflow-y: auto;
          padding: 12px;
        }

        .panel-content::-webkit-scrollbar {
          width: 6px;
        }

        .panel-content::-webkit-scrollbar-track {
          background: transparent;
        }

        .panel-content::-webkit-scrollbar-thumb {
          background: var(--paper-line);
          border-radius: 3px;
        }

        .epoch-entry {
          margin-bottom: 16px;
          padding-bottom: 16px;
          border-bottom: 1px solid var(--paper-hair);
        }

        .epoch-entry:last-child {
          border-bottom: none;
          margin-bottom: 0;
          padding-bottom: 0;
        }

        .epoch-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 8px;
        }

        .epoch-header-left {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .epoch-number {
          background: var(--paper-sunk);
          color: var(--paper-ink);
          font-size: 13px;
          font-weight: 600;
          padding: 1px 8px;
          border-radius: 10px;
          letter-spacing: 0.2px;
        }

        .epoch-time {
          color: var(--paper-ink-2);
          font-size: 13px;
        }

        .epoch-mood {
          --st: var(--st-stable);
          background: color-mix(in srgb, var(--st) 22%, var(--paper-raised));
          box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--st) 60%, var(--paper-ink));
          color: var(--paper-ink);
          font-size: 13px;
          font-weight: 600;
          letter-spacing: 0.2px;
          padding: 1px 8px;
          border-radius: 10px;
        }

        .epoch-mood.thriving { --st: var(--st-healthy); }
        .epoch-mood.growing { --st: var(--st-working); }
        .epoch-mood.struggling { --st: var(--st-blocked); }
        .epoch-mood.pruning { --st: color-mix(in srgb, var(--st-working) 45%, var(--st-blocked)); }
        .epoch-mood.stable { --st: var(--st-stable); }

        .epoch-summary {
          color: var(--paper-ink);
          font-size: 13px;
          line-height: 1.6;
          margin-bottom: 8px;
        }

        .epoch-summary.quiet { color: var(--paper-ink-2); }

        .epoch-metaphor {
          color: var(--paper-ink-2);
          font-size: 13px;
          font-style: italic;
          line-height: 1.5;
        }

        .collab {
          font-size: 13px;
          color: var(--paper-ink-2);
          line-height: 1.5;
          margin: 8px 0;
        }

        .collab-name, .wild-name { color: var(--paper-ink); font-weight: 600; }

        .wild { font-size: 13px; line-height: 1.5; margin: 8px 0; }
        .wild-head { color: var(--paper-ink-2); margin-bottom: 2px; }
        .wild-turn {
          margin: 4px 0;
          padding-left: 8px;
          border-left: 2px solid color-mix(in srgb, var(--m) 60%, var(--paper-ink));
        }
        .wild-text { color: var(--paper-ink); }

        .emerged { font-size: 13px; color: var(--paper-ink-2); line-height: 1.5; margin: 6px 0; }

        .transcript-toggle-btn {
          background: transparent;
          border: none;
          color: var(--paper-brass-ink);
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          padding: 6px 0;
          margin-top: 10px;
          transition: color 0.15s;
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .transcript-toggle-btn:hover {
          color: var(--paper-ink);
        }

        .transcript-toggle-btn .toggle-arrow {
          font-size: 13px;
          transition: transform 0.2s ease;
        }

        .transcript-toggle-btn.expanded .toggle-arrow {
          transform: rotate(180deg);
        }

        .full-transcript {
          max-height: 0;
          overflow: hidden;
          transition: max-height 0.25s ease-out, opacity 0.2s ease, margin 0.2s ease;
          opacity: 0;
          margin-top: 0;
          padding: 0 12px;
          background: var(--paper-sunk);
          border-radius: var(--paper-radius-sm);
        }

        .full-transcript.expanded {
          max-height: 350px;
          overflow-y: auto;
          opacity: 1;
          margin-top: 12px;
          padding: 12px;
          transition: max-height 0.3s ease-in, opacity 0.2s ease 0.05s, margin 0.2s ease;
        }

        .full-transcript::-webkit-scrollbar {
          width: 5px;
        }

        .full-transcript::-webkit-scrollbar-track {
          background: transparent;
        }

        .full-transcript::-webkit-scrollbar-thumb {
          background: var(--paper-line);
          border-radius: 3px;
        }

        .full-transcript::-webkit-scrollbar-thumb:hover {
          background: var(--paper-ink);
        }

        /* Group-chat speech bubbles for the per-turn dialogue */
        .chat-msg {
          display: flex;
          align-items: flex-end;
          gap: 8px;
          margin-bottom: 12px;
        }
        .chat-msg:last-child { margin-bottom: 2px; }
        .chat-msg.right { flex-direction: row-reverse; }
        .chat-avatar {
          --m: var(--paper-line);
          height: 26px; min-width: 26px; border-radius: 8px; flex-shrink: 0;
          display: inline-flex; align-items: center; justify-content: center;
          padding: 0 6px; box-sizing: border-box;
          font-size: 13px; font-weight: 700; letter-spacing: 0.2px; white-space: nowrap;
          color: var(--paper-ink);
          background: color-mix(in srgb, var(--m) 22%, var(--paper-raised));
          box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--m) 60%, var(--paper-ink));
        }
        .chat-avatar--logo { width: 28px; padding: 4px; background: var(--paper-white); box-shadow: inset 0 0 0 1px var(--paper-line); }
        .chat-avatar--logo img { width: 100%; height: 100%; object-fit: contain; }
        .chat-bubble {
          max-width: 84%;
          background: var(--paper-white);
          border: 1px solid var(--paper-line);
          border-radius: 14px;
          padding: 8px 11px;
          color: var(--paper-ink);
        }
        .chat-msg.left  .chat-bubble { border-bottom-left-radius: 4px; }
        .chat-msg.right .chat-bubble { border-bottom-right-radius: 4px; }
        .chat-head {
          display: flex; flex-wrap: wrap; align-items: center; gap: 2px 6px; margin-bottom: 3px;
        }
        .chat-name { font-size: 13px; font-weight: 700; color: var(--paper-ink); }
        .chat-name::before, .collab-name::before {
          content: ''; display: inline-block; width: 8px; height: 8px; border-radius: 50%;
          margin-right: 5px; background: var(--m); box-shadow: 0 0 0 1px var(--paper-line);
        }
        .chat-provider { font-size: 13px; color: var(--paper-ink-2); }
        .chat-chip {
          --m: var(--paper-line);
          font-size: 13px; font-weight: 700; letter-spacing: 0.2px; color: var(--paper-ink);
          padding: 0 6px; border-radius: 6px;
          background: color-mix(in srgb, var(--m) 22%, var(--paper-white));
          box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--m) 60%, var(--paper-ink));
        }
        .chat-chip.fallback { --m: var(--st-blocked); }
        .chat-time { font-size: 13px; color: var(--paper-ink-2); margin-left: auto; padding-left: 8px; white-space: nowrap; }
        .chat-text { color: var(--paper-ink); font-size: 13px; line-height: 1.5; }

        .cot-toggle-btn {
          background: none; border: none; color: var(--paper-brass-ink); font-size: 13px; font-weight: 600;
          cursor: pointer; padding: 3px 0 1px; letter-spacing: 0.2px;
        }
        .cot-toggle-btn:hover { color: var(--paper-ink); }
        .cot-content {
          font-size: 13px; line-height: 1.55; color: var(--paper-ink-2);
          background: var(--paper-sunk); border-radius: var(--paper-radius-sm);
          padding: 8px; margin: 4px 0 2px; white-space: pre-wrap;
        }

        .transcript-role {
          margin-bottom: 14px;
          padding-bottom: 12px;
          border-bottom: 1px solid var(--paper-hair);
        }

        .transcript-role:last-child {
          margin-bottom: 0;
          padding-bottom: 0;
          border-bottom: none;
        }

        .role-header {
          display: flex;
          align-items: baseline;
          gap: 8px;
          margin-bottom: 6px;
        }

        .role-label {
          font-size: 13px;
          font-weight: 700;
          letter-spacing: 0.2px;
          color: var(--paper-ink-2);
        }

        .role-model {
          font-size: 13px;
          color: var(--paper-ink-2);
        }

        .role-content {
          font-size: 13px;
          color: var(--paper-ink);
          line-height: 1.55;
        }

        .role-content p {
          margin: 0 0 6px 0;
        }

        .role-content p:last-child {
          margin-bottom: 0;
        }

        .role-content .soft { color: var(--paper-ink-2); }
        .role-content .quiet { color: var(--paper-ink-2); }
        .role-content .note-line { font-size: 13px; color: var(--paper-ink-2); }

        .mutation-item {
          margin-bottom: 6px;
          padding-left: 10px;
          border-left: 2px solid color-mix(in srgb, var(--st-working) 60%, var(--paper-ink));
        }

        .challenge-item {
          margin-bottom: 6px;
          padding-left: 10px;
        }

        .challenge-item.critical {
          border-left: 2px solid color-mix(in srgb, var(--st-blocked) 60%, var(--paper-ink));
        }

        .challenge-item.warning {
          border-left: 2px solid color-mix(in srgb, var(--st-working) 60%, var(--paper-ink));
        }

        .challenge-item.note {
          border-left: 2px solid color-mix(in srgb, var(--st-stable) 60%, var(--paper-ink));
        }

        .decision-item {
          margin-bottom: 6px;
          padding-left: 10px;
        }

        .decision-item.approve {
          border-left: 2px solid color-mix(in srgb, var(--st-healthy) 60%, var(--paper-ink));
        }

        .decision-item.reject {
          border-left: 2px solid color-mix(in srgb, var(--st-blocked) 60%, var(--paper-ink));
        }

        .decision-item.modify {
          border-left: 2px solid color-mix(in srgb, var(--st-working) 60%, var(--paper-ink));
        }

        .empty-state {
          text-align: center;
          padding: 32px 16px;
          color: var(--paper-ink-2);
        }

        .empty-state-icon {
          font-size: 32px;
          margin-bottom: 12px;
          opacity: 0.8;
        }

        .empty-state-text {
          font-size: 13px;
          line-height: 1.5;
        }

        @media (prefers-reduced-motion: reduce) {
          #transcript-toggle, #transcript-panel, .full-transcript, .full-transcript.expanded,
          .transcript-toggle-btn, .transcript-toggle-btn .toggle-arrow { transition: none; }
        }
      </style>
    `

    document.body.appendChild(this.container)

    // Create toggle button
    this.toggleButton = document.createElement('button')
    this.toggleButton.id = 'transcript-toggle'
    this.toggleButton.title = 'View experiment log'
    this.toggleButton.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14,2 14,8 20,8"/>
        <line x1="16" y1="13" x2="8" y2="13"/>
        <line x1="16" y1="17" x2="8" y2="17"/>
        <line x1="10" y1="9" x2="8" y2="9"/>
      </svg>
    `
    this.toggleButton.addEventListener('click', () => this.toggle())
    this.container.appendChild(this.toggleButton)

    // Create panel
    this.panel = document.createElement('div')
    this.panel.id = 'transcript-panel'
    this.panel.innerHTML = `
      <div class="panel-header">
        <div>
          <div class="panel-title">Experiment Log</div>
          <div class="panel-subtitle">Commentator summaries</div>
        </div>
      </div>
      <div class="panel-content">
        <div class="empty-state">
          <div class="empty-state-icon">🌱</div>
          <div class="empty-state-text">
            No epochs yet.<br>
            The experiment will begin soon.
          </div>
        </div>
      </div>
    `
    this.container.appendChild(this.panel)

    // Close panel when clicking outside
    document.addEventListener('click', (e) => {
      if (this.isOpen && !this.container.contains(e.target as Node)) {
        this.close()
      }
    })
  }

  // Toggle panel open/closed
  public toggle(): void {
    if (this.isOpen) {
      this.close()
    } else {
      this.open()
    }
  }

  // Open panel
  public open(): void {
    this.isOpen = true
    this.panel.classList.add('open')
    if (this.onOpen) this.onOpen()
  }

  // Close panel
  public close(): void {
    this.isOpen = false
    this.panel.classList.remove('open')
    if (this.onClose) this.onClose()
  }

  // Update with new epochs
  public updateEpochs(epochs: Epoch[]): void {
    this.epochs = epochs
    this.render()
    this.fetchWildcardTranscripts()
  }

  // North/GLM's side-experiment dialogue lives in its own table (they don't
  // hold panel roles) — pull it so their turns show up in the log too.
  private async fetchWildcardTranscripts(): Promise<void> {
    try {
      const response = await fetch('/api/experiment/wildcard-transcripts')
      if (!response.ok) return
      const data = await response.json() as {
        transcripts: Array<{ id: string; epoch_number: number; speaker: string; model_id: string; text: string }>
      }
      const changed = data.transcripts.length !== this.wildcardTurns.length
      this.wildcardTurns = data.transcripts
      if (changed) this.render()
    } catch {
      /* endpoint optional — panel works without it */
    }
  }

  private render(): void {
    const content = this.panel.querySelector('.panel-content')
    if (!content) return

    if (this.epochs.length === 0) {
      content.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🌱</div>
          <div class="empty-state-text">
            No epochs yet.<br>
            The experiment will begin soon.
          </div>
        </div>
      `
      return
    }

    // Sort by epoch number descending (most recent first)
    const sortedEpochs = [...this.epochs].sort((a, b) => b.epoch_number - a.epoch_number)

    content.innerHTML = sortedEpochs.map(epoch => this.renderEpoch(epoch)).join('')

    // Add event listeners for transcript toggles
    content.querySelectorAll('.transcript-toggle-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement
        const epochId = target.dataset.epochId
        const transcript = content.querySelector(`.full-transcript[data-epoch-id="${epochId}"]`)
        const textSpan = target.querySelector('.toggle-text')
        if (transcript && textSpan) {
          const isExpanded = transcript.classList.toggle('expanded')
          target.classList.toggle('expanded', isExpanded)
          textSpan.textContent = isExpanded ? 'Collapse' : 'View full transcript'
        }
      })
    })

    // Per-turn reasoning expanders (the model's short account of its decision)
    content.querySelectorAll('.cot-toggle-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement
        const id = target.dataset.cot
        const body = content.querySelector(`.cot-content[data-cot="${id}"]`) as HTMLElement | null
        if (body) {
          const open = body.style.display !== 'block'
          body.style.display = open ? 'block' : 'none'
          target.textContent = open ? '▾ hide reasoning' : '▸ reasoning'
        }
      })
    })
  }

  private renderEpoch(epoch: Epoch): string {
    const commentator = epoch.commentator_output as CommentatorOutput | undefined
    const timeAgo = this.getRelativeTime(epoch.completed_at)

    if (!commentator) {
      // Epoch 0 is the seed - show appropriate message
      const message = epoch.epoch_number === 0
        ? 'Seed planted. Waiting for first growth cycle...'
        : 'Epoch in progress...'
      return `
        <div class="epoch-entry">
          <div class="epoch-header">
            <div class="epoch-header-left">
              <span class="epoch-number">Epoch ${epoch.epoch_number}</span>
              ${epoch.epoch_number === 0 ? '<span class="epoch-mood stable">seed</span>' : ''}
            </div>
          </div>
          <div class="epoch-summary quiet">
            ${message}
          </div>
        </div>
      `
    }

    return `
      <div class="epoch-entry">
        <div class="epoch-header">
          <div class="epoch-header-left">
            <span class="epoch-number">Epoch ${epoch.epoch_number}</span>
            <span class="epoch-mood ${this.safeClass(commentator.mood, ['thriving', 'growing', 'struggling', 'pruning', 'stable'], 'stable')}">${this.escapeHtml(commentator.mood)}</span>
          </div>
          <span class="epoch-time">${timeAgo}</span>
        </div>
        <div class="epoch-summary">"${this.escapeHtml(commentator.summary)}"</div>
        <div class="epoch-metaphor">${this.escapeHtml(commentator.plant_metaphor)}</div>
        ${this.renderCollabSummary(epoch)}
        ${this.renderEmergent(epoch)}
        ${this.renderWildcard(epoch)}
        <button class="transcript-toggle-btn" data-epoch-id="${this.escapeHtml(epoch.id)}">
          <span class="toggle-arrow">▼</span>
          <span class="toggle-text">View full transcript</span>
        </button>
        <div class="full-transcript" data-epoch-id="${this.escapeHtml(epoch.id)}">
          ${this.renderTranscript(epoch)}
        </div>
      </div>
    `
  }

  private getRelativeTime(timestamp?: string): string {
    if (!timestamp) return ''

    const now = Date.now()
    const then = new Date(timestamp).getTime()
    const diffMs = now - then
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMins / 60)
    const diffDays = Math.floor(diffHours / 24)

    if (diffMins < 1) return 'just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays < 7) return `${diffDays}d ago`
    return new Date(timestamp).toLocaleDateString()
  }

  // Who actually answered a stored role output. When the assigned model failed
  // and a fallback answered, the server records it in `served_by`; the log then
  // shows the fallback model and says it stood in for the assigned one.
  private answeredBy(output: unknown, assigned: string): { modelId: ModelId; name: string; fallbackFor?: string } {
    const servedBy = output && typeof output === 'object'
      ? (output as { served_by?: { model?: unknown; fallback?: unknown } }).served_by
      : undefined
    // modelDisplayName names panel, fallback and wildcard models alike, so a
    // stand-in shows as "Claude Sonnet 5.5", not its raw OpenRouter id.
    const assignedName = modelDisplayName(assigned) || assigned
    if (servedBy?.fallback === true && typeof servedBy.model === 'string' && servedBy.model) {
      const modelId = servedBy.model as ModelId
      return { modelId, name: modelDisplayName(servedBy.model) || servedBy.model, fallbackFor: assignedName }
    }
    return { modelId: assigned as ModelId, name: assignedName }
  }

  // One-line "what happened in the room" — who challenged what, what the reviewer
  // approved / modified / rejected. Surfaces the collaboration dynamic at a glance.
  private renderCollabSummary(epoch: Epoch): string {
    const ch = epoch.challenger_output as ChallengerOutput | undefined
    const rv = epoch.reviewer_output as ReviewerOutput | undefined
    if (!ch && !rv) return ''
    const a = epoch.role_assignments
    const parts: string[] = []
    if (ch) {
      const who = this.answeredBy(ch, a.challenger)
      const name = who.fallbackFor ? `${who.name} (fallback for ${who.fallbackFor})` : who.name
      const n = ch.challenges?.length || 0
      const risk = ch.overall_risk ? ` (risk: ${this.escapeHtml(ch.overall_risk)})` : ''
      parts.push(`<span class="collab-name" style="--m:${modelColorHex(who.modelId)}">${this.escapeHtml(name)}</span> flagged ${n} concern${n === 1 ? '' : 's'}${risk}`)
    }
    if (rv && (rv.decisions?.length || 0) > 0) {
      const who = this.answeredBy(rv, a.reviewer)
      const name = who.fallbackFor ? `${who.name} (fallback for ${who.fallbackFor})` : who.name
      const d = rv.decisions
      const approved = d.filter(x => x.verdict === 'approve').length
      const modified = d.filter(x => x.verdict === 'modify').length
      const rejected = d.filter(x => x.verdict === 'reject').length
      parts.push(`<span class="collab-name" style="--m:${modelColorHex(who.modelId)}">${this.escapeHtml(name)}</span> approved ${approved}, modified ${modified}, rejected ${rejected}`)
    }
    if (!parts.length) return ''
    return `<div class="collab">🗣 ${parts.join(' &nbsp;·&nbsp; ')}</div>`
  }

  // North/GLM's side-experiment dialogue for this epoch — real turns from
  // their wildcard runs, color-coded to match their lab accents.
  private renderWildcard(epoch: Epoch): string {
    const turns = this.wildcardTurns.filter(t => t.epoch_number === epoch.epoch_number)
    if (!turns.length) return ''
    // Speakers are stored by display name; older rows may use the bare family name.
    const hex = (n: number) => '#' + n.toString(16).padStart(6, '0')
    const accents: Record<string, string> = {
      North: hex(WILDCARD_ACCENTS.north), GLM: hex(WILDCARD_ACCENTS.glm),
      [WILDCARD_DISPLAY_NAMES.north]: hex(WILDCARD_ACCENTS.north),
      [WILDCARD_DISPLAY_NAMES.glm]: hex(WILDCARD_ACCENTS.glm),
    }
    // Rows come newest-first from the API; show them oldest-first, capped so
    // a chatty experiment doesn't swallow the epoch entry.
    const shown = [...turns].reverse().slice(-6)
    const rows = shown.map(t => {
      const color = accents[t.speaker] || 'var(--st-healthy)'
      return `<div class="wild-turn" style="--m:${color}">
        <span class="wild-name">${this.escapeHtml(t.speaker)}</span>
        <span class="wild-text"> ${this.escapeHtml(t.text.length > 220 ? t.text.slice(0, 220) + '…' : t.text)}</span>
      </div>`
    }).join('')
    return `<div class="wild">
      <div class="wild-head">🧪 Wildcard lab: ${this.escapeHtml(WILDCARD_DISPLAY_NAMES.north)} &amp; ${this.escapeHtml(WILDCARD_DISPLAY_NAMES.glm)}</div>
      ${rows}
    </div>`
  }

  // Highlight what the models invented on their own (not in the seed).
  private renderEmergent(epoch: Epoch): string {
    const c = epoch.commentator_output as CommentatorOutput | undefined
    const list = c?.emergent_behaviors || []
    if (!list.length) return ''
    const items = list.map(e => this.escapeHtml(e.observation)).join('; ')
    return `<div class="emerged">✨ Emerged: ${items}</div>`
  }

  private renderTranscript(epoch: Epoch): string {
    const roles = [
      { key: 'planner', label: 'Planner', output: epoch.planner_output },
      { key: 'executor', label: 'Executor', output: epoch.executor_output },
      { key: 'challenger', label: 'Challenger', output: epoch.challenger_output },
      // The Executor's answer to the Challenger, argued before the Reviewer rules
      { key: 'rebuttal', label: 'Executor · rebuttal', output: epoch.executor_rebuttal },
      { key: 'reviewer', label: 'Reviewer', output: epoch.reviewer_output },
      { key: 'commentator', label: 'Commentator', output: epoch.commentator_output },
    ]

    const time = this.getClockTime(epoch.completed_at)
    let sideIndex = 0
    return roles.map(role => {
      if (!role.output) return ''

      const assignmentKey = role.key === 'rebuttal' ? 'executor' : role.key
      const assigned = epoch.role_assignments[assignmentKey as keyof typeof epoch.role_assignments] as ModelId
      const who = this.answeredBy(role.output, assigned)
      const modelId = who.modelId
      const modelName = who.name
      const fallbackChip = who.fallbackFor
        ? `<span class="chat-chip fallback" title="The assigned model failed; this model answered instead.">fallback for ${this.escapeHtml(who.fallbackFor)}</span>`
        : ''

      const color = modelColorHex(modelId)
      const provider = this.modelProvider(modelId)
      const logo = providerLogoForModel(modelId)
      const obj = role.output as unknown as Record<string, unknown>
      const remark = typeof obj.remark === 'string' ? obj.remark : ''
      const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : ''
      const cotId = `${epoch.id}-${role.key}`
      const side = sideIndex++ % 2 === 0 ? 'left' : 'right' // alternate for the group-chat zigzag

      return `
        <div class="chat-msg ${side}">
          <span class="chat-avatar${logo ? ' chat-avatar--logo' : ''}"${logo ? '' : ` style="--m:${color}"`} title="${this.escapeHtml(modelName)} · ${this.escapeHtml(provider)}">${logo ? `<img src="${logo}" alt="${this.escapeHtml(provider)} logo" width="20" height="20">` : this.escapeHtml(provider)}</span>
          <div class="chat-bubble">
            <div class="chat-head">
              <span class="chat-name" style="--m:${color}">${this.escapeHtml(modelName)}</span>
              <span class="chat-provider">${this.escapeHtml(provider)}</span>
              <span class="chat-chip" style="--m:${color}">${role.label}</span>
              ${fallbackChip}
              <span class="chat-time">${time}</span>
            </div>
            ${remark ? `<div class="chat-text">${this.escapeHtml(remark)}</div>` : ''}
            ${reasoning ? `<button class="cot-toggle-btn" data-cot="${this.escapeHtml(cotId)}">▸ reasoning</button><div class="cot-content" data-cot="${this.escapeHtml(cotId)}" style="display:none;">${this.escapeHtml(reasoning)}</div>` : ''}
            <div class="role-content" style="margin-top:4px;">${this.formatOutput(role.key, role.output)}</div>
          </div>
        </div>
      `
    }).join('')
  }

  // Keep provider names available for accessible labels and unknown-provider fallbacks.
  private modelProvider(modelId: ModelId): string {
    const frontendId = BACKEND_TO_FRONTEND_MODEL[modelId]
    if (frontendId && MODEL_PROVIDER_NAMES[frontendId]) return MODEL_PROVIDER_NAMES[frontendId]
    // wildcards, fallbacks and older runs: plain-text provider from the id prefix
    const prefix = String(modelId).split('/')[0]
    const known: Record<string, string> = { google: 'Google', deepseek: 'DeepSeek', anthropic: 'Anthropic', openai: 'OpenAI', 'x-ai': 'xAI', 'z-ai': 'Z.ai', cohere: 'Cohere' }
    return Object.hasOwn(known, prefix) ? known[prefix] : prefix
  }

  private getClockTime(iso?: string): string {
    if (!iso) return ''
    const d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  private formatOutput(roleKey: string, output: unknown): string {
    if (typeof output === 'string') return `<p>${this.escapeHtml(output)}</p>`
    if (typeof output !== 'object' || output === null) return `<p>${this.escapeHtml(output)}</p>`

    const obj = output as Record<string, unknown>

    // Format based on role type
    switch (roleKey) {
      case 'planner':
        return this.formatPlannerOutput(obj)
      case 'executor':
        return this.formatExecutorOutput(obj)
      case 'challenger':
        return this.formatChallengerOutput(obj)
      case 'reviewer':
        return this.formatReviewerOutput(obj)
      case 'commentator':
        return this.formatCommentatorOutput(obj)
      default:
        return `<p>${this.escapeHtml(JSON.stringify(output, null, 2))}</p>`
    }
  }

  private formatPlannerOutput(obj: Record<string, unknown>): string {
    const direction = obj.direction as string | undefined
    const rationale = obj.rationale as string | undefined
    const focus = obj.suggested_focus as string | undefined

    let html = ''
    if (direction) {
      html += `<p>"${this.escapeHtml(direction)}"</p>`
    }
    if (rationale) {
      html += `<p class="soft">${this.escapeHtml(rationale)}</p>`
    }
    if (focus) {
      html += `<p class="note-line">Focus: ${this.escapeHtml(focus)}</p>`
    }
    return html || '<p class="quiet">No direction provided</p>'
  }

  private formatExecutorOutput(obj: Record<string, unknown>): string {
    const mutations = obj.mutations as Array<{
      type: string
      target: string
      path?: string
      value?: Record<string, unknown>
      rationale: string
    }> | undefined

    if (!mutations || mutations.length === 0) {
      return '<p class="quiet">No mutations proposed</p>'
    }

    return mutations.map(m => {
      const action = m.type === 'add' ? 'Proposed adding' :
                     m.type === 'modify' ? 'Proposed modifying' :
                     m.type === 'remove' ? 'Proposed removing' : m.type
      const target = m.target
      const desc = m.value?.description || m.rationale || ''
      return `<div class="mutation-item">
        <strong>${this.escapeHtml(action)} ${this.escapeHtml(target)}:</strong> ${this.escapeHtml(String(desc))}
      </div>`
    }).join('')
  }

  private formatChallengerOutput(obj: Record<string, unknown>): string {
    const challenges = obj.challenges as Array<{
      issue: string
      severity: string
      example_scenario?: string
      suggested_fix?: string
    }> | undefined
    const risk = obj.overall_risk as string | undefined
    const recommendation = obj.recommendation as string | undefined

    let html = ''

    if (challenges && challenges.length > 0) {
      html += challenges.map(c => {
        let content = `<strong>Raised concern:</strong> ${this.escapeHtml(c.issue)}`
        if (c.suggested_fix) {
          content += `<br><span class="soft">Suggested fix: ${this.escapeHtml(c.suggested_fix)}</span>`
        }
        return `<div class="challenge-item ${this.safeClass(c.severity, ['critical', 'warning', 'note'], 'note')}">${content}</div>`
      }).join('')
    } else {
      html += '<p class="quiet">No challenges raised</p>'
    }

    if (risk && recommendation) {
      html += `<p class="note-line" style="margin-top: 8px;">
        Risk: ${this.escapeHtml(risk)} · Recommendation: ${this.escapeHtml(String(recommendation).replace(/_/g, ' '))}
      </p>`
    }

    return html
  }

  private formatReviewerOutput(obj: Record<string, unknown>): string {
    const decisions = obj.decisions as Array<{
      verdict: string
      reason: string
      mutation_index?: number
    }> | undefined
    const summary = obj.epoch_summary as string | undefined
    const stability = obj.updated_stability_score as number | undefined

    let html = ''

    if (decisions && decisions.length > 0) {
      html += decisions.map(d => {
        const verdictLabel = d.verdict === 'approve' ? 'Approved' :
                            d.verdict === 'reject' ? 'Rejected' :
                            d.verdict === 'modify' ? 'Approved with modification' : d.verdict
        return `<div class="decision-item ${this.safeClass(d.verdict, ['approve', 'reject', 'modify'], 'reject')}">
          <strong>${this.escapeHtml(verdictLabel)}:</strong> ${this.escapeHtml(d.reason)}
        </div>`
      }).join('')
    }

    if (summary) {
      html += `<p style="margin-top: 8px;">${this.escapeHtml(summary)}</p>`
    }

    if (stability !== undefined) {
      const pct = Math.round(stability * 100)
      html += `<p class="note-line">Updated stability: ${pct}%</p>`
    }

    return html || '<p class="quiet">No decisions recorded</p>'
  }

  private formatCommentatorOutput(obj: Record<string, unknown>): string {
    const highlight = obj.highlight as string | undefined
    const forReturning = obj.for_returning_visitors as string | undefined

    let html = ''
    if (highlight) {
      html += `<p><em>${this.escapeHtml(highlight)}</em></p>`
    }
    if (forReturning) {
      html += `<p class="soft">${this.escapeHtml(forReturning)}</p>`
    }
    return html || '<p class="quiet">No additional commentary</p>'
  }

  private safeClass(value: unknown, allowed: string[], fallback: string): string {
    return typeof value === 'string' && allowed.includes(value) ? value : fallback
  }

  private escapeHtml(text: unknown): string {
    return String(text ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char] || char)
  }

  // Check if panel is open
  public isVisible(): boolean {
    return this.isOpen
  }

  // Dispose
  public dispose(): void {
    this.container.remove()
  }
}
