// The shared "paper and brass" look, first drawn for the trained model chat
// (src/systems/TrainedChatPanel.ts) and now the one place every panel takes its
// colours, type, borders, radii and shadows from.
//
// Warm paper surfaces, dark ink, a brass top rule, brass only for the primary
// action, selection and focus. Serif headings, sans body, thin brass-brown
// borders, soft corners, nothing under 13px.
//
// Use it in three steps:
//   1. installPaperTheme() once (it is idempotent) puts the tokens on :root.
//   2. Write rules with var(--paper-*), never a hex value.
//   3. For the common pieces call a snippet with your own selector, for example
//      paperQuietButton('#my-panel .my-button'). A snippet returns CSS text with
//      the look only (colour, border, radius, type weight); size, padding and
//      layout stay in your own rules.
//
// Contrast, measured on the composited colours (WCAG 2.x relative luminance).
// Body text needs 4.5, large text 3, control edges and meaningful icons 3.
//
//   text pair                        ratio   control edge / mark pair       ratio
//   ink       on surface              13.70  line       on surface            4.97
//   ink       on raised               14.56  line       on raised             5.28
//   ink       on white                15.32  line       on sunk               4.38
//   ink       on visitor              11.56  line       on white              5.55
//   ink       on sunk                 12.08  brass-edge on surface            3.83
//   ink       on brass                 6.20  brass-edge on raised             4.07
//   ink       on danger-bg            12.20  brass-edge on sunk              3.38
//   ink-2     on surface               7.22  focus      on surface            6.05
//   ink-2     on raised                7.67  focus      on raised             6.43
//   ink-2     on visitor               6.09  focus      on sunk               5.33
//   ink-2     on sunk                  6.37  bar        on sunk               3.23
//   brass-ink on surface               6.05  ink        on raised (swatch)   14.56
//   brass-ink on raised                6.43
//   brass-ink on sunk                  5.33  Not for text or edges:
//   danger    on surface               7.25  brass      on surface            2.21
//   danger    on raised                7.71  (brass is a fill; put ink on it)
//   danger    on danger-bg             6.46
//
//   ok        on surface            3.05  working    on surface            3.02
//   blocked   on surface            3.00  (status marks; each carries an ink-2 ring at 7:1)
//
// Not in the theme on purpose: a dark mode. A pressed state exists for quiet buttons only (sunk paper with an
// inset ink line).

/** Every role token, in the order they appear on :root. Values are what the chat has always used. */
export const PAPER_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  '--paper-surface': '#F5F2EB', // page paper: panel body, conversation area
  '--paper-raised': '#FBF9F4', // heads, feet, cards, buttons: one step above the surface
  '--paper-sunk': '#EAE4D6', // shelves, tracks, disabled and hover wash: one step below
  '--paper-white': '#FFFFFF', // text fields and answer bubbles
  '--paper-visitor': '#E9DFC8', // the visitor's own bubble and notices
  '--paper-ink': '#2B241B', // body text, and text on brass
  '--paper-ink-2': '#5B4E3D', // secondary text
  '--paper-line': '#7A6548', // borders of controls and cards, and the neutral maker mark
  '--paper-hair': 'rgba(139,115,85,0.35)', // hairline dividers between bands
  '--paper-brass': '#B5A642', // primary action fill, selection bar, top rule. Never text
  '--paper-brass-edge': '#8A7A2A', // border of brass fills, selected card edge
  '--paper-brass-ink': '#6B5A1E', // brass-coloured text and links
  '--paper-focus': '#6B5A1E', // focus ring
  '--paper-danger': '#8E2F2A', // errors and conflicts only
  '--paper-danger-bg': '#F6E1DC', // error band
  '--paper-bar': '#8B7B66', // the "before" bar of a gauge
  '--paper-ok': '#699838', // status mark: healthy. 3:1 or more on surface and raised; always drawn with an ink ring
  '--paper-working': '#B58237', // status mark: working
  '--paper-blocked': '#D76C6C', // status mark: blocked
  '--paper-raised-veil': 'rgba(251,249,244,0.94)', // round floating buttons over the room
  '--paper-shadow': '0 10px 36px rgba(60,42,20,0.28)', // an open panel
  '--paper-shadow-soft': '0 2px 12px rgba(60,42,20,0.18)', // a floating button
  '--paper-shadow-lift': '0 4px 16px rgba(60,42,20,0.25)', // a floating button on hover
  '--paper-serif': "Georgia, 'Times New Roman', serif", // headings
  '--paper-sans': "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", // body
  '--paper-mono': 'ui-monospace, Menlo, monospace', // identifiers
  '--paper-radius-panel': '14px', // an open panel
  '--paper-radius': '10px', // buttons, cards, fields
  '--paper-radius-sm': '8px', // banners and notices
})

/** The :root style text that defines every token. */
export function paperRootCss(): string {
  return `:root { ${Object.entries(PAPER_TOKENS).map(([k, v]) => `${k}: ${v};`).join(' ')} }`
}

export const PAPER_STYLE_ID = 'paper-theme'

/** Puts the tokens on the page once. Safe to call from every panel; later calls do nothing. */
export function installPaperTheme(doc: Document = document): void {
  if (doc.getElementById?.(PAPER_STYLE_ID)) return
  const host = doc.head ?? doc.body
  if (!host) return
  const style = doc.createElement('style')
  style.id = PAPER_STYLE_ID
  style.textContent = paperRootCss()
  host.appendChild(style)
}

