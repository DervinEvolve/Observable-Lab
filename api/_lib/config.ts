/**
 * Required server configuration.
 *
 * Endpoints, GitHub owners and Modal workspaces have no built-in defaults:
 * a deployment that leaves one unset must fail with a clear message instead
 * of sending its tokens and generated code to someone else's services.
 * Values are read when they are used, so unrelated routes keep working.
 */
export function requireEnv(name: string, purpose: string): string {
  const value = (process.env[name] || '').trim()
  if (!value) {
    throw new Error(`${name} is not set. It is required for ${purpose}; see .env.example.`)
  }
  return value
}

/** A required https:// URL with no credentials or query string in it. */
export function requireHttpsUrl(name: string, purpose: string): string {
  const value = requireEnv(name, purpose)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} is not a valid URL. It is required for ${purpose}; see .env.example.`)
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search) {
    throw new Error(`${name} must be an https:// URL without credentials or a query string.`)
  }
  return value
}

/** GitHub owner and repository names: letters, digits, "-", "_" and ".". */
export function requireGitHubName(name: string, purpose: string, fallback?: string): string {
  const value = (process.env[name] || '').trim() || fallback || requireEnv(name, purpose)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value) || value.includes('..')) {
    throw new Error(`${name} is not a valid GitHub owner or repository name.`)
  }
  return value
}
