/**
 * The lab's rubric engine, for Tinker RL (tinker-rl.ts, docs/TOOLS.md).
 *
 * A model that asks for an RL run writes its tasks and its rubric as data. The
 * rubric is a short list of rules chosen from a fixed menu, each with a
 * weight. The lab's own code scores every completion with it: a rule gives 0
 * or 1, the score is the weighted sum clamped to [0, 1]. No code a model wrote
 * runs anywhere.
 *
 * This file is the TypeScript twin of the rubric engine in
 * modal/tinker_jobs.py. The two are written from the same rules and checked
 * against one file of cases (tests/fixtures/rubric-cases.json) on both sides,
 * so a rubric means the same thing where it is checked and where it scores.
 * Change one, change the other, and add the case.
 *
 * regex_match does not use the language's regular expressions. Those can run
 * for a very long time on a pattern a model wrote (catastrophic
 * backtracking) and neither language can stop them. The lab compiles a small
 * subset itself into an automaton that is stepped over the text once, so the
 * work is the length of the text times the size of the pattern whatever the
 * pattern is. What is left out (lookarounds, back references, lazy and
 * possessive quantifiers, \b) is refused with a reason, not guessed.
 */

export const RUBRIC_TYPES = ['exact_match', 'contains', 'not_contains', 'number_close', 'regex_match', 'json_valid', 'length_between'] as const
export type RubricType = (typeof RUBRIC_TYPES)[number]

export const RUBRIC_MAX_RULES = 8
export const RUBRIC_STRING_MAX = 200
export const RUBRIC_LIST_MAX = 20
export const RUBRIC_REGEX_MAX_LEN = 120
/** Instructions in the compiled automaton, counted after counted repeats are unrolled. */
export const RUBRIC_REGEX_MAX_STATES = 120
export const RUBRIC_REPEAT_MAX = 16
/** Code points of a completion the rubric reads. Longer is cut, the same way everywhere. */
export const RUBRIC_TEXT_MAX = 4000
export const RUBRIC_LENGTH_MAX = 4000
export const RUBRIC_TOLERANCE_MAX = 1e9
export const RUBRIC_SCHEMA_MAX_NODES = 30
export const RUBRIC_SCHEMA_MAX_DEPTH = 4
export const RUBRIC_JSON_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'] as const

export type RubricScope = 'whole' | 'first_line' | 'last_line'
export interface RubricSchema {
  type?: (typeof RUBRIC_JSON_TYPES)[number]
  required?: string[]
  properties?: Record<string, RubricSchema>
  items?: RubricSchema
}

/** Where a rule reads its target from: its own `value`, the task's `expected`, or one key of the task's `data`. */
export type TargetFrom = 'expected' | `data.${string}`

export interface RubricRule {
  type: RubricType
  weight: number
  scope?: RubricScope
  value?: string | number
  from?: string
  any?: string[]
  all?: string[]
  ignore_case?: boolean
  tolerance?: number
  relative?: boolean
  pick?: 'first' | 'last'
  pattern?: string
  schema?: RubricSchema
  min?: number
  max?: number
}
export interface Rubric { rules: RubricRule[] }

export interface RubricTask { prompt: string; expected?: string; data?: Record<string, string | number> }

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const keysOnly = (o: Json, allowed: readonly string[]): string | null => {
  const extra = Object.keys(o).find(k => !allowed.includes(k))
  return extra === undefined ? null : extra.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || '_'
}
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const DATA_KEY = /^[A-Za-z0-9_]{1,24}$/

/** Code points of a string. The two languages count characters the same way only by code point. */
export const points = (s: string): number[] => Array.from(s, c => c.codePointAt(0) as number)
const fromPoints = (p: number[]): string => String.fromCodePoint(...p)

// ---------------------------------------------------------------------------
// Text rules shared by both languages
// ---------------------------------------------------------------------------

const WS = new Set([32, 9, 10, 11, 12, 13])

/** Strips space, tab, newline, vertical tab, form feed and carriage return from both ends and nothing else. */
export function stripWs(s: string): string {
  const p = points(s)
  let a = 0
  let b = p.length
  while (a < b && WS.has(p[a])) a++
  while (b > a && WS.has(p[b - 1])) b--
  return fromPoints(p.slice(a, b))
}

export function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, c => String.fromCharCode(c.charCodeAt(0) + 32))
}

/** NFKC, so full-width letters and non-breaking spaces read as the plain ones. */
const nfkc = (s: string): string => s.normalize('NFKC')

/** Whitespace runs to one space, quotes and ending punctuation off both ends, ASCII letters lower case. */
export function normaliseText(s: string): string {
  const flat: number[] = []
  let space = false
  for (const c of points(nfkc(s))) {
    if (WS.has(c)) { space = true; continue }
    if (space && flat.length) flat.push(32)
    space = false
    flat.push(c)
  }
  const LEAD = new Set([34, 39, 96])
  const TRAIL = new Set([34, 39, 96, 46, 44, 59, 58, 33, 63])
  let a = 0
  let b = flat.length
  while (a < b && LEAD.has(flat[a])) a++
  while (b > a && TRAIL.has(flat[b - 1])) b--
  return stripWs(asciiLower(fromPoints(flat.slice(a, b))))
}

