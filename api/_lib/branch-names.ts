/**
 * Branch names for the AI-Agent repository.
 *
 * Branch names end up in GitHub ref URLs (`/git/refs/heads/<name>`), and the
 * epoch pipeline used to build them from model output. A value such as
 * `x/../main` collapses to `heads/main` once the URL is normalised, so a
 * hallucinated or injected mutation could delete or reset `main`.
 *
 * Every branch the lab creates, deletes or reads is now one of two exact,
 * server-built shapes:
 *   epoch-<epoch>-<target>-<index>   (main pipeline; target from MUTATION_TARGETS)
 *   north/exp-<epoch>[-glm]          (North wildcard runs)
 * Anything else is refused before a request is made.
 */
import { isMutationTarget, MUTATION_TARGETS } from './types.js'

const MAX_EPOCH = 999_999_999
const MAX_MUTATION_INDEX = 999

const EPOCH_BRANCH = new RegExp(
  `^epoch-(0|[1-9]\\d{0,8})-(${MUTATION_TARGETS.join('|')})-(0|[1-9]\\d{0,2})$`
)
const NORTH_BRANCH = /^north\/exp-(0|[1-9]\d{0,8})(-glm)?$/

/**
 * General ref-name hygiene: a strict character set, no `..`, no empty or
 * repeated `/` segments, no leading `-`, `.` or `/`, no `.lock` suffix.
 */
export function assertSafeRefName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 100) {
    throw new Error('Refusing branch name: empty, not a string, or too long')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)) {
    throw new Error('Refusing branch name: characters outside [A-Za-z0-9._/-] or a leading separator')
  }
  if (name.includes('..') || name.includes('//') || name.endsWith('/') || name.endsWith('.') ||
      name.endsWith('.lock') || name.split('/').some(part => part.startsWith('.') || part.startsWith('-'))) {
    throw new Error('Refusing branch name: dot-dot, empty segment, or a segment starting with "." or "-"')
  }
}

/** True only for the two exact branch shapes the lab itself creates. */
export function isManagedBranchName(name: unknown): name is string {
  if (typeof name !== 'string') return false
  return EPOCH_BRANCH.test(name) || NORTH_BRANCH.test(name)
}

/** Throws unless `name` is safe and one of the lab's own branch shapes. */
export function assertManagedBranchName(name: unknown): asserts name is string {
  assertSafeRefName(name)
  if (!isManagedBranchName(name)) {
    throw new Error('Refusing branch name: not an epoch-<n>-<target>-<i> or north/exp-<n> branch')
  }
}

function assertCounter(value: unknown, max: number, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`Refusing branch name: ${label} must be an integer between 0 and ${max}`)
  }
}

/** Branch for one approved spec mutation. `target` and `index` come from model output. */
export function contributionBranchName(epochNumber: unknown, target: unknown, mutationIndex: unknown): string {
  assertCounter(epochNumber, MAX_EPOCH, 'epoch')
  assertCounter(mutationIndex, MAX_MUTATION_INDEX, 'mutation index')
  if (!isMutationTarget(target)) {
    throw new Error(`Refusing branch name: mutation target must be one of ${MUTATION_TARGETS.join(', ')}`)
  }
  const name = `epoch-${epochNumber}-${target}-${mutationIndex}`
  assertManagedBranchName(name)
  return name
}

/** Branch for a North wildcard run, optionally paired with GLM. */
export function northBranchName(epochNumber: unknown, pairedWithGlm = false): string {
  assertCounter(epochNumber, MAX_EPOCH, 'epoch')
  const name = `north/exp-${epochNumber}${pairedWithGlm ? '-glm' : ''}`
  assertManagedBranchName(name)
  return name
}

/** Encode each `/`-separated segment so a ref can never add path segments to a URL. */
export function encodeRefPath(name: string): string {
  return name.split('/').map(encodeURIComponent).join('/')
}
