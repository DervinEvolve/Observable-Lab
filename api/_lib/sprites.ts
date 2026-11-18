/**
 * Small client for Sprites (sprites.dev), the per-model cloud sandboxes.
 *
 * Each panel model, plus North and GLM, has one persistent sprite named
 * observable-<key>. The lab uses them for one thing: after a model's code
 * contribution is pushed to AI-Agent, the author's sprite checks out that
 * branch and runs the repository's tests. The result is extra evidence shown
 * to viewers; GitHub Actions CI (LAB_REQUIRED_CI_WORKFLOW_IDS) stays the
 * only merge gate.
 *
 * Rules kept here:
 * - No secret ever goes into a sprite. Arguments and env values are checked
 *   against this server's own credentials before a request is sent, and the
 *   repository is cloned over plain https (it is public). The one thing
 *   shaped like a credential a sprite may receive is the lab's own scoped
 *   model key (live-model-keys.ts): short lived, capped, made for one Sprite
 *   session, and never one of this server's secrets. It has its own option
 *   on execInSprite and nothing else can set an API key variable.
 * - Egress is limited at creation to the Sprites "defaults" preset (GitHub,
 *   npm and the usual registries), so a sprite can clone and install but not
 *   wander. A Sprite session with the lab model endpoint on also allows the
 *   lab's own host for as long as the session runs.
 * - The HTTP exec response format is not documented, so the body is read
 *   defensively (plain text or JSON) and the exit status comes from a marker
 *   the wrapper script prints, never from an assumed field.
 *
 * API facts used (docs.fly.io/sprites): base https://api.sprites.dev/v1,
 * Authorization: Bearer SPRITES_TOKEN; POST /sprites {name}; GET and DELETE
 * /sprites/{name} (status cold|warm|running); POST /sprites/{name}/exec with
 * query params cmd (repeated), path, dir, env (repeated KEY=VALUE);
 * POST /sprites/{name}/policy/network {rules}.
 */
import { randomBytes } from 'node:crypto'
import { WILDCARD_MODELS } from './types.js'
import { requireGitHubName } from './config.js'
import { assertManagedBranchName } from './branch-names.js'

const SPRITES_API_BASE = 'https://api.sprites.dev/v1'
const SPRITE_HOME = '/home/sprite'

export const SPRITE_KEYS = ['gemini', 'deepseek', 'claude', 'gpt', 'grok', 'north', 'glm'] as const
export type SpriteKey = (typeof SPRITE_KEYS)[number]

export type SpriteStatus = 'cold' | 'warm' | 'running' | 'not_created' | 'error'

export interface SpriteInfo {
  key: SpriteKey
  name: string
  status: SpriteStatus
  detail?: string
}

/** Hard limits for a contribution check (in-sprite timeout, then the HTTP wait). */
export const CHECK_TIMEOUT_S = 150
/** Stored output: the last 4 KB. */
export const OUTPUT_TAIL_BYTES = 4096

export function spriteName(key: SpriteKey): string {
  return `observable-${key}`
}

export function isSpriteKey(value: unknown): value is SpriteKey {
  return typeof value === 'string' && (SPRITE_KEYS as readonly string[]).includes(value)
}

// Provider prefix -> sprite. Keyed by lab, not model version, so a panel
// upgrade (or a fallback from the same lab) lands in the same sandbox.
const PROVIDER_SPRITES: Record<string, SpriteKey> = {
  google: 'gemini',
  deepseek: 'deepseek',
  anthropic: 'claude',
  openai: 'gpt',
  'x-ai': 'grok',
  cohere: 'north',
  'z-ai': 'glm',
}

/** The sprite for an OpenRouter model id (or a bare sprite key), or null if it has none. */
export function spriteKeyForModel(modelId: string): SpriteKey | null {
  if (isSpriteKey(modelId)) return modelId
  if (modelId === WILDCARD_MODELS.north) return 'north'
  if (modelId === WILDCARD_MODELS.glm) return 'glm'
  const provider = modelId.split('/')[0]
  return PROVIDER_SPRITES[provider] ?? null
}

export function spritesConfigured(): boolean {
  return Boolean((process.env.SPRITES_TOKEN || '').trim())
}

function spritesToken(): string {
  const token = (process.env.SPRITES_TOKEN || '').trim()
  if (!token) throw new Error('SPRITES_TOKEN is not set')
  return token
}