// ---------------------------------------------------------------------------
// Snippets. Each takes a selector (or a comma-separated list) and returns rules.
// ---------------------------------------------------------------------------

/** Focus ring for everything focusable inside `scope`. */
export const paperFocusRing = (scope: string): string =>
  `${scope} :focus-visible { outline: 2px solid var(--paper-focus); outline-offset: 2px; }`

/** The panel's look: paper, thin line, soft corners, shadow, ink, sans body. Add position and size yourself. */
export const paperShell = (sel: string): string =>
  `${sel} { background: var(--paper-surface); border: 1px solid var(--paper-line); border-radius: var(--paper-radius-panel); box-shadow: var(--paper-shadow); color: var(--paper-ink); font-family: var(--paper-sans); font-size: 15px; line-height: 1.5; }`

/** A header band: raised paper, brass top rule, hairline below. */
export const paperHeader = (sel: string): string =>
  `${sel} { background: var(--paper-raised); border-top: 3px solid var(--paper-brass); border-bottom: 1px solid var(--paper-hair); }`

/** A serif heading. Pass a size in px (17 for a panel title, 15 to 20 for section titles). */
export const paperHeading = (sel: string, sizePx = 17): string =>
  `${sel} { font-family: var(--paper-serif); font-size: ${sizePx}px; font-weight: 700; color: var(--paper-ink); }`

/** Quiet button: raised paper, thin line. Hover washes to sunk and darkens the edge. */
export const paperQuietButton = (sel: string): string =>
  `${sel} { background: var(--paper-raised); border: 1px solid var(--paper-line); border-radius: var(--paper-radius); font-weight: 600; cursor: pointer; color: var(--paper-ink); }\n` +
  `${sel.split(',').map(s => `${s.trim()}:hover`).join(', ')} { background: var(--paper-sunk); border-color: var(--paper-ink); }\n` +
  `${sel.split(',').map(s => `${s.trim()}:active:not(:disabled)`).join(', ')} { background: var(--paper-sunk); box-shadow: inset 0 0 0 1px var(--paper-ink); }`

/** Primary button: brass fill, brass edge, ink label. One per view. */
export const paperPrimaryButton = (sel: string): string =>
  `${sel} { border-radius: var(--paper-radius); border: 1px solid var(--paper-brass-edge); background: var(--paper-brass); color: var(--paper-ink); cursor: pointer; font-weight: 600; }`

/** Disabled controls inside `scope`: faded, no pointer. */
export const paperDisabled = (scope: string): string =>
  `${scope} button:disabled, ${scope} textarea:disabled, ${scope} input:disabled { opacity: 0.55; cursor: default; }`

/** A small pill tag with a brass edge and ink text. */
export const paperTag = (sel: string): string =>
  `${sel} { padding: 0 8px; border-radius: 10px; border: 1px solid var(--paper-brass-edge); font-size: 13px; letter-spacing: 0.2px; font-weight: 600; line-height: 18px; color: var(--paper-ink); }`

/** Text field: white, thin line, ink text, 16px so a phone does not zoom. */
export const paperInput = (sel: string): string =>
  `${sel} { border-radius: var(--paper-radius); border: 1px solid var(--paper-line); background: var(--paper-white); color: var(--paper-ink); font-family: inherit; font-size: 16px; }`

/** A card: raised paper, thin line, soft wash on hover. */
export const paperCard = (sel: string): string =>
  `${sel} { background: var(--paper-raised); border: 1px solid var(--paper-line); border-radius: var(--paper-radius); cursor: pointer; transition: background 0.12s ease; }\n` +
  `${sel}:hover { background: var(--paper-surface); border-color: var(--paper-ink); }`

/** The selected card: brass edge, and a brass bar down its left side. Needs position: relative on the card. */
export const paperCardSelected = (sel: string): string =>
  `${sel} { border: 2px solid var(--paper-brass-edge); }\n` +
  `${sel}::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--paper-brass); border-radius: 8px 0 0 8px; }`

/** Thin brass-brown scrollbars on paper. Not used by the chat yet (it keeps the browser default). */
export const paperScrollbar = (sel: string): string =>
  `${sel} { scrollbar-width: thin; scrollbar-color: var(--paper-line) var(--paper-sunk); }\n` +
  `${sel}::-webkit-scrollbar { width: 10px; height: 10px; }\n` +
  `${sel}::-webkit-scrollbar-track { background: var(--paper-sunk); }\n` +
  `${sel}::-webkit-scrollbar-thumb { background: var(--paper-line); border-radius: 5px; border: 2px solid var(--paper-sunk); }`

/** Marks for the knowledge graph's node types and model providers. They are small marks, never text:
 *  each is drawn with an ink ring (and the panel darkens them where one sits on its own). */
export const PAPER_NODE_MARKS: Readonly<Record<string, string>> = Object.freeze({
  model: '#E8E4D9', epoch: '#B5A642', capability: '#7CB342', constraint: '#64B5F6', behavior: '#FFB74D',
  conflict: '#E57373', note: '#C9B79C', source: '#8FC1FF', code: '#B39DDB', turn: '#78C8FF',
})
export const PAPER_PROVIDER_MARKS: Readonly<Record<string, string>> = Object.freeze({
  google: '#4285F4', deepseek: '#10A37F', anthropic: '#D97706', openai: '#9C8CF0', 'x-ai': '#1DA1F2', 'z-ai': '#B0BEC5', cohere: '#E91E63',
})
