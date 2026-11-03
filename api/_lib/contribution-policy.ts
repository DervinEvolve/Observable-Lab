// Keep generated changes away from workflows, dependency hooks, and configuration.
// Paths come from model output, so check the type and use a strict character
// set per segment before any of them reaches a GitHub contents URL.
export function assertContributionPath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 200) {
    throw new Error('Generated contribution path is missing, not a string, or too long')
  }
  const parts = path.split('/')
  const safe = parts.every(part => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part) && !part.includes('..'))
  const allowedRoot = ['src', 'test', 'tests', 'docs'].includes(parts[0]) && parts.length > 1
  const allowedExtension = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|txt|css)$/.test(path)
  if (!safe || (!(allowedRoot && allowedExtension) && path !== 'README.md')) {
    throw new Error('Generated contribution path is outside the allowed source and test directories')
  }
}