async function spritesFetch(path: string, init: RequestInit = {}, timeoutMs = 20000): Promise<Response> {
  return fetch(`${SPRITES_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${spritesToken()}`,
      ...(init.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  })
}

// Short, single-line error text from a failed response. Never echoes headers.
async function failure(res: Response, what: string): Promise<Error> {
  let body = ''
  try { body = (await res.text()).replace(/\s+/g, ' ').slice(0, 200) } catch { /* ignore */ }
  return new Error(`${what} failed: HTTP ${res.status}${body ? ` ${sanitizeOutput(body)}` : ''}`)
}

// ---- lifecycle ----

export async function getSpriteStatus(key: SpriteKey): Promise<SpriteInfo> {
  const name = spriteName(key)
  try {
    const res = await spritesFetch(`/sprites/${name}`)
    if (res.status === 404) return { key, name, status: 'not_created' }
    if (!res.ok) return { key, name, status: 'error', detail: `HTTP ${res.status}` }
    const data = await res.json().catch(() => null) as { status?: unknown } | null
    const status = data?.status
    if (status === 'cold' || status === 'warm' || status === 'running') return { key, name, status }
    return { key, name, status: 'error', detail: 'unexpected status in response' }
  } catch (e) {
    return { key, name, status: 'error', detail: e instanceof Error ? e.message : 'request failed' }
  }
}

const PLAIN_HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/

/**
 * The egress rules for a sprite: the Sprites "defaults" preset, plus an exact
 * allow rule for each extra host. Rule format from the Sprites networking
 * docs (docs.fly.io/sprites/concepts/networking): { include: "defaults" } and
 * { domain: "example.com", action: "allow" }. Only plain host names are
 * accepted: no wildcard, port, path or IP address.
 */
export function networkPolicyRules(extraHosts: string[] = []): Array<Record<string, string>> {
  const rules: Array<Record<string, string>> = [{ include: 'defaults' }]
  for (const host of extraHosts) {
    if (!PLAIN_HOST.test(host) || /^[0-9.]+$/.test(host)) throw new Error('Refusing a network rule that is not a plain host name')
    rules.push({ domain: host, action: 'allow' })
  }
  return rules
}

/**
 * Egress allowlist: the Sprites "defaults" preset only (GitHub, npm, PyPI, ...),
 * plus `extraHosts` when given. With extra hosts the answer is read back and
 * the call throws unless every one of them is in the policy the sprite now
 * has, so a caller can rely on it before handing anything to the sprite.
 */
export async function applyNetworkPolicy(key: SpriteKey, extraHosts: string[] = []): Promise<void> {
  const rules = networkPolicyRules(extraHosts)
  const path = `/sprites/${spriteName(key)}/policy/network`
  const res = await spritesFetch(path, { method: 'POST', body: JSON.stringify({ rules }) })
  if (!res.ok) throw await failure(res, 'set network policy')
  if (!extraHosts.length) return
  const allows = (data: unknown): boolean => {
    const got = data && typeof data === 'object' ? (data as { rules?: unknown }).rules : null
    return Array.isArray(got) && extraHosts.every(host =>
      got.some(r => r && typeof r === 'object' && (r as Record<string, unknown>).domain === host && (r as Record<string, unknown>).action === 'allow'))
  }
  if (allows(await res.json().catch(() => null))) return
  const check = await spritesFetch(path)
  if (!check.ok || !allows(await check.json().catch(() => null))) {
    throw new Error('set network policy failed: the sprite did not confirm the extra host rule')
  }
}

/**
 * Create the sprite if it does not exist yet, then (re)apply the network
 * policy. Reapplying is one cheap request and also covers sprites created
 * before the policy existed. Throws if the sprite cannot be made usable.
 */
export async function ensureSprite(key: SpriteKey): Promise<SpriteInfo & { created: boolean }> {
  let info = await getSpriteStatus(key)
  let created = false
  if (info.status === 'not_created') {
    const res = await spritesFetch('/sprites', { method: 'POST', body: JSON.stringify({ name: info.name }) })
    // A concurrent create can lose the race; the re-read below decides.
    if (!res.ok && res.status !== 409) throw await failure(res, `create ${info.name}`)
    created = res.ok
    info = await getSpriteStatus(key)
  }
  if (info.status === 'not_created' || info.status === 'error') {
    throw new Error(`${info.name} is not available (${info.status}${info.detail ? `: ${info.detail}` : ''})`)
  }
  await applyNetworkPolicy(key)
  return { ...info, created }
}