/** The part of the completion a rule reads. Lines are split on \n after \r\n and \r became \n. */
export function scopeText(text: string, scope: RubricScope | undefined): string {
  const whole = stripWs(text)
  if (!scope || scope === 'whole') return whole
  const lines = whole.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').map(stripWs).filter(l => l.length > 0)
  if (!lines.length) return ''
  return scope === 'first_line' ? lines[0] : lines[lines.length - 1]
}

const isDigit = (c: number | undefined): boolean => c !== undefined && c >= 48 && c <= 57

/**
 * The numbers in a text, in order: an optional sign, digits (thousands
 * separated by commas, three digits at a time), an optional fraction, or a
 * fraction alone (.5). A sign counts only when the character before it is not
 * a letter, a digit or a dot. No exponents.
 */
export function numbersIn(text: string): number[] {
  const p = points(text)
  const out: number[] = []
  let i = 0
  while (i < p.length) {
    const c = p[i]
    const start = i
    let signed = false
    if ((c === 43 || c === 45) && (isDigit(p[i + 1]) || (p[i + 1] === 46 && isDigit(p[i + 2])))) {
      const before = i > 0 ? p[i - 1] : 0
      const glued = isDigit(before) || before === 46 || (before >= 65 && before <= 90) || (before >= 97 && before <= 122)
      if (glued) { i++; continue }
      signed = true
      i++
    } else if (!isDigit(c) && !(c === 46 && isDigit(p[i + 1]))) {
      i++
      continue
    }
    let digits = ''
    let run = 0
    let grouped = false
    for (;;) {
      if (isDigit(p[i])) { digits += String.fromCharCode(p[i]); run++; i++; continue }
      // a comma between groups of three digits: 1,234 and 12,345,678, never 1234,567
      if (p[i] === 44 && run >= 1 && (grouped ? run === 3 : run <= 3) && isDigit(p[i + 1]) && isDigit(p[i + 2]) && isDigit(p[i + 3]) && !isDigit(p[i + 4])) {
        digits += String.fromCharCode(p[i + 1], p[i + 2], p[i + 3])
        i += 4
        grouped = true
        run = 3
        continue
      }
      break
    }
    let fraction = ''
    if (p[i] === 46 && isDigit(p[i + 1])) {
      i++
      while (isDigit(p[i])) { fraction += String.fromCharCode(p[i]); i++ }
    }
    const text2 = `${digits || '0'}${fraction ? `.${fraction}` : ''}`
    const n = Number(text2)
    if (Number.isFinite(n)) out.push(signed && p[start] === 45 ? -n : n)
  }
  return out
}

// ---------------------------------------------------------------------------
// The safe regular expression subset
// ---------------------------------------------------------------------------

type Node =
  | { t: 'char'; c: number }
  | { t: 'any' }
  | { t: 'class'; ranges: Array<[number, number]>; negate: boolean }
  | { t: 'bol' }
  | { t: 'eol' }
  | { t: 'cat'; parts: Node[] }
  | { t: 'alt'; options: Node[] }
  | { t: 'rep'; node: Node; min: number; max: number | null }

type Op =
  | { o: 'char'; c: number }
  | { o: 'any' }
  | { o: 'class'; ranges: Array<[number, number]>; negate: boolean }
  | { o: 'bol' }
  | { o: 'eol' }
  | { o: 'split'; a: number; b: number }
  | { o: 'jmp'; a: number }
  | { o: 'match' }

export interface CompiledRegex { program: Op[]; ignoreCase: boolean }

const DIGIT: Array<[number, number]> = [[48, 57]]
const WORD: Array<[number, number]> = [[48, 57], [65, 90], [95, 95], [97, 122]]
const SPACE: Array<[number, number]> = [[9, 13], [32, 32]]
const SIMPLE_ESCAPES: Record<string, number> = { n: 10, t: 9, r: 13 }
const PUNCT_ESCAPES = '\\/.-()[]{}*+?|^$'

