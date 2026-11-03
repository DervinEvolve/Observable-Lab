/**
 * The git identity for every commit the lab writes to its repositories
 * (AI-Agent contributions, North/GLM branches, Research-Lab records).
 *
 * Commits are authored and committed by the project owner's GitHub noreply
 * address. The model that produced a change is named in the commit message
 * trailers instead, so the author field never claims a domain or mailbox that
 * the project does not control.
 */

export interface CommitAuthor {
  name: string
  email: string
}

export const LAB_COMMIT_IDENTITY: Readonly<CommitAuthor> = Object.freeze({
  name: 'DervinEvolve',
  email: '39844362+DervinEvolve@users.noreply.github.com',
})

/** The author/committer pair for a GitHub contents API request body. */
export function labCommitIdentityFields(): { author: CommitAuthor; committer: CommitAuthor } {
  return { author: { ...LAB_COMMIT_IDENTITY }, committer: { ...LAB_COMMIT_IDENTITY } }
}

const oneLine = (value: string) => value.replace(/[\r\n]+/g, ' ').trim().slice(0, 120)

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
