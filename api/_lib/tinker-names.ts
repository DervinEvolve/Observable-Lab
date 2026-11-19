/**
 * Names for trained adapters (docs/TOOLS.md, "Naming a trained adapter").
 *
 * When LAB_ENABLE_TINKER_NAMES is on, a Tinker training request may carry a
 * display name for the adapter it trains. The name is a label only. The
 * adapter's identity stays its lab id (lab/e<epoch>-<8 hex>): that is what
 * the model endpoint, the chat and the record address it by.
 *
 * A name is shown to visitors, so it is held to a small alphabet and may not
 * read like a real product or model. This file is the reading of a name and
 * nothing else: no database and no network. Whether a name is already taken
 * is checked where the run is opened (tinker-store.ts).
 *
 * A name that is refused never stops the run. The reason is stored and the
 * adapter goes without a name.
 */
import {
  FALLBACK_DISPLAY_NAMES, FALLBACK_MODELS, MODELS, MODEL_DISPLAY_NAMES, WILDCARD_DISPLAY_NAMES, WILDCARD_MODELS,
} from './types.js'

export const ADAPTER_NAME_MIN = 2
export const ADAPTER_NAME_MAX = 40
/** Letters, digits, spaces, hyphens, apostrophes and dots. Nothing else. */
const NAME_ALPHABET = /^[A-Za-z0-9 .'-]+$/

/**
 * Names of model families, products and their makers that a visitor could
 * take a trained adapter for. A name that contains one of these, once case,
 * separators and look-alike characters are set aside, is refused.
 */
const FAMILY_WORDS = [
  'gpt', 'chatgpt', 'openai', 'claude', 'anthropic', 'gemini', 'google', 'deepmind', 'grok', 'deepseek', 'llama',
  'qwen', 'alibaba', 'mistral', 'mixtral', 'nemotron', 'nvidia', 'microsoft', 'copilot', 'huggingface',
  'openrouter', 'perplexity', 'moonshot', 'thinkingmachines',
] as const

/**
 * Model and maker names that are also ordinary words or very short. These
 * are refused only as a whole word of the name, so "Opus" is refused and
 * "Octopus" is not. A whole word here is also the word with a version
 * written straight after it ("Opus4.5", "Fable5.2", "o3mini"), and the word
 * written as two ("x AI", "o 3").
 */
const WHOLE_WORDS = [
  'sonnet', 'opus', 'haiku', 'fable', 'astra', 'glm', 'kimi', 'phi', 'ernie', 'gemma', 'cohere', 'codex', 'tinker', 'xai', 'o1', 'o3', 'o4',
] as const

/** What makers write after a model's name and number: "o3-mini", "Phi-4-mini", "GLM-4-Plus". */
const TIER = /(mini|nano|lite|flash|turbo|plus|pro|max|ultra|preview|high|low)$/

/** Lower case with everything but letters and digits taken out. */
function plain(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * The same, with characters that pass for one another made one: i, l and 1
 * are one letter whatever their case (a capital I and a small l are the same
 * stroke in most typefaces), and the digits 0 3 4 5 7 are o e a s t. Both
 * sides of a comparison go through this, so it does not matter which of the
 * look-alikes the real name has and which the imitation.
 */
function letters(text: string): string {
  return plain(text).replace(/[i1]/g, 'l')
    .replace(/0/g, 'o').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't')
}

/** And with the pairs that pass for one letter: "rn" for m and "vv" for w. */
function folded(text: string): string {
  return letters(text).replace(/rn/g, 'm').replace(/vv/g, 'w')
}

/** Whether `text` holds `word` once look-alikes are set aside, with and without the pairs. */
function holds(text: string, word: string): boolean {
  return letters(text).includes(letters(word)) || folded(text).includes(folded(word))
}

/** Whether `text` is `word` once look-alikes are set aside. */
function same(text: string, word: string): boolean {
  return letters(text) === letters(word) || folded(text) === folded(word)
}

/**
 * What two names are compared by to decide whether they are the same name:
 * case, separators and look-alike characters do not make a name different,
 * so "QUIET LAMP", "Quiet Lamp" and "Qulet Larnp" are one name.
 */
export function adapterNameKey(name: string): string {
  return folded(name)
}

/** A name without the version written at its end: "Gemini 4" is "Gemini", "claude-fable-5.2" is "claude-fable". */
function stem(text: string): string {
  return text.replace(/[0-9 .'-]+$/, '')
}

/** The whole names of the models this lab runs: display names and the last part of each id. */
function labModelNames(): string[] {
  const ids = [...MODELS, ...FALLBACK_MODELS, ...Object.values(WILDCARD_MODELS)]
  const display = [...Object.values(MODEL_DISPLAY_NAMES), ...Object.values(FALLBACK_DISPLAY_NAMES), ...Object.values(WILDCARD_DISPLAY_NAMES)]
  const tails = ids.map(id => (id.split('/').pop() ?? id).replace(/:.*$/, ''))
  return [...display, ...tails, ...ids]
}

/**
 * The forms of one word of a name that are compared with a whole word: the
 * word as written, and the word with what a version adds taken off its end
 * (digits, then a tier like "mini", then digits again). Digits are taken off
 * one at a time, since a digit can also stand for a letter ("Opu5").
 */
function wordForms(word: string): string[] {
  const forms = new Set<string>()
  const trims = (text: string) => {
    for (let t = text; t; t = /[0-9]$/.test(t) ? t.slice(0, -1) : '') forms.add(t)
  }
  trims(word)
  const lower = word.toLowerCase().replace(/[0-9]+$/, '')
  if (TIER.test(lower)) trims(lower.replace(TIER, ''))
  return [...forms]
}

/** The real name this one could be taken for, or null. */
function readsLike(name: string): string | null {
  // One of the lab's own models, as a whole name, with or without its version.
  for (const real of labModelNames()) {
    if (same(name, real) || (stem(real).length >= 3 && same(stem(name), stem(real)))) return real
  }
  // A family or a maker, anywhere in the name.
  for (const word of FAMILY_WORDS) {
    if (holds(name, word)) return word
  }
  // A short or ordinary name, as a whole word: one word of the name, or two that stand next to each other.
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean)
  const candidates = [...words, ...words.slice(1).map((w, i) => words[i] + w)].flatMap(wordForms)
  for (const word of WHOLE_WORDS) {
    if (candidates.some(c => same(c, word))) return word
  }
  return null
}

export type AdapterNameReading = { name: string } | { error: string }

/**
 * Reads the "name" a model gave its adapter. Strict: a name that breaks a
 * rule is refused with the reason, never changed to fit. Spaces at the ends
 * are the one thing set aside.
 */
export function readAdapterName(raw: unknown): AdapterNameReading {
  if (typeof raw !== 'string') return { error: 'the name is not text' }
  const name = raw.trim()
  if (name.length < ADAPTER_NAME_MIN || name.length > ADAPTER_NAME_MAX) {
    return { error: `a name must be ${ADAPTER_NAME_MIN} to ${ADAPTER_NAME_MAX} characters` }
  }
  if (!NAME_ALPHABET.test(name)) return { error: 'a name may hold only letters, digits, spaces, hyphens, apostrophes and dots' }
  if (!/^[A-Za-z0-9]/.test(name) || !/[A-Za-z0-9.]$/.test(name)) return { error: 'a name must start with a letter or digit and end with a letter, digit or dot' }
  if (/ {2}/.test(name)) return { error: 'a name may not hold two spaces in a row' }
  if ((name.match(/[A-Za-z]/g) ?? []).length < 2) return { error: 'a name needs at least two letters' }
  // A dot between a letter or digit and a letter reads as a web address
  // ("example.com"). "v1.5" and "Dr. Lin" are fine.
  if (/[A-Za-z0-9-]\.[A-Za-z]/.test(name) || /^(www|https?)\b/i.test(name) || plain(name).startsWith('http') || plain(name).startsWith('www')) {
    return { error: 'a name may not look like a web address (a dot must be followed by a digit, a space or the end)' }
  }
  // "e41-0a1b2c3d" is how the lab names an adapter. A display name that holds one, anywhere in it, could be taken
  // for another adapter ("e41-0a1b2c3d v2").
  if (/e[0-9]{1,6}[0-9a-f]{8}/.test(plain(name))) return { error: 'a name may not look like a lab id' }
  const real = readsLike(name)
  if (real) return { error: `"${name}" reads like the real model or product name "${real}"` }
  return { name }
}
