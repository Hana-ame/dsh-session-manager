// ① Persistence layer of the session-manager package.
//
// One durable JSON file, `$DSH_HOME/session-manager/state.json`, holds everything
// this package remembers about a session:
//
//   description   the private "describe" note the management tools attach
//   parentId      the session this one was forked from or delegated by
//   kind          'top-level' | 'fork' | 'subagent', as last observed
//   cwd, title    the location and title as last observed
//   firstSeenAt   when this package first recorded the session
//
// Keeping the lineage here is what makes the relations outlive their sources:
// a fork whose parent session has since been archived still shows its edge, and
// the canvas renders exactly the records the tools write.
//
// Reads are stat-validated, so a writer in another module instance (or another
// process) is noticed instead of being answered from a stale cache; writes are
// serialized per instance and flushed with a temp file + rename, so a crash
// never leaves a half-written state file.
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Current on-disk format. */
export const STATE_VERSION = 2
/** Cap on a describe note, in characters. */
export const NOTE_MAX_CHARS = 200
/** Cap on a persisted title, in characters. */
export const TITLE_MAX_CHARS = 120
/** Path cap, generous enough for any real working directory. */
const PATH_MAX_CHARS = 4096

const STATE_FILE = 'state.json'
/** The pre-0.2 notes file, read once to preserve notes across an in-place upgrade. */
const LEGACY_FILE = 'descriptions.json'

/** `$DSH_HOME`, falling back to `~/.dsh` exactly like the harness does. */
const home = () => {
  const configured = typeof process === 'object' && process !== null && typeof process.env === 'object' && process.env !== null ? process.env.DSH_HOME : undefined
  return typeof configured === 'string' && configured.length > 0 ? configured : join(homedir(), '.dsh')
}

/** Directory this package owns under DSH_HOME. */
export const stateDir = () => join(home(), 'session-manager')
/** The one durable state file. */
export const statePath = () => join(stateDir(), STATE_FILE)
/** The pre-0.2 notes file, still read (never written) for migration. */
export const legacyPath = () => join(stateDir(), LEGACY_FILE)

const clip = (value, cap) => value.slice(0, cap)
const asText = (value, cap) => (typeof value === 'string' && value.length > 0 ? clip(value, cap) : null)
const asTime = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)

/** One empty record: every field the store can hold, in its absent form. */
export const blankRecord = () => ({
  description: '',
  updatedAt: 0,
  parentId: null,
  kind: null,
  cwd: null,
  title: null,
  firstSeenAt: 0,
})

/** Whether a record carries nothing worth persisting (a cleared note and no lineage). */
const isBlank = (record) =>
  record.description.length === 0 &&
  record.parentId === null &&
  record.kind === null &&
  record.cwd === null &&
  record.title === null

/** Normalize one on-disk record; an entry carrying no information is dropped. */
const normalizeRecord = (value) => {
  if (value === null || typeof value !== 'object') return null
  const record = {
    description: typeof value.description === 'string' ? clip(value.description, NOTE_MAX_CHARS) : '',
    updatedAt: asTime(value.updatedAt),
    parentId: typeof value.parentId === 'string' && value.parentId.length > 0 ? value.parentId : null,
    kind: value.kind === 'subagent' || value.kind === 'fork' || value.kind === 'top-level' ? value.kind : null,
    cwd: asText(value.cwd, PATH_MAX_CHARS),
    title: asText(value.title, TITLE_MAX_CHARS),
    firstSeenAt: asTime(value.firstSeenAt),
  }
  return isBlank(record) ? null : record
}

/** Parse a state file; anything unreadable degrades to an empty state, never a throw. */
const parseState = (raw) => {
  const state = { version: STATE_VERSION, byId: {} }
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    return state
  }
  if (parsed === null || typeof parsed !== 'object') return state
  const source = parsed.byId !== null && typeof parsed.byId === 'object' ? parsed.byId : {}
  for (const id of Object.keys(source)) {
    const record = normalizeRecord(source[id])
    if (record !== null) state.byId[id] = record
  }
  return state
}