export async function deleteSprite(key: SpriteKey): Promise<void> {
  const res = await spritesFetch(`/sprites/${spriteName(key)}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) throw await failure(res, `delete ${spriteName(key)}`)
}

// ---- secrets never leave this server ----

const SECRET_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE|CREDENTIAL|DATABASE_URL|POSTGRES|_KEY$)/i

function serverSecretValues(): string[] {
  return Object.entries(process.env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === 'string' && value.trim().length >= 8)
    .map(([, value]) => (value as string).trim())
}

/**
 * The lab's scoped model key (live-model-keys.ts): "labk_" and 64 hex
 * characters. It is random, stored by the server only as a hash, and is not
 * one of this server's secrets, so it is the single credential-shaped value
 * execInSprite will pass on, and only through its `scopedModelKey` option.
 */
export const SCOPED_MODEL_KEY = /^labk_[0-9a-f]{64}$/
/** The variables that option sets. No other path may set a name like these. */
export const SCOPED_MODEL_KEY_ENV = ['LAB_MODEL_BASE_URL', 'LAB_MODEL_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_KEY'] as const

/** Throws if any string about to be sent into a sprite carries one of this server's credentials. */
export function assertNoSecrets(values: string[]): void {
  const secrets = serverSecretValues()
  for (const value of values) {
    if (secrets.some(secret => value.includes(secret))) {
      throw new Error('Refusing to send a server credential into a sprite')
    }
  }
}

// ---- output hygiene ----

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g

/**
 * Text that is safe to show viewers: ANSI codes and control characters
 * stripped, and anything that looks like a credential replaced. This server's
 * own secret values are removed verbatim as well.
 */
export function sanitizeOutput(text: string): string {
  let out = String(text ?? '')
    .replace(ANSI, '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
  for (const secret of serverSecretValues()) out = out.split(secret).join('[redacted]')
  out = out
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted]')
    .replace(/\blabk_[0-9a-f]{16,}/g, '[redacted]')
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [redacted]')
    .replace(/\b([A-Za-z0-9_]{0,40}?(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY)[A-Za-z0-9_]{0,40})([ \t]{0,4}[=:][ \t]{0,4})["']?[^\s"']{4,}["']?/gi, '$1$2[redacted]')
    .replace(/\b(postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?):\/\/\S+/gi, '$1://[redacted]')
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1[redacted]@')
    // Long random-looking runs (mixed case and digits). Plain hex such as a
    // commit SHA has no capitals and is kept.
    .replace(/[A-Za-z0-9]{32,}/g, run => (/[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run) ? '[redacted]' : run))
  return out
}

/** The last `maxBytes` of UTF-8 text, cut at a line start when one is close. */
export function tailBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  let tail = buf.subarray(buf.length - maxBytes).toString('utf8').replace(/^�+/, '')
  const nl = tail.indexOf('\n')
  if (nl >= 0 && nl < 200) tail = tail.slice(nl + 1)
  return tail
}

// ---- exec ----

export interface ExecOptions {
  dir?: string
  env?: Record<string, string>
  timeoutS?: number      // in-sprite limit; the HTTP wait adds a short grace
  maxOutputBytes?: number
  /**
   * The lab model endpoint for this command: sets LAB_MODEL_BASE_URL and
   * LAB_MODEL_API_KEY, and the same two as OPENAI_BASE_URL and OPENAI_API_KEY.
   * The key must be a scoped model key and the URL plain https; the usual
   * check against this server's own credentials still runs on both.
   */
  scopedModelKey?: { baseUrl: string; key: string }
}

export interface ExecResult {
  exitCode: number | null // null: no trustworthy exit status came back
  output: string          // stdout and stderr together, tail only
  durationMs: number
  timedOut: boolean
  truncated: boolean
}

/**
 * Pull output text and any exit code out of an exec response body whose
 * format is not documented: plain text, a JSON string, or a JSON object with
 * stdout/stderr/output fields.
 */
export function parseExecBody(body: string, contentType = ''): { output: string; exitCode: number | null } {
  const trimmed = body.trim()
  if (contentType.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('"')) {
    try {
      const data = JSON.parse(trimmed) as unknown
      if (typeof data === 'string') return { output: data, exitCode: null }
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const obj = data as Record<string, unknown>
        const text = ['stdout', 'output', 'result', 'stderr']
          .map(k => obj[k])
          .filter((v): v is string => typeof v === 'string' && v.length > 0)
          .join('\n')
        const code = ['exit_code', 'exitCode', 'exit_status', 'code']
          .map(k => obj[k])
          .find((v): v is number => typeof v === 'number' && Number.isInteger(v))
        return { output: text, exitCode: code ?? null }
      }
    } catch { /* not JSON after all: fall through to plain text */ }
  }
  return { output: body, exitCode: null }
}

/**
 * Find the wrapper's exit marker (the last one) and remove it from the output.
 * Returns null when it is missing, e.g. the process was killed before it ran.
 * Line endings and control bytes are evened out first: the exec endpoint can
 * answer with terminal style \r\n lines or stream framing bytes, and before
 * this every real run came back as "no exit status" with the marker in plain
 * sight.
 */
export function takeExitMarker(raw: string, nonce: string): { output: string; exitCode: number | null } {
  const output = raw.replace(ANSI, '').replace(/\r\n?/g, '\n').replace(CONTROL, '')
  const marker = new RegExp(`(?:^|\\n)__EXIT_${nonce}:(\\d{1,3})[ \\t]*(?=\\n|$)`, 'g')
  let last: RegExpExecArray | null = null
  for (let m = marker.exec(output); m; m = marker.exec(output)) last = m
  if (!last) return { output, exitCode: null }
  const cleaned = output.slice(0, last.index) + output.slice(last.index + last[0].length)
  return { output: cleaned.replace(/\n+$/, ''), exitCode: Number(last[1]) }
}

// /bin/sh wrapper. $1 = time limit (s), $2 = the script. The script runs in a
// login bash (so the preinstalled toolchains are on PATH) under coreutils
// timeout when available; stderr is folded into stdout and the real exit
// status is printed last behind a per-call marker.
function wrapperScript(nonce: string): string {
  return [
    '( if command -v timeout >/dev/null 2>&1; then timeout -k 5 "$1" bash -lc "$2"; else bash -lc "$2"; fi ) 2>&1',
    // On its own line even when the output did not end with a newline.
    `s=$?; printf '\\n__EXIT_${nonce}:%s\\n' "$s"`,
  ].join('\n')
}

/** Run a bash script in a sprite over the HTTP exec endpoint. Throws only on transport/API errors. */
export async function execInSprite(key: SpriteKey, script: string, opts: ExecOptions = {}): Promise<ExecResult> {
  const timeoutS = Math.max(5, Math.min(Math.floor(opts.timeoutS ?? 60), 600))
  const maxOutputBytes = opts.maxOutputBytes ?? 64 * 1024
  const env: Record<string, string> = { CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0', npm_config_update_notifier: 'false', npm_config_fund: 'false', ...opts.env }
  for (const name of Object.keys(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || SECRET_ENV_NAME.test(name) || (SCOPED_MODEL_KEY_ENV as readonly string[]).includes(name)) {
      throw new Error(`Refusing env name ${name}`)
    }
  }
  // The one exception to "no API key variable": the lab's own scoped model
  // key, and only in its exact format. Added after the name check above, so
  // `opts.env` can never set these names. assertNoSecrets below still runs.
  if (opts.scopedModelKey) {
    const { baseUrl, key: modelKey } = opts.scopedModelKey
    if (!SCOPED_MODEL_KEY.test(modelKey)) throw new Error('Refusing a model key that is not a scoped lab key')
    if (!/^https:\/\/[a-z0-9.-]+(\/[A-Za-z0-9._\/-]*)?$/.test(baseUrl)) throw new Error('Refusing a model base URL that is not plain https')
    env.LAB_MODEL_BASE_URL = baseUrl
    env.LAB_MODEL_API_KEY = modelKey
    env.OPENAI_BASE_URL = baseUrl
    env.OPENAI_API_KEY = modelKey
  }
  const nonce = randomBytes(8).toString('hex')
  const argv = ['/bin/sh', '-c', wrapperScript(nonce), 'lab-exec', String(timeoutS), script]
  const envPairs = Object.entries(env).map(([k, v]) => `${k}=${v}`)
  assertNoSecrets([...argv, ...envPairs, opts.dir || ''])

  const params = new URLSearchParams()
  for (const arg of argv) params.append('cmd', arg)
  params.set('path', '/bin/sh')
  if (opts.dir) params.set('dir', opts.dir)
  for (const pair of envPairs) params.append('env', pair)

  const started = Date.now()
  let res: Response
  try {
    res = await spritesFetch(`/sprites/${spriteName(key)}/exec?${params.toString()}`, { method: 'POST' }, (timeoutS + 10) * 1000)
  } catch (e) {
    const aborted = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
    if (!aborted) throw e
    return { exitCode: null, output: `timed out after ${timeoutS} s (no response from the sprite)`, durationMs: Date.now() - started, timedOut: true, truncated: false }
  }
  if (!res.ok) throw await failure(res, `exec in ${spriteName(key)}`)
  const body = await res.text()
  const durationMs = Date.now() - started
  const parsed = parseExecBody(body, res.headers.get('content-type') || '')
  const marked = takeExitMarker(parsed.output, nonce)
  // Without the marker the wrapper never finished. A non-zero code from the
  // response still means failure; a zero (or nothing) proves nothing.
  const exitCode = marked.exitCode ?? (parsed.exitCode !== null && parsed.exitCode !== 0 ? parsed.exitCode : null)
  // 124 is coreutils timeout; 137 is its follow-up kill, but only counts as a
  // timeout when the limit was really reached (otherwise it is e.g. OOM).
  const timedOut = exitCode === 124 || (exitCode === 137 && durationMs >= timeoutS * 1000)
  const tail = tailBytes(marked.output, maxOutputBytes)
  return { exitCode, output: tail, durationMs, timedOut, truncated: tail.length < marked.output.length }
}

// ---- AI-Agent ----

/** Public clone URL for AI-Agent. Never carries credentials. */
export function aiAgentCloneUrl(): string {
  const explicit = (process.env.AI_AGENT_REPO || '').trim()
  if (explicit) {
    if (!/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}?(\.git)?$/.test(explicit) || explicit.includes('..')) {
      throw new Error('AI_AGENT_REPO must be a plain https://github.com/<owner>/<repo>.git URL')
    }
    return explicit
  }
  const owner = requireGitHubName('AI_AGENT_GITHUB_OWNER', 'the AI-Agent clone URL')
  const repo = requireGitHubName('AI_AGENT_GITHUB_REPO', 'the AI-Agent clone URL', 'AI-Agent')
  return `https://github.com/${owner}/${repo}.git`
}

// Clone (or update) AI-Agent, then install exactly what the lockfile says.
// Dependencies are reinstalled only when the lockfile changes.
const INSTALL_SCRIPT = [
  'if [ -f package-lock.json ]; then',
  '  LOCK=$(sha256sum package-lock.json | cut -c1-64)',
  '  if [ ! -d node_modules ] || [ "$(cat node_modules/.lab-lock 2>/dev/null)" != "$LOCK" ]; then',
  '    npm ci --no-audit --no-fund --loglevel=error',
  '    echo "$LOCK" > node_modules/.lab-lock',
  '  fi',
  'else',
  '  npm install --no-audit --no-fund --loglevel=error',
  'fi',
].join('\n')

export const SETUP_SCRIPT = [
  'set -e',
  `cd ${SPRITE_HOME}`,
  `if command -v flock >/dev/null 2>&1; then exec 9>${SPRITE_HOME}/.lab-check.lock; flock 9; fi`,
  'if [ -d AI-Agent/.git ]; then',
  '  cd AI-Agent && git remote set-url origin "$REPO_URL"',
  '  git fetch --quiet origin main && git checkout --quiet --force main && git reset --quiet --hard origin/main',
  'else',
  '  git clone --quiet "$REPO_URL" AI-Agent && cd AI-Agent',
  'fi',
  'echo "AI-Agent at $(git rev-parse --short HEAD)"',
  INSTALL_SCRIPT,
  'echo "node $(node --version), npm $(npm --version)"',
].join('\n')

// Check out the contribution's exact commit and run the repository's own
// test script (package.json "test": vitest run), as CI does.
export const CHECK_SCRIPT = [
  'set -e',
  `cd ${SPRITE_HOME}`,
  // One checkout per sprite: a second check for the same model waits its turn.
  `if command -v flock >/dev/null 2>&1; then exec 9>${SPRITE_HOME}/.lab-check.lock; flock 9; fi`,
  'if [ ! -d AI-Agent/.git ]; then git clone --quiet "$REPO_URL" AI-Agent; fi',
  'cd AI-Agent',
  'git remote set-url origin "$REPO_URL"',
  'git fetch --quiet --force origin "+refs/heads/$BRANCH:refs/remotes/origin/lab-check"',
  'if [ -n "$HEAD_SHA" ]; then git checkout --quiet --force --detach "$HEAD_SHA"; else git checkout --quiet --force --detach refs/remotes/origin/lab-check; fi',
  'git clean -fdq',
  'echo "$BRANCH at $(git rev-parse --short HEAD)"',
  INSTALL_SCRIPT,
  'npm test',
].join('\n')

/** Operator setup: create the sprite if needed, then clone or update AI-Agent and npm ci. */
export async function setupSprite(key: SpriteKey, timeoutS = 240): Promise<ExecResult & { sprite: string }> {
  const repoUrl = aiAgentCloneUrl()
  await ensureSprite(key)
  const result = await execInSprite(key, SETUP_SCRIPT, { dir: SPRITE_HOME, env: { REPO_URL: repoUrl }, timeoutS })
  return { ...result, output: sanitizeOutput(tailBytes(result.output, 16 * 1024)), sprite: spriteName(key) }
}

export interface SpriteCheck {
  status: 'passed' | 'failed' | 'not_run' | 'error'
  exit_code: number | null    // 0 = tests passed
  duration_ms: number | null
  output_tail: string         // sanitised, at most OUTPUT_TAIL_BYTES
  sprite_name: string | null
  ran_at: string | null       // ISO time; null = nothing ran
}

const notRun = (reason: string, sprite: string | null = null): SpriteCheck =>
  ({ status: 'not_run', exit_code: null, duration_ms: null, output_tail: `not run: ${reason}`, sprite_name: sprite, ran_at: null })

/**
 * Run AI-Agent's tests for one contribution branch in the author model's
 * sprite. Never throws: every failure becomes a record, so an epoch can
 * never be blocked or crashed by a sandbox.
 */
export async function checkContributionInSprite(params: {
  authorModelId: string
  branch: string
  headSha: string | null
  timeoutS?: number
}): Promise<SpriteCheck> {
  if (!spritesConfigured()) return notRun('SPRITES_TOKEN is not set')
  const key = spriteKeyForModel(params.authorModelId)
  if (!key) return notRun(`no sprite for ${params.authorModelId}`)
  const name = spriteName(key)
  const ranAt = new Date().toISOString()
  try {
    assertManagedBranchName(params.branch)
    const headSha = params.headSha && /^[0-9a-f]{40}$/.test(params.headSha) ? params.headSha : ''
    const repoUrl = aiAgentCloneUrl()
    await ensureSprite(key)
    const timeoutS = params.timeoutS ?? CHECK_TIMEOUT_S
    const result = await execInSprite(key, CHECK_SCRIPT, {
      dir: SPRITE_HOME,
      env: { REPO_URL: repoUrl, BRANCH: params.branch, HEAD_SHA: headSha },
      timeoutS,
    })
    let output = result.output
    if (result.timedOut) output += `\ntimed out after ${timeoutS} s`
    // Trim before cleaning so the redaction pass stays small, then trim again.
    const tail = tailBytes(sanitizeOutput(tailBytes(output, OUTPUT_TAIL_BYTES * 2)), OUTPUT_TAIL_BYTES)
    return {
      status: result.exitCode === null ? 'error' : result.exitCode === 0 ? 'passed' : 'failed',
      exit_code: result.exitCode,
      duration_ms: result.durationMs,
      output_tail: tail,
      sprite_name: name,
      ran_at: ranAt,
    }
  } catch (e) {
    const message = sanitizeOutput(e instanceof Error ? e.message : String(e)).slice(0, 300)
    console.warn(`[sprites] check in ${name} failed (non-fatal): ${message}`)
    return { status: 'error', exit_code: null, duration_ms: null, output_tail: `sprite error: ${message}`, sprite_name: name, ran_at: ranAt }
  }
}

/** Status a viewer sees for a stored row. */
export function spriteRunStatus(row: { sprite_exit_code: number | null; sprite_ran_at: string | Date | null }): SpriteCheck['status'] {
  if (!row.sprite_ran_at) return 'not_run'
  if (row.sprite_exit_code === null || row.sprite_exit_code === undefined) return 'error'
  return row.sprite_exit_code === 0 ? 'passed' : 'failed'
}
