import type { VercelRequest, VercelResponse } from '@vercel/node'
import { isAdapterSlug } from '../_lib/tinker.js'
import { addressHash, countVisitorMessage, utcDay } from '../_lib/tinker-store.js'
import { lessonQuestionsBySlug, lessonRecordBySlug } from '../_lib/tinker-tutor-public.js'

// GET /api/experiment/lesson?slug=<slug>               the whole record of one Socratic lesson
// GET /api/experiment/lesson?slug=<slug>&subskill=<i>  one subskill's questions, graded answers and turns
//
// Public and read-only. Built from stored rows only (api/_lib/tinker-tutor-public.ts):
// no model or runner is called, and there is no checkpoint path, salt or call id
// in it. Every text is cleaned and cut on the server.

/** Requests one address may make in a UTC day. Counted by a keyed hash of the address; the address is never stored. */
export const LESSON_ROUTE_PER_DAY = 3000

function header(req: VercelRequest, name: string): string {
  const v = req.headers?.[name]
  return typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : ''
}

function visitorAddress(req: VercelRequest): string {
  const real = header(req, 'x-real-ip').trim()
  if (real) return real.slice(0, 80)
  return header(req, 'x-forwarded-for').split(',')[0].trim().slice(0, 80) || 'unknown'
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Cache-Control', 'no-store')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  const slug = typeof req.query?.slug === 'string' ? req.query.slug : ''
  const rawIndex = req.query?.subskill
  if (!isAdapterSlug(slug) || (rawIndex !== undefined && (typeof rawIndex !== 'string' || !/^[0-9]{1,2}$/.test(rawIndex)))) {
    res.setHeader('Cache-Control', 'no-store')
    return res.status(400).json({ error: 'slug must be a lesson id like e41-0a1b2c3d, and subskill a whole number' })
  }
  try {
    const now = new Date()
    if (!(await countVisitorMessage(addressHash(visitorAddress(req), now), `ld:${utcDay(now)}`, LESSON_ROUTE_PER_DAY))) {
      res.setHeader('Cache-Control', 'no-store')
      return res.status(429).json({ error: 'Too many requests from this address today' })
    }
    const record = await lessonRecordBySlug(slug, now)
    if (!record) {
      res.setHeader('Cache-Control', 'no-store')
      return res.status(404).json({ error: 'No such lesson' })
    }
    const open = record.status === 'running'
    // Open: the browser keeps nothing and the CDN keeps it ten seconds. Closed: it no longer changes.
    if (open) {
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('CDN-Cache-Control', 'max-age=10')
    } else res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60')
    if (rawIndex === undefined) return res.status(200).json(record)
    const questions = await lessonQuestionsBySlug(slug, Number(rawIndex))
    if (questions === 'bad_index') {
      res.setHeader('Cache-Control', 'no-store')
      return res.status(400).json({ error: 'this lesson has no subskill with that number' })
    }
    if (!questions) {
      res.setHeader('Cache-Control', 'no-store')
      return res.status(404).json({ error: 'No such lesson' })
    }
    return res.status(200).json(questions)
  } catch (e) {
    console.error('[lesson] could not read a lesson:', e instanceof Error ? e.message : e)
    res.setHeader('Cache-Control', 'no-store')
    return res.status(500).json({ error: 'Could not read the lesson' })
  }
}
