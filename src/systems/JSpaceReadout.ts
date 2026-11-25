// The J-space lens, readable. The lens over a scientist's head (entities/JSpaceLens.ts) is a small
// instrument in the room and hard to read; this panel shows the same two real things at reading size:
// the ideas in the model's own reasoning text (its "workspace") and what it then said (its remark).
// The lens's rank numbers and guard line are decoration, so they are not repeated here.

import { installPaperTheme, paperFocusRing, paperHeader, paperHeading, paperShell } from './paperTheme'

const esc = (s: string): string => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))

// Common words that carry no idea of their own.
const FILLER = new Set(['from', 'with', 'that', 'this', 'than', 'then', 'they', 'them', 'their', 'there', 'these', 'those', 'what', 'when', 'where', 'which', 'while', 'will', 'would', 'should', 'could', 'have', 'been', 'into', 'onto', 'over', 'only', 'also', 'just', 'more', 'most', 'some', 'such', 'each', 'every', 'about', 'after', 'before', 'because', 'still', 'very', 'were', 'your', 'ours', 'here', 'does', 'doing', 'done', 'like', 'make', 'made'])

export class JSpaceReadout {
  private el: HTMLDivElement

  constructor(private onClose: () => void) {
    installPaperTheme()
    const style = document.createElement('style')
    style.textContent = `
      ${paperShell('#jspace-readout')}
      #jspace-readout { position: fixed; left: 20px; bottom: 20px; z-index: 1050; width: min(520px, calc(100vw - 100px)); max-height: min(62vh, 560px); max-height: min(62dvh, 560px); display: none; flex-direction: column; overflow: hidden; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
      #jspace-readout.open { display: flex; }
      #jspace-readout .js-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; padding: 14px 16px 10px; }
      ${paperHeader('#jspace-readout .js-head')}
      #jspace-readout .js-title { font: 700 14px/1.2 var(--paper-mono); color: var(--paper-ink-2); letter-spacing: 0.5px; }
      ${paperHeading('#jspace-readout .js-model', 17)}
      #jspace-readout .js-model { margin-top: 4px; }
      #jspace-readout .js-note { font-size: 13px; color: var(--paper-ink-2); margin-top: 6px; line-height: 1.45; }
      #jspace-readout button { flex: 0 0 auto; background: none; border: none; color: var(--paper-ink-2); font-size: 22px; cursor: pointer; line-height: 1; padding: 0 2px; border-radius: var(--paper-radius-sm); }
      #jspace-readout button:hover { color: var(--paper-ink); background: var(--paper-sunk); }
      ${paperFocusRing('#jspace-readout')}
      #jspace-readout button:focus-visible { outline: 2px solid var(--paper-focus); outline-offset: 2px; }
      #jspace-readout .js-body { overflow: auto; overscroll-behavior: contain; padding: 4px 16px 16px; }
      #jspace-readout .js-section { margin: 12px 0 6px; font: 700 15px/1.2 var(--paper-serif); color: var(--paper-ink); }
      #jspace-readout .js-chips { display: flex; flex-wrap: wrap; gap: 6px; }
      #jspace-readout .js-chips span { font: 500 13.5px/1 var(--paper-mono); padding: 6px 8px; border-radius: 7px; background: var(--paper-sunk); border: 1px solid var(--paper-hair); color: var(--paper-ink); }
      #jspace-readout .js-said { font-size: 18px; line-height: 1.45; color: var(--paper-ink); }
      #jspace-readout .js-reasoning { font-size: 14px; line-height: 1.6; color: var(--paper-ink-2); white-space: pre-wrap; }
      /* A finger needs 44 px to land on. */
      @media (pointer: coarse) { #jspace-readout button { min-width: 44px; min-height: 44px; margin: -8px -10px -8px 0; } }
      /* On a phone it is a sheet along the bottom that stops short of the round buttons on the right (the knowledge graph's among them), so they stay in reach while it is open. */
      @media (max-width: 640px) { #jspace-readout { left: max(8px, env(safe-area-inset-left)); right: max(72px, env(safe-area-inset-right)); width: auto; bottom: max(8px, env(safe-area-inset-bottom)); } }`
    document.head.appendChild(style)
    this.el = document.createElement('div')
    this.el.id = 'jspace-readout'
    this.el.setAttribute('role', 'dialog')
    this.el.setAttribute('aria-label', 'J-space readout')
    document.body.appendChild(this.el)
    // Escape closes the readout, unless the knowledge graph is open over it (the graph takes that Escape).
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && this.el.classList.contains('open') && !this.el.inert) this.onClose() })
  }

  show(model: string, reasoning: string, remark: string): void {
    const seen = new Set<string>()
    const ideas = (reasoning || '').replace(/[^a-zA-Z0-9' -]/g, ' ').split(/\s+/)
      .filter(w => w.length > 3 && w.length < 16 && !FILLER.has(w.toLowerCase()))
      .filter(w => { const k = w.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true })
      .slice(0, 24)
    this.el.innerHTML = `
      <div class="js-head"><div>
        <div class="js-title">◉ J-SPACE</div>
        <div class="js-model">${esc(model)}</div>
        <div class="js-note">The ideas in this model's own reasoning text, and what it then said. Drawn from its text, not from its internal activations, which a cloud model does not share.</div>
      </div><button aria-label="Close the J-space readout">×</button></div>
      <div class="js-body">
        <div class="js-section">Workspace: ideas in its reasoning</div>
        ${ideas.length ? `<div class="js-chips">${ideas.map(w => `<span>${esc(w)}</span>`).join('')}</div>` : '<div class="js-reasoning">No reasoning text yet.</div>'}
        <div class="js-section">Said</div>
        <div class="js-said">${esc(remark || '…')}</div>
        ${reasoning ? `<div class="js-section">Its reasoning, in full</div><div class="js-reasoning">${esc(reasoning)}</div>` : ''}
      </div>`
    ;(this.el.querySelector('button') as HTMLButtonElement).addEventListener('click', () => this.onClose())
    this.el.classList.add('open')
  }

  hide(): void {
    this.el.classList.remove('open')
  }
}