/** Seed from the pre-0.2 notes file, so an upgrade in place keeps every note. */
const seedFromLegacy = async () => {
  const state = { version: STATE_VERSION, byId: {} }
  let raw = null
  try {
    raw = await readFile(legacyPath(), 'utf8')
  } catch {
    return state
  }
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    return state
  }
  const source = parsed !== null && typeof parsed === 'object' && parsed.byId !== null && typeof parsed.byId === 'object' ? parsed.byId : {}
  const now = Date.now()
  for (const id of Object.keys(source)) {
    const entry = source[id]
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.description !== 'string' || entry.description.length === 0) continue
    state.byId[id] = {
      ...blankRecord(),
      description: clip(entry.description, NOTE_MAX_CHARS),
      updatedAt: asTime(entry.updatedAt) || now,
      firstSeenAt: now,
    }
  }
  return state
}

let cache = null
let stamp = null
let queue = Promise.resolve()

/** Identity of the file on disk, or null when it does not exist yet. */
const fileStamp = async () => {
  try {
    const info = await stat(statePath())
    return `${String(info.mtimeMs)}:${String(info.size)}`
  } catch {
    return null
  }
}

/**
 * Read the durable state, re-reading the file whenever it changed underneath the
 * cache. Callers get the live object; treat it as read-only.
 */
export const readState = async () => {
  const current = await fileStamp()
  if (cache !== null && current === stamp) return cache
  let raw = null
  try {
    raw = await readFile(statePath(), 'utf8')
  } catch {
    raw = null
  }
  cache = raw === null ? await seedFromLegacy() : parseState(raw)
  stamp = current
  return cache
}

/** Write the whole state atomically and install it as the cache. */
const flush = async (state) => {
  await mkdir(stateDir(), { recursive: true })
  const target = statePath()
  const temp = `${target}.${String(process.pid)}.tmp`
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(temp, target)
  cache = state
  stamp = await fileStamp()
  return cache
}

/**
 * Serialize every write behind one queue. A change function returning null means
 * "nothing changed", which skips the file write entirely.
 */
const change = (mutator) => {
  const run = queue.then(async () => {
    const state = await readState()
    const next = await mutator(state)
    return next === null ? state : flush(next)
  })
  queue = run.then(() => undefined, () => undefined)
  return run
}

/** Attach, replace or clear (empty string) the private note of one session. */
export const setNote = (sessionId, description) =>
  change((state) => {
    const record = { ...(state.byId[sessionId] ?? blankRecord()), description: clip(description, NOTE_MAX_CHARS), updatedAt: Date.now() }
    const byId = { ...state.byId }
    if (isBlank(record)) delete byId[sessionId]
    else byId[sessionId] = record
    return { version: STATE_VERSION, byId }
  })

/**
 * Persist the lineage observed for a batch of sessions, preserving each one's
 * note. Rows are `{ id, parentId, kind, cwd, title }`; the write is skipped when
 * nothing actually changed, so a read-only listing stays read-only on disk.
 */
export const observe = (rows) =>
  change((state) => {
    const now = Date.now()
    const byId = { ...state.byId }
    let changed = false
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue
      if (typeof row.id !== 'string' || row.id.length === 0) continue
      const existing = byId[row.id] ?? blankRecord()
      const parentId = typeof row.parentId === 'string' && row.parentId.length > 0 ? row.parentId : null
      const kind = row.kind === 'subagent' || row.kind === 'fork' ? row.kind : 'top-level'
      const cwd = asText(row.cwd, PATH_MAX_CHARS)
      const title = asText(row.title, TITLE_MAX_CHARS)
      if (existing.parentId === parentId && existing.kind === kind && existing.cwd === cwd && existing.title === title) continue
      changed = true
      byId[row.id] = { ...existing, parentId, kind, cwd, title, firstSeenAt: existing.firstSeenAt > 0 ? existing.firstSeenAt : now }
    }
    return changed ? { version: STATE_VERSION, byId } : null
  })

/** One session's persisted record, or undefined. */
export const recordOf = (state, sessionId) => (state !== null && state !== undefined && state.byId !== null && state.byId !== undefined ? state.byId[sessionId] : undefined)
