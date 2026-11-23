// The Commentator's speaking tube glows when a visitor really gets a reply
// from a trained model (docs/TOOLS.md, "Talking to a trained adapter").
//
// What it is drawn from:
//   - trained_chat_activity on the room's state: the server's own record of
//     the newest good reply and how many there were today. No text, no
//     visitor, no cost.
//   - this visitor's own reply, the moment the panel really receives one.
//
// Nothing here makes up activity. There is no timer and no random number:
// the glow is a function of the age of a stored time, and it is zero when
// there is no stored time.

/** The glow stays full for this long after a reply... */
export const GLOW_FULL_SECONDS = 90
/** ...falls in a straight line, and is gone at this age. */
export const GLOW_END_SECONDS = 120

const SLUG = /^e[0-9]{1,6}-[0-9a-f]{8}$/

export interface ChatActivity {
  /** The server's clock when it built the field, in ms. */
  serverNowMs: number
  /** Good replies since 00:00 UTC. */
  today: number
  adapter: string
  /** When the newest good reply was made, in ms. */
  atMs: number
}

function isoMs(v: unknown): number | null {
  if (typeof v !== 'string' || v.length > 40) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

/** The public field, strictly read. Anything malformed is null: the tube stays dark. */
export function parseChatActivity(raw: unknown): ChatActivity | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const last = o.last
  if (!last || typeof last !== 'object' || Array.isArray(last)) return null
  const l = last as Record<string, unknown>
  const serverNowMs = isoMs(o.now)
  const atMs = isoMs(l.at)
  if (serverNowMs === null || atMs === null) return null
  if (typeof o.today !== 'number' || !Number.isInteger(o.today) || o.today < 0 || o.today > 1e7) return null
  if (typeof l.adapter !== 'string' || !SLUG.test(l.adapter)) return null
  return { serverNowMs, today: o.today, adapter: l.adapter, atMs }
}

/**
 * How bright the cue is for a reply of this age, 0 to 1. No event is 0.
 * Normal motion: steady, then a straight fade. Reduced motion: steady, then
 * a step to nothing. Never a pulse.
 */
export function tubeGlow(ageSeconds: number | null, reducedMotion: boolean): number {
  if (ageSeconds === null || !Number.isFinite(ageSeconds)) return 0
  const age = Math.max(0, ageSeconds)
  if (age >= GLOW_END_SECONDS) return 0
  if (age <= GLOW_FULL_SECONDS || reducedMotion) return 1
  return (GLOW_END_SECONDS - age) / (GLOW_END_SECONDS - GLOW_FULL_SECONDS)
}

/**
 * Age in seconds of the server's newest reply: the age the server measured
 * when it built the field, plus the time since this page received it (read
 * from one monotonic clock, so the page's own wall clock is not trusted).
 */
export function activityAge(activity: ChatActivity, receivedAtPerfMs: number, perfNowMs: number): number {
  const atReceipt = Math.max(0, (activity.serverNowMs - activity.atMs) / 1000)
  return atReceipt + Math.max(0, perfNowMs - receivedAtPerfMs) / 1000
}

/** The newer of two ages (the smaller), ignoring one that does not exist. */
export function newestAge(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.min(a, b)
}

// Where the tube's mouth is, from how the stations are laid out in
// entities/Station.ts: five stations on a ring of STATION_RADIUS, the
// Commentator fifth, turned to face the middle; the flare is at local
// (-0.65, 1.12, -0.1) with its mouth a little above.
const STATION_RADIUS = 5.5
const COMMENTATOR_INDEX = 4
const MOUTH_LOCAL = { x: -0.65, y: 1.17, z: -0.1 }

export function tubeMouthPosition(): { x: number; y: number; z: number } {
  const angle = (COMMENTATOR_INDEX * 2 * Math.PI) / 5 - Math.PI / 2
  const rotY = -angle - Math.PI / 2
  const c = Math.cos(rotY)
  const s = Math.sin(rotY)
  return {
    x: Math.cos(angle) * STATION_RADIUS + MOUTH_LOCAL.x * c + MOUTH_LOCAL.z * s,
    y: MOUTH_LOCAL.y,
    z: Math.sin(angle) * STATION_RADIUS - MOUTH_LOCAL.x * s + MOUTH_LOCAL.z * c,
  }
}