export function compileRegex(pattern: string, ignoreCase = false): { regex: CompiledRegex } | { error: string } {
  const p = points(pattern)
  if (!p.length) return { error: 'the pattern is empty' }
  if (p.length > RUBRIC_REGEX_MAX_LEN) return { error: `the pattern is longer than ${RUBRIC_REGEX_MAX_LEN} characters` }
  let pos = 0
  const fold = (c: number): number => (ignoreCase && c >= 65 && c <= 90 ? c + 32 : c)
  const fail = (reason: string): never => { throw new Error(reason) }

  const escapeIn = (inClass: boolean): { ranges: Array<[number, number]>; negate: boolean } | { c: number } => {
    pos++ // the backslash
    const c = p[pos]
    if (c === undefined) return fail('the pattern ends with a backslash')
    pos++
    const ch = String.fromCodePoint(c)
    if (ch === 'd') return { ranges: DIGIT, negate: false }
    if (ch === 'w') return { ranges: WORD, negate: false }
    if (ch === 's') return { ranges: SPACE, negate: false }
    if (ch === 'D' || ch === 'W' || ch === 'S') {
      if (inClass) return fail(`\\${ch} is not allowed inside [ ]`)
      return { ranges: ch === 'D' ? DIGIT : ch === 'W' ? WORD : SPACE, negate: true }
    }
    if (Object.hasOwn(SIMPLE_ESCAPES, ch)) return { c: SIMPLE_ESCAPES[ch] }
    if (PUNCT_ESCAPES.includes(ch)) return { c }
    return fail(`\\${ch} is not supported (use \\d \\w \\s, \\n \\t \\r, or a backslash before a punctuation mark)`)
  }

  const parseClass = (): Node => {
    pos++ // [
    let negate = false
    if (p[pos] === 94) { negate = true; pos++ }
    const ranges: Array<[number, number]> = []
    let first = true
    for (;;) {
      const c = p[pos]
      if (c === undefined) return fail('a [ has no closing ]')
      if (c === 93 && !first) { pos++; break }
      first = false
      let lo: number
      if (c === 92) {
        const e = escapeIn(true)
        if ('ranges' in e) { ranges.push(...e.ranges); continue }
        lo = e.c
      } else {
        lo = c
        pos++
      }
      if (p[pos] === 45 && p[pos + 1] !== undefined && p[pos + 1] !== 93) {
        pos++
        let hi: number
        if (p[pos] === 92) {
          const e = escapeIn(true)
          if ('ranges' in e) return fail('a range cannot end in \\d, \\w or \\s')
          hi = e.c
        } else {
          hi = p[pos]
          pos++
        }
        if (hi < lo) return fail('a range in [ ] runs backwards')
        ranges.push([fold(lo), fold(hi)])
      } else {
        ranges.push([fold(lo), fold(lo)])
      }
    }
    return { t: 'class', ranges, negate }
  }

  const parseAtom = (): Node => {
    const c = p[pos]
    if (c === 40) { // (
      pos++
      if (p[pos] === 63) { // (?
        if (p[pos + 1] === 58) pos += 2 // (?: is a plain group
        else return fail('(? groups other than (?: are not supported (no lookarounds, no named groups)')
      }
      const inner = parseAlt()
      if (p[pos] !== 41) return fail('a ( has no closing )')
      pos++
      return inner
    }
    if (c === 91) return parseClass()
    if (c === 46) { pos++; return { t: 'any' } }
    if (c === 94) { pos++; return { t: 'bol' } }
    if (c === 36) { pos++; return { t: 'eol' } }
    if (c === 92) {
      const e = escapeIn(false)
      return 'ranges' in e ? { t: 'class', ranges: e.ranges, negate: e.negate } : { t: 'char', c: fold(e.c) }
    }
    if (c === 42 || c === 43 || c === 63) return fail('a quantifier has nothing before it')
    if (c === 123) return fail('{ must be written \\{ unless it starts a repeat after something')
    pos++
    return { t: 'char', c: fold(c) }
  }

  const parseNumber = (): number | null => {
    let s = ''
    while (isDigit(p[pos])) { s += String.fromCharCode(p[pos]); pos++ }
    return s ? Number(s) : null
  }

  const parseSeq = (): Node => {
    const parts: Node[] = []
    while (pos < p.length && p[pos] !== 124 && p[pos] !== 41) {
      let atom = parseAtom()
      const q = p[pos]
      let min: number | null = null
      let max: number | null = null
      let quantified = false
      if (q === 42) { min = 0; max = null; pos++; quantified = true }
      else if (q === 43) { min = 1; max = null; pos++; quantified = true }
      else if (q === 63) { min = 0; max = 1; pos++; quantified = true }
      else if (q === 123) {
        pos++
        const lo = parseNumber()
        if (lo === null) return fail('a repeat needs a number: {3}, {2,5} or {2,}')
        min = lo
        if (p[pos] === 44) {
          pos++
          const hi = parseNumber()
          max = hi
        } else max = lo
        if (p[pos] !== 125) return fail('a repeat is not closed with }')
        pos++
        quantified = true
        if (min > RUBRIC_REPEAT_MAX || (max !== null && max > RUBRIC_REPEAT_MAX)) return fail(`a repeat may count to at most ${RUBRIC_REPEAT_MAX}`)
        if (max !== null && max < min) return fail('a repeat runs backwards')
      }
      if (quantified) {
        if (atom.t === 'bol' || atom.t === 'eol') return fail('a quantifier cannot follow ^ or $')
        if (p[pos] === 63 || p[pos] === 43 || p[pos] === 42) return fail('lazy and possessive quantifiers are not supported')
        atom = { t: 'rep', node: atom, min: min as number, max }
      }
      parts.push(atom)
    }
    return { t: 'cat', parts }
  }

  function parseAlt(): Node {
    const options = [parseSeq()]
    while (p[pos] === 124) { pos++; options.push(parseSeq()) }
    return options.length === 1 ? options[0] : { t: 'alt', options }
  }

  let ast: Node
  try {
    ast = parseAlt()
    if (pos < p.length) fail(p[pos] === 41 ? 'a ) has no opening (' : 'the pattern could not be read')
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'the pattern could not be read' }
  }

  const program: Op[] = []
  const emit = (n: Node): void => {
    if (program.length > RUBRIC_REGEX_MAX_STATES) throw new Error(`the pattern needs more than ${RUBRIC_REGEX_MAX_STATES} steps once its repeats are counted out`)
    switch (n.t) {
      case 'char': program.push({ o: 'char', c: n.c }); return
      case 'any': program.push({ o: 'any' }); return
      case 'class': program.push({ o: 'class', ranges: n.ranges, negate: n.negate }); return
      case 'bol': program.push({ o: 'bol' }); return
      case 'eol': program.push({ o: 'eol' }); return
      case 'cat': for (const part of n.parts) emit(part); return
      case 'alt': {
        const jumps: number[] = []
        for (let i = 0; i < n.options.length; i++) {
          if (i < n.options.length - 1) {
            const split = program.length
            program.push({ o: 'split', a: split + 1, b: -1 })
            emit(n.options[i])
            jumps.push(program.length)
            program.push({ o: 'jmp', a: -1 })
            ;(program[split] as { b: number }).b = program.length
          } else emit(n.options[i])
        }
        for (const j of jumps) (program[j] as { a: number }).a = program.length
        return
      }
      case 'rep': {
        for (let i = 0; i < n.min; i++) emit(n.node)
        if (n.max === null) {
          const split = program.length
          program.push({ o: 'split', a: split + 1, b: -1 })
          emit(n.node)
          program.push({ o: 'jmp', a: split })
          ;(program[split] as { b: number }).b = program.length
        } else {
          const splits: number[] = []
          for (let i = n.min; i < n.max; i++) {
            splits.push(program.length)
            program.push({ o: 'split', a: program.length + 1, b: -1 })
            emit(n.node)
          }
          for (const s of splits) (program[s] as { b: number }).b = program.length
        }
      }
    }
  }
  try {
    emit(ast)
    program.push({ o: 'match' })
    if (program.length > RUBRIC_REGEX_MAX_STATES) throw new Error(`the pattern needs more than ${RUBRIC_REGEX_MAX_STATES} steps once its repeats are counted out`)
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'the pattern is too large' }
  }
  return { regex: { program, ignoreCase } }
}

