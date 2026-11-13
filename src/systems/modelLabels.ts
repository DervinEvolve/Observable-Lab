// Room labels for the panel and the wildcards. Every model name shown in the
// room is read from the shared maps in src/shared/types.ts, so changing the
// panel there changes every nameplate, tooltip and transcript line at once.
import {
  BACKEND_TO_FRONTEND_MODEL,
  MODEL_DISPLAY_NAMES,
  MODEL_PROVIDER_NAMES,
  WILDCARD_DISPLAY_NAMES,
  WILDCARD_MODELS,
  type FrontendModelId,
  type WildcardId,
} from '../shared/types'

// Provider prefixes of OpenRouter ids, as plain text. Panel providers come
// from the shared map; this only covers prefixes the shared map has no entry
// for (wildcards, fallbacks, older runs).
const PREFIX_PROVIDERS: Record<string, string> = {
  google: 'Google',
  deepseek: 'DeepSeek',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'x-ai': 'xAI',
  'z-ai': 'Z.ai',
  cohere: 'Cohere',
  nvidia: 'NVIDIA',
  poolside: 'Poolside',
}

/** OpenRouter id currently mapped to a scientist (e.g. gpt -> openai/...). */
export function panelModelId(fid: FrontendModelId): string | undefined {
  return Object.entries(BACKEND_TO_FRONTEND_MODEL).find(([, f]) => f === fid)?.[0]
}

/** Full display name of the model behind a scientist, e.g. "Claude Fable 5.2". */
export function panelName(fid: FrontendModelId): string {
  const id = panelModelId(fid)
  return (id && (MODEL_DISPLAY_NAMES as Record<string, string>)[id]) || fid
}

/** Short nameplate form: the family name ("GPT-6 Astra" -> "GPT-6"). */
export function shortName(name: string): string {
  return name.split(' ')[0] || name
}

/** Plain-text provider of any OpenRouter id. */
export function providerName(modelId: string | undefined): string {
  if (!modelId) return ''
  const fid = (BACKEND_TO_FRONTEND_MODEL as Record<string, FrontendModelId>)[modelId]
  if (fid && MODEL_PROVIDER_NAMES[fid]) return MODEL_PROVIDER_NAMES[fid]
  const prefix = modelId.split('/')[0]
  return Object.hasOwn(PREFIX_PROVIDERS, prefix) ? PREFIX_PROVIDERS[prefix] : prefix
}

/** The model slug without the provider prefix or the :free suffix. */
export function modelSlug(modelId: string | undefined): string {
  if (!modelId) return ''
  return (modelId.split('/')[1] || modelId).replace(/:free$/, '')
}

export function wildcardName(id: WildcardId): string {
  return WILDCARD_DISPLAY_NAMES[id] || id
}

export function wildcardModelId(id: WildcardId): string {
  return WILDCARD_MODELS[id]
}
