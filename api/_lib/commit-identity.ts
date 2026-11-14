/**
 * Git identities for every commit the lab writes to its repositories
 * (AI-Agent contributions, their subagents, the North and GLM wildcards,
 * Research-Lab records).
 *
 * Author: the model that produced the change, by display name, with an
 * address on observable-lab.invalid. `.invalid` is reserved (RFC 2606) and
 * can never be registered, so the address names the model without claiming
 * a mailbox anyone could own:
 *   Claude Fable 5.2 <claude-fable-5-2@observable-lab.invalid>
 * Committer: always the owner's GitHub noreply identity.
 *
 * The author is read from the commit message's `Model:` trailer, so the
 * trailers stay the single record of who wrote what. A message without one
 * (bootstrap files, ledger rows) is authored by the owner.
 */
import { modelDisplayName } from './types.js'

export interface CommitAuthor {
  name: string
  email: string
}

export const OWNER_COMMIT_IDENTITY: Readonly<CommitAuthor> = Object.freeze({
  name: 'DervinEvolve',
  email: '39844362+DervinEvolve@users.noreply.github.com',
})

/** Kept for older imports: the committer identity. */
export const LAB_COMMIT_IDENTITY = OWNER_COMMIT_IDENTITY

export const MODEL_AUTHOR_DOMAIN = 'observable-lab.invalid'

const oneLine = (value: string) => value.replace(/[\r\n]+/g, ' ').trim().slice(0, 120)

/** The author identity for a model, e.g. "GPT-6 Astra <gpt-6-astra@observable-lab.invalid>". */
export function modelCommitAuthor(displayName: string): CommitAuthor {
  // Git rejects <, > and newlines in names.
  const name = oneLine(displayName).replace(/[<>]/g, '').trim().slice(0, 80) || 'Model'
  const local = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'model'
  return { name, email: `${local}@${MODEL_AUTHOR_DOMAIN}` }
}

/**
 * The model named by the first `Model:` trailer of a commit message, or null.
 * A model id in parentheses wins over the free-text name when it is a model
 * the lab knows, so a fallback is credited under its own display name.
 */
export function commitAuthorFromMessage(message: string | undefined): CommitAuthor | null {
  if (!message) return null
  const line = message.split('\n').map(l => l.trim()).find(l => l.startsWith('Model: '))
  if (!line) return null
  const value = line.slice('Model: '.length).trim()
  const m = value.match(/^(.*?)\s*\(([^()]*)\)\s*$/)
  const name = (m ? m[1] : value).trim()
  const known = m ? modelDisplayName(m[2].trim()) : undefined
  const display = known || name
  return display ? modelCommitAuthor(display) : null
}

/** Author and committer for a GitHub contents API request body. */
export function labCommitIdentityFields(message?: string): { author: CommitAuthor; committer: CommitAuthor } {
  const author = commitAuthorFromMessage(message) ?? { ...OWNER_COMMIT_IDENTITY }
  return { author, committer: { ...OWNER_COMMIT_IDENTITY } }
}

/**
 * Git trailers naming the model that produced a commit. `id` is the model
 * identifier that answered; `fallbackFor` is set when it stood in for the
 * assigned model.
 */
export function modelTrailers(model: { name: string; id?: string; role?: string; fallbackFor?: string }): string {
  const lines = [`Model: ${oneLine(model.name)}${model.id && model.id !== model.name ? ` (${oneLine(model.id)})` : ''}`]
  if (model.role) lines.push(`Model-Role: ${oneLine(model.role)}`)
  if (model.fallbackFor) lines.push(`Model-Fallback-For: ${oneLine(model.fallbackFor)}`)
  return lines.join('\n')
}

/** Appends the model trailers to a commit message, separated by a blank line. */
export function withModelTrailers(message: string, model: Parameters<typeof modelTrailers>[0]): string {
  return `${message.trimEnd()}\n\n${modelTrailers(model)}`
}