/** Does the pattern match anywhere in the text? The automaton is stepped once per character. */
export function regexSearch(regex: CompiledRegex, text: string): boolean {
  const prog = regex.program
  const chars = points(regex.ignoreCase ? asciiLower(text) : text)
  const n = chars.length
  let current = new Set<number>()
  const add = (set: Set<number>, start: number, at: number): boolean => {
    const stack = [start]
    const seen = new Set<number>()
    while (stack.length) {
      const pc = stack.pop() as number
      if (seen.has(pc)) continue
      seen.add(pc)
      const op = prog[pc]
      if (op.o === 'jmp') stack.push(op.a)
      else if (op.o === 'split') { stack.push(op.b); stack.push(op.a) }
      else if (op.o === 'bol') { if (at === 0) stack.push(pc + 1) }
      else if (op.o === 'eol') { if (at === n) stack.push(pc + 1) }
      else if (op.o === 'match') return true
      else set.add(pc)
    }
    return false
  }
  for (let at = 0; at <= n; at++) {
    if (add(current, 0, at)) return true
    if (at === n) break
    const c = chars[at]
    const next = new Set<number>()
    for (const pc of current) {
      const op = prog[pc]
      let ok = false
      if (op.o === 'char') ok = op.c === c
      else if (op.o === 'any') ok = c !== 10
      else if (op.o === 'class') {
        const inside = op.ranges.some(([lo, hi]) => c >= lo && c <= hi)
        ok = inside !== op.negate
      }
      if (ok && add(next, pc + 1, at + 1)) return true
    }
    current = next
  }
  return false
}

// ---------------------------------------------------------------------------
// JSON with a small schema
// ---------------------------------------------------------------------------

/** The text of a JSON answer: the whole completion, or the inside of one fenced block that is the whole completion. */
export function jsonText(text: string): string {
  const t = stripWs(text)
  if (!t.startsWith('```')) return t
  const lines = t.split('\n')
  lines.shift()
  let body = stripWs(lines.join('\n'))
  if (body.endsWith('```')) body = stripWs(body.slice(0, -3))
  return body
}

/** Parses JSON the way both languages agree on: no NaN, no Infinity, nothing but one value. */
export function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

