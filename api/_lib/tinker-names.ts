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
 * Model names that are also ordinary words or very short. These are refused
 * only as a whole word of the name, so "Opus" is refused and "Octopus" is not.
 */
const WHOLE_WORDS = [
  'sonnet', 'opus', 'haiku', 'fable', 'astra', 'glm', 'kimi', 'phi', 'ernie', 'gemma', 'cohere', 'codex', 'tinker', 'o1', 'o3', 'o4',
] as const

/** Lower case with everything but letters and digits taken out. */
function plain(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * The same, with look-alike characters set to the letter they pass for: a
 * capital I for a small l, the digits 0 1 3 4 5 7 for o l e a s t, "rn" for
 * m and "vv" for w. "C1aude", "CIaude" and "Gernini" all come out as the
 * name they imitate.
 */
function lookalike(text: string): string {
  const swapped = text.replace(/I/g, 'l').toLowerCase()
    .replace(/0/g, 'o').replace(/1/g, 'l').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't')
  return swapped.replace(/[^a-z0-9]/g, '').replace(/rn/g, 'm').replace(/vv/g, 'w')
}

/**
 * What two names are compared by to decide whether they are the same name:
 * case, separators and look-alike characters do not make a name different.
 */
export function adapterNameKey(name: string): string {
  return lookalike(name)
}

/** The whole names of the models this lab runs: display names and the last part of each id. */
function labModelNames(): string[] {
  const ids = [...MODELS, ...FALLBACK_MODELS, ...Object.values(WILDCARD_MODELS)]
  const display = [...Object.values(MODEL_DISPLAY_NAMES), ...Object.values(FALLBACK_DISPLAY_NAMES), ...Object.values(WILDCARD_DISPLAY_NAMES)]
  const tails = ids.map(id => (id.split('/').pop() ?? id).replace(/:.*$/, ''))
  return [...display, ...tails, ...ids]
}

/** The real name this one could be taken for, or null. */
function readsLike(name: string): string | null {
  const keys = [plain(name), lookalike(name)]
  for (const real of labModelNames()) {
    if (keys.includes(plain(real)) || keys.includes(lookalike(real))) return real
  }
  for (const word of FAMILY_WORDS) {
    if (keys.some(k => k.includes(word))) return word
  }
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean)
  for (const word of WHOLE_WORDS) {
    if (words.some(w => w.toLowerCase() === word || lookalike(w) === lookalike(word))) return word
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
  const real = readsLike(name)
  if (real) return { error: `"${name}" reads like the real model or product name "${real}"` }
  return { name }
}
