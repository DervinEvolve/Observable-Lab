import { createHash, timingSafeEqual } from 'node:crypto'
import type { VercelRequest, VercelResponse } from '@vercel/node'

type SecretName = 'LAB_OPERATOR_SECRET' | 'CRON_SECRET'

// These secrets belong to server-side operators, never the browser bundle.
export function requireBearer(
  req: VercelRequest,
  res: VercelResponse,
  secretName: SecretName = 'LAB_OPERATOR_SECRET'
): boolean {
  res.setHeader('Cache-Control', 'no-store')
  const expected = process.env[secretName]
  if (!expected || expected.length < 32) {
    res.status(503).json({ error: 'Operator access is not configured' })
    return false
  }

  const header = req.headers.authorization
  const supplied = typeof header === 'string' ? header : ''
  const digest = (value: string) => createHash('sha256').update(value).digest()
  if (!timingSafeEqual(digest(supplied), digest(`Bearer ${expected}`))) {
    res.setHeader('WWW-Authenticate', 'Bearer')
    res.status(401).json({ error: 'Unauthorized' })
    return false
  }
  return true
}