function isInteger(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v) && Math.floor(v) === v
}

export function schemaAccepts(value: unknown, schema: RubricSchema): boolean {
  if (schema.type !== undefined) {
    const t = schema.type
    const ok = t === 'object' ? isObject(value)
      : t === 'array' ? Array.isArray(value)
        : t === 'string' ? typeof value === 'string'
          : t === 'number' ? typeof value === 'number' && Number.isFinite(value)
            : t === 'integer' ? isInteger(value)
              : t === 'boolean' ? typeof value === 'boolean'
                : value === null
    if (!ok) return false
  }
  if (isObject(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) return false
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key) && !schemaAccepts(value[key], sub)) return false
    }
  } else if (schema.required && schema.required.length) return false
  if (Array.isArray(value) && schema.items) {
    for (const item of value) if (!schemaAccepts(item, schema.items)) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Reading a rubric a model wrote
// ---------------------------------------------------------------------------

function readSchema(raw: unknown, depth: number, nodes: { n: number }): RubricSchema | string {
  if (!isObject(raw)) return 'a schema must be an object'
  if (depth > RUBRIC_SCHEMA_MAX_DEPTH) return `a schema may nest at most ${RUBRIC_SCHEMA_MAX_DEPTH} deep`
  if (++nodes.n > RUBRIC_SCHEMA_MAX_NODES) return `a schema may hold at most ${RUBRIC_SCHEMA_MAX_NODES} parts`
  const extra = keysOnly(raw, ['type', 'required', 'properties', 'items'])
  if (extra) return `a schema may only use type, required, properties and items (not ${extra})`
  const out: RubricSchema = {}
  if (raw.type !== undefined) {
    if (typeof raw.type !== 'string' || !(RUBRIC_JSON_TYPES as readonly string[]).includes(raw.type)) return `schema type must be one of ${RUBRIC_JSON_TYPES.join(', ')}`
    out.type = raw.type as RubricSchema['type']
  }
  if (raw.required !== undefined) {
    if (!Array.isArray(raw.required) || raw.required.length > RUBRIC_LIST_MAX || raw.required.some(k => typeof k !== 'string' || !DATA_KEY.test(k))) {
      return `schema required must be a list of at most ${RUBRIC_LIST_MAX} names of letters, digits and underscores`
    }
    out.required = raw.required as string[]
  }
  if (raw.properties !== undefined) {
    if (!isObject(raw.properties) || Object.keys(raw.properties).length > RUBRIC_LIST_MAX) return `schema properties must be an object of at most ${RUBRIC_LIST_MAX} entries`
    const props: Record<string, RubricSchema> = {}
    for (const [k, v] of Object.entries(raw.properties)) {
      if (!DATA_KEY.test(k)) return 'a property name may hold only letters, digits and underscores'
      const sub = readSchema(v, depth + 1, nodes)
      if (typeof sub === 'string') return sub
      props[k] = sub
    }
    out.properties = props
  }
  if (raw.items !== undefined) {
    const sub = readSchema(raw.items, depth + 1, nodes)
    if (typeof sub === 'string') return sub
    out.items = sub
  }
  return out
}

const plainString = (v: unknown, max = RUBRIC_STRING_MAX): v is string =>
  typeof v === 'string' && v.length > 0 && Array.from(v).length <= max && !CONTROL.test(v) && !LONE_SURROGATE.test(v)

function readStringList(raw: unknown, what: string): string[] | string {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > RUBRIC_LIST_MAX) return `${what} must be a list of 1 to ${RUBRIC_LIST_MAX} strings`
  for (const s of raw) if (!plainString(s)) return `${what} holds a string that is empty, longer than ${RUBRIC_STRING_MAX} characters or has a control character`
  return raw as string[]
}

function readFrom(raw: unknown): string | null {
  if (raw === 'expected') return 'expected'
  if (typeof raw === 'string' && raw.startsWith('data.') && DATA_KEY.test(raw.slice(5))) return raw
  return null
}

