import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getRun, addressHash, countVisitorMessage, fromVisitorOffers, utcDay, visitorHash } from '../_lib/tinker-store.js'
import { header, readBody, sentAsJson, visitorAddress } from '../_lib/trained-chat.js'
import {
  OFFERS_PER_ADAPTER_DAY, OFFERS_PER_ADDRESS_DAY, OFFERS_PER_VISITOR_DAY, OFFER_MAX_BODY_BYTES, OFFER_MESSAGES, WITHDRAW_TRIES_PER_DAY,
  codeSha256, firstUserSha256, newOfferCode, offerExpiry, readOfferCode, readOfferRequest, screenOffer, transcriptSha256, verifyReceipt,
  visitorOffersMax, visitorOffersPerDay, visitorOffersStatus,
} from '../_lib/visitor-offers.js'
import { capCounterName, countOfferCap, insertOffer, storedOfferCount, withdrawOffer } from '../_lib/visitor-offers-store.js'

// POST /api/experiment/chat-offer   (public, JSON only, body at most 32 KB)
//   { adapter, messages, receipt }  offers a conversation from the visitor chat to the lab
//   { withdraw: "XXXX-XXXX-XXXX" }  takes an offer back by its code
//
// An offer is stored only when its receipt proves that every reply in it
// came from the lab's own chat endpoint, in order (visitor-offers.ts), and
// only when the screening finds nothing it looks for. Nothing that identifies
// the sender is written beside it: the visitor limits are counted by the
// chat's daily keyed hashes, in the chat's own table. No log line here
// carries text a visitor wrote.
//
// While offers are off this answers 503 without touching the database; a
// take back still works, so a visitor can always take an offer back.
function say(res: VercelResponse, status: number, error: string, message: string, extra: Record<string, unknown> = {}) {
  return res.status(status).json({ error, ...extra, message })
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' })
  if (!sentAsJson(req)) return say(res, 415, 'unsupported_media_type', 'Send the request as JSON.')
  let raw: unknown
  try {
    raw = readBody(req)
  } catch {
    return say(res, 400, 'invalid_request', 'The request is not valid JSON.')
  }
  let size = 0
  try { size = Buffer.byteLength(JSON.stringify(raw ?? null), 'utf8') } catch { size = Infinity }
  if (size > OFFER_MAX_BODY_BYTES) return say(res, 413, 'too_long', 'The request is too large.')

  const isWithdraw = Boolean(raw && typeof raw === 'object' && !Array.isArray(raw) && 'withdraw' in (raw as Record<string, unknown>))
  if (!isWithdraw && !visitorOffersStatus().enabled) return say(res, 503, 'off', OFFER_MESSAGES.off)

  const read = readOfferRequest(raw)
  if (!read.ok) return say(res, read.status, read.error, read.message)
  const now = new Date()
  const ip = visitorAddress(req)
  const day = utcDay(now)

  // ---- take back ----
  if (read.kind === 'withdraw') {
    try {
      if (!(await countVisitorMessage(addressHash(ip, now), `ow:${day}`, WITHDRAW_TRIES_PER_DAY))) return say(res, 429, 'tries', OFFER_MESSAGES.tries)
      const done = await withdrawOffer(codeSha256(read.code))
      if (!done.found) return say(res, 404, 'unknown_code', OFFER_MESSAGES.unknown_code)
      // A run that has claimed the text, started or not, may train on it: say so.
      return res.status(200).json({ withdrawn: true, trained_on: done.trained_on, message: done.trained_on ? OFFER_MESSAGES.withdrawnTrained : OFFER_MESSAGES.withdrawn })
    } catch {
      console.warn('[chat-offer] could not take an offer back')
      return say(res, 503, 'unavailable', OFFER_MESSAGES.unavailable)
    }
  }

  // ---- an offer ----
  // Proof first, then the screening: both are pure, and neither touches the database.
  if (!verifyReceipt(read.receipt, read.adapter, read.messages, now)) return say(res, 403, 'not_verified', OFFER_MESSAGES.not_verified)
  const screen = screenOffer(read.messages)
  if (!screen.ok) return say(res, 422, 'screened', OFFER_MESSAGES[screen.reason], { reason: screen.reason })

  // A day cap of 0 takes no offer at all (LAB_VISITOR_OFFERS_PER_DAY=0), before anything is counted.
  if (visitorOffersPerDay() < 1) return say(res, 429, 'full', OFFER_MESSAGES.full)

  try {
    // One visitor's share: the address alone first (it is the limit a sender
    // cannot get around), then the address with the browser string.
    for (const [who, perDay] of [[addressHash(ip, now), OFFERS_PER_ADDRESS_DAY], [visitorHash(ip, header(req, 'user-agent'), now), OFFERS_PER_VISITOR_DAY]] as const) {
      if (!(await countVisitorMessage(who, `od:${day}`, perDay))) return say(res, 429, 'day', OFFER_MESSAGES.day)
    }
    const run = await getRun(read.adapter)
    if (!run) return say(res, 404, 'gone', OFFER_MESSAGES.gone)
    if ((await storedOfferCount()) >= visitorOffersMax()) return say(res, 429, 'full', OFFER_MESSAGES.full)
    // The day caps are counted where no time is kept, so the first offer of a day leaves no timed row beside the sender's.
    if (!(await countOfferCap(capCounterName('all'), day, visitorOffersPerDay()))) return say(res, 429, 'full', OFFER_MESSAGES.full)
    if (!(await countOfferCap(capCounterName('adapter', read.adapter), day, OFFERS_PER_ADAPTER_DAY))) return say(res, 429, 'adapter_day', OFFER_MESSAGES.adapter_day)

    const code = newOfferCode()
    const expiresAt = offerExpiry(day)
    const stored = await insertOffer({
      day, adapter: read.adapter, baseModel: run.base_model, messages: read.messages,
      transcriptSha256: transcriptSha256(read.messages), codeSha256: codeSha256(readOfferCode(code) ?? code), firstUserSha256: firstUserSha256(read.messages),
      adapterFromVisitors: fromVisitorOffers(run), expiresAt,
    })
    if (stored === 'duplicate') return say(res, 409, 'already_offered', OFFER_MESSAGES.already_offered)
    return res.status(201).json({ offered: true, code, kept_until: expiresAt, message: OFFER_MESSAGES.stored })
  } catch {
    console.warn('[chat-offer] could not store an offer')
    return say(res, 503, 'unavailable', OFFER_MESSAGES.unavailable)
  }
}