/** One rule, read strictly. `where` names it in a refusal. */
function readRule(raw: unknown, where: string): RubricRule | string {
  if (!isObject(raw)) return `${where} is not an object`
  const type = raw.type
  if (typeof type !== 'string' || !(RUBRIC_TYPES as readonly string[]).includes(type)) return `${where}: type must be one of ${RUBRIC_TYPES.join(', ')}`
  const weight = raw.weight
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0 || weight > 1) return `${where}: weight must be a number above 0 and at most 1`
  const base = ['type', 'weight']
  const rule: RubricRule = { type: type as RubricType, weight }
  const scopeOk = (): string | null => {
    if (raw.scope === undefined) return null
    if (raw.scope !== 'whole' && raw.scope !== 'first_line' && raw.scope !== 'last_line') return `${where}: scope must be whole, first_line or last_line`
    rule.scope = raw.scope
    return null
  }
  const target = (): string | null => {
    const hasValue = raw.value !== undefined
    const hasFrom = raw.from !== undefined
    if (hasValue === hasFrom) return `${where}: give either "value" or "from" (expected, or data.<name>)`
    if (hasFrom) {
      const from = readFrom(raw.from)
      if (!from) return `${where}: from must be "expected" or "data.<name>" (letters, digits, underscores)`
      rule.from = from
    } else if (type === 'number_close') {
      if (typeof raw.value !== 'number' || !Number.isFinite(raw.value)) return `${where}: value must be a number`
      rule.value = raw.value
    } else {
      if (!plainString(raw.value)) return `${where}: value must be 1 to ${RUBRIC_STRING_MAX} characters of text without control characters`
      rule.value = raw.value
    }
    return null
  }
  let problem: string | null
  switch (type) {
    case 'exact_match': {
      const extra = keysOnly(raw, [...base, 'value', 'from', 'scope'])
      if (extra) return `${where}: exact_match has no field ${extra}`
      problem = target() || scopeOk()
      return problem ?? rule
    }
    case 'contains':
    case 'not_contains': {
      const extra = keysOnly(raw, [...base, 'any', 'all', 'from', 'value', 'ignore_case', 'scope'])
      if (extra) return `${where}: ${type} has no field ${extra}`
      const given = ['any', 'all', 'from', 'value'].filter(k => raw[k] !== undefined)
      if (given.length !== 1) return `${where}: give exactly one of "any", "all", "value" or "from"`
      if (type === 'not_contains' && given[0] === 'all') return `${where}: not_contains takes "any" (none of them may appear), "value" or "from"`
      if (given[0] === 'any' || given[0] === 'all') {
        const list = readStringList(raw[given[0]], `${where}: ${given[0]}`)
        if (typeof list === 'string') return list
        rule[given[0] as 'any' | 'all'] = list
      } else {
        problem = target()
        if (problem) return problem
      }
      if (raw.ignore_case !== undefined) {
        if (typeof raw.ignore_case !== 'boolean') return `${where}: ignore_case must be true or false`
        rule.ignore_case = raw.ignore_case
      }
      return scopeOk() ?? rule
    }
    case 'number_close': {
      const extra = keysOnly(raw, [...base, 'value', 'from', 'tolerance', 'relative', 'pick', 'scope'])
      if (extra) return `${where}: number_close has no field ${extra}`
      problem = target()
      if (problem) return problem
      if (raw.tolerance !== undefined) {
        if (typeof raw.tolerance !== 'number' || !Number.isFinite(raw.tolerance) || raw.tolerance < 0 || raw.tolerance > RUBRIC_TOLERANCE_MAX) return `${where}: tolerance must be a number from 0 to ${RUBRIC_TOLERANCE_MAX}`
        rule.tolerance = raw.tolerance
      }
      if (raw.relative !== undefined) {
        if (typeof raw.relative !== 'boolean') return `${where}: relative must be true or false`
        rule.relative = raw.relative
      }
      if (raw.pick !== undefined) {
        if (raw.pick !== 'first' && raw.pick !== 'last') return `${where}: pick must be first or last`
        rule.pick = raw.pick
      }
      return scopeOk() ?? rule
    }
    case 'regex_match': {
      const extra = keysOnly(raw, [...base, 'pattern', 'ignore_case', 'scope'])
      if (extra) return `${where}: regex_match has no field ${extra}`
      if (typeof raw.pattern !== 'string' || CONTROL.test(raw.pattern) || LONE_SURROGATE.test(raw.pattern)) return `${where}: pattern must be text`
      if (raw.ignore_case !== undefined && typeof raw.ignore_case !== 'boolean') return `${where}: ignore_case must be true or false`
      const compiled = compileRegex(raw.pattern, raw.ignore_case === true)
      if ('error' in compiled) return `${where}: ${compiled.error}`
      rule.pattern = raw.pattern
      if (raw.ignore_case !== undefined) rule.ignore_case = raw.ignore_case as boolean
      return scopeOk() ?? rule
    }
    case 'json_valid': {
      const extra = keysOnly(raw, [...base, 'schema'])
      if (extra) return `${where}: json_valid has no field ${extra}`
      if (raw.schema !== undefined) {
        const schema = readSchema(raw.schema, 1, { n: 0 })
        if (typeof schema === 'string') return `${where}: ${schema}`
        rule.schema = schema
      }
      return rule
    }
    default: { // length_between
      const extra = keysOnly(raw, [...base, 'min', 'max', 'scope'])
      if (extra) return `${where}: length_between has no field ${extra}`
      for (const k of ['min', 'max'] as const) {
        const v = raw[k]
        if (v === undefined) continue
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > RUBRIC_LENGTH_MAX) return `${where}: ${k} must be a whole number from 0 to ${RUBRIC_LENGTH_MAX}`
        rule[k] = v
      }
      if (rule.min === undefined && rule.max === undefined) return `${where}: give min, max or both`
      if (rule.min !== undefined && rule.max !== undefined && rule.min > rule.max) return `${where}: min is above max`
      return scopeOk() ?? rule
    }
  }
}

/** The rubric a model wrote, read strictly: 1 to 8 rules, weights that add up to at most 1. */
export function normalizeRubric(raw: unknown): { rubric: Rubric } | { error: string } {
  if (!isObject(raw)) return { error: 'rubric must be an object with "rules"' }
  const extra = keysOnly(raw, ['rules'])
  if (extra) return { error: `rubric has a field that is not "rules": ${extra}` }
  const list = raw.rules
  if (!Array.isArray(list) || list.length < 1 || list.length > RUBRIC_MAX_RULES) return { error: `rubric.rules must hold 1 to ${RUBRIC_MAX_RULES} rules` }
  const rules: RubricRule[] = []
  let total = 0
  for (const [i, item] of list.entries()) {
    const rule = readRule(item, `rubric.rules[${i}]`)
    if (typeof rule === 'string') return { error: rule }
    total += rule.weight
    rules.push(rule)
  }
  if (total > 1 + 1e-9) return { error: `the weights add up to ${Math.round(total * 1e6) / 1e6} and may add up to at most 1` }
  return { rubric: { rules } }
}

const TASK_DATA_MAX = 8
export const TASK_PROMPT_MAX_BYTES = 1500
export const TASK_VALUE_MAX = 400

/** One task, read strictly. */
export function normalizeTask(raw: unknown, where: string): { task: RubricTask; bytes: number } | { error: string } {
  if (!isObject(raw)) return { error: `${where} is not an object with "prompt"` }
  const extra = keysOnly(raw, ['prompt', 'expected', 'data'])
  if (extra) return { error: `${where} has a field that is not prompt, expected or data: ${extra}` }
  const prompt = raw.prompt
  if (typeof prompt !== 'string' || !prompt.trim()) return { error: `${where}: prompt must be non-empty text` }
  if (CONTROL.test(prompt) || LONE_SURROGATE.test(prompt)) return { error: `${where}: prompt holds a control character or broken text` }
  let bytes = Buffer.byteLength(prompt, 'utf8')
  if (bytes > TASK_PROMPT_MAX_BYTES) return { error: `${where}: prompt holds more than ${TASK_PROMPT_MAX_BYTES} bytes` }
  const task: RubricTask = { prompt }
  if (raw.expected !== undefined) {
    if (typeof raw.expected !== 'string' || !raw.expected.trim() || Array.from(raw.expected).length > TASK_VALUE_MAX || CONTROL.test(raw.expected) || LONE_SURROGATE.test(raw.expected)) {
      return { error: `${where}: expected must be 1 to ${TASK_VALUE_MAX} characters of text` }
    }
    task.expected = raw.expected
    bytes += Buffer.byteLength(raw.expected, 'utf8')
  }
  if (raw.data !== undefined) {
    if (!isObject(raw.data) || Object.keys(raw.data).length < 1 || Object.keys(raw.data).length > TASK_DATA_MAX) return { error: `${where}: data must be an object of 1 to ${TASK_DATA_MAX} entries` }
    const data: Record<string, string | number> = {}
    for (const [k, v] of Object.entries(raw.data)) {
      if (!DATA_KEY.test(k)) return { error: `${where}: a data name may hold only letters, digits and underscores, up to 24` }
      if (typeof v === 'number') {
        // Whole numbers only: a fraction would be written differently by the two languages.
        if (!Number.isSafeInteger(v)) return { error: `${where}: data.${k} must be a whole number, or text for anything else` }
        data[k] = v
      } else if (typeof v === 'string' && v.trim() && Array.from(v).length <= TASK_VALUE_MAX && !CONTROL.test(v) && !LONE_SURROGATE.test(v)) {
        data[k] = v
        bytes += Buffer.byteLength(v, 'utf8')
      } else return { error: `${where}: data.${k} must be a number or 1 to ${TASK_VALUE_MAX} characters of text` }
    }
    task.data = data
  }
  return { task, bytes }
}

/** Does every task carry what the rubric reads from it? A refusal names the first that does not. */
export function rubricFitsTasks(rubric: Rubric, tasks: RubricTask[]): string | null {
  for (const [r, rule] of rubric.rules.entries()) {
    if (!rule.from) continue
    for (const [i, task] of tasks.entries()) {
      if (rule.from === 'expected' ? task.expected === undefined : task.data?.[rule.from.slice(5)] === undefined) {
        return `rubric.rules[${r}] reads ${rule.from} and tasks[${i}] has none`
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function targetOf(rule: RubricRule, task: RubricTask): string | number | undefined {
  if (rule.from === 'expected') return task.expected
  if (rule.from) return task.data?.[rule.from.slice(5)]
  return rule.value
}

const compiledCache = new Map<string, CompiledRegex | null>()
function regexFor(rule: RubricRule): CompiledRegex | null {
  const key = `${rule.ignore_case === true ? 'i' : 'c'}:${rule.pattern}`
  if (!compiledCache.has(key)) {
    const c = compileRegex(rule.pattern ?? '', rule.ignore_case === true)
    compiledCache.set(key, 'regex' in c ? c.regex : null)
    if (compiledCache.size > 200) compiledCache.delete(compiledCache.keys().next().value as string)
  }
  return compiledCache.get(key) ?? null
}

const foldFor = (rule: RubricRule, s: string): string => (rule.ignore_case === false ? nfkc(s) : asciiLower(nfkc(s)))

/** One rule on one completion: 0 or 1. */
export function scoreRule(rule: RubricRule, task: RubricTask, completion: string): number {
  const text = scopeText(fromPoints(points(completion).slice(0, RUBRIC_TEXT_MAX)), rule.scope)
  switch (rule.type) {
    case 'exact_match': {
      const t = targetOf(rule, task)
      return t !== undefined && normaliseText(text) === normaliseText(String(t)) ? 1 : 0
    }
    case 'contains':
    case 'not_contains': {
      const hay = foldFor(rule, text)
      const target = rule.any ?? rule.all ?? (() => { const t = targetOf(rule, task); return t === undefined ? null : [String(t)] })()
      if (!target) return 0
      const found = target.map(s => hay.includes(foldFor(rule, s)))
      if (rule.type === 'not_contains') return found.some(Boolean) ? 0 : 1
      return (rule.all ? found.every(Boolean) : found.some(Boolean)) ? 1 : 0
    }
    case 'number_close': {
      const t = targetOf(rule, task)
      const want = typeof t === 'number' ? t : t === undefined ? undefined : numbersIn(String(t))[0]
      if (want === undefined) return 0
      const got = numbersIn(text)
      if (!got.length) return 0
      const x = rule.pick === 'first' ? got[0] : got[got.length - 1]
      const tol = (rule.tolerance ?? 1e-6) * (rule.relative ? Math.abs(want) : 1)
      return Math.abs(x - want) <= tol ? 1 : 0
    }
    case 'regex_match': {
      const re = regexFor(rule)
      return re && regexSearch(re, text) ? 1 : 0
    }
    case 'json_valid': {
      const parsed = parseJson(jsonText(fromPoints(points(completion).slice(0, RUBRIC_TEXT_MAX))))
      if (!parsed.ok) return 0
      return rule.schema ? (schemaAccepts(parsed.value, rule.schema) ? 1 : 0) : 1
    }
    default: {
      const n = points(text).length
      return (rule.min === undefined || n >= rule.min) && (rule.max === undefined || n <= rule.max) ? 1 : 0
    }
  }
}

/** The score of a completion: the weighted sum of the rules, clamped to [0, 1], to six places. */
export function scoreCompletion(rubric: Rubric, task: RubricTask, completion: string): number {
  let sum = 0
  for (const rule of rubric.rules) sum += rule.weight * scoreRule(rule, task, completion)
  const clamped = Math.min(1, Math.max(0, sum))
  return Math.floor(clamped * 1e6 + 0.5) / 1e6
}

/** The most a completion can score: the weights added up, at most 1. */
export function rubricMax(rubric: Rubric): number {
  const total = rubric.rules.reduce((a, r) => a + r.weight, 0)
  return Math.floor(Math.min(1, total) * 1e6 + 0.5) / 1e6
}

/** The rules in plain words, for the Reviewer and the public record. */
export function describeRubric(rubric: Rubric): string[] {
  return rubric.rules.map(r => {
    const w = `${Math.round(r.weight * 100)}%`
    const scope = r.scope && r.scope !== 'whole' ? ` (${r.scope.replace('_', ' ')})` : ''
    const quote = (s: string) => `"${s.length > 40 ? `${s.slice(0, 39)}...` : s}"`
    const from = r.from ? (r.from === 'expected' ? "the task's expected answer" : `the task's ${r.from.slice(5)}`) : null
    switch (r.type) {
      case 'exact_match': return `${w} exact match with ${from ?? quote(String(r.value))}${scope}`
      case 'contains': return `${w} contains ${r.all ? `all of ${r.all.map(quote).join(', ')}` : r.any ? `any of ${r.any.map(quote).join(', ')}` : from ?? quote(String(r.value))}${scope}`
      case 'not_contains': return `${w} contains none of ${r.any ? r.any.map(quote).join(', ') : from ?? quote(String(r.value))}${scope}`
      case 'number_close': return `${w} last or first number within ${r.tolerance ?? 1e-6}${r.relative ? ' (relative)' : ''} of ${from ?? String(r.value)}${scope}`
      case 'regex_match': return `${w} matches pattern ${quote(r.pattern ?? '')}${scope}`
      case 'json_valid': return `${w} is valid JSON${r.schema ? ' that fits the given schema' : ''}`
      default: return `${w} length between ${r.min ?? 0} and ${r.max ?? 'any'} characters${scope}`
    }
  })
}
