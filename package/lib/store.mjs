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
// The same file also holds the **delegation ledger**: one record per
// `session_send(..., callback: true)`, with its target, the task excerpt and the
// reply the target produced. It is a durable relation too, and keeping it in one
// file means one writer, one atomic write and one reader cover both.
//
// Reads are stat-validated, so a writer in another module instance (or another
// process) is noticed instead of being answered from a stale cache; writes are
// serialized per instance and flushed with a temp file + rename, so a crash
// never leaves a half-written state file.
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Current on-disk format. */
export const STATE_VERSION = 3
/** Cap on a describe note, in characters. */
export const NOTE_MAX_CHARS = 200
/** Cap on a persisted title, in characters. */
export const TITLE_MAX_CHARS = 120
/** Cap on the task excerpt one delegation keeps. */
export const DELEGATION_TASK_CHARS = 200
/** Cap on the reply one delegation keeps. */
export const DELEGATION_REPLY_CHARS = 1200
/** How many delegations the ledger retains (newest first). */
export const DELEGATION_KEEP = 200
/** Every state a delegation record can be in. */
export const DELEGATION_STATUSES = ['pending', 'done', 'failed', 'unknown']
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

/** One empty state: no records, no delegations. */
export const blankState = () => ({ version: STATE_VERSION, byId: {}, delegations: [] })

/** One empty delegation record, in its absent form. */
export const blankDelegation = () => ({
  id: '',
  from: '',
  to: '',
  task: '',
  mode: 'queue',
  status: 'pending',
  createdAt: 0,
  baselineSeq: 0,
  settledAt: 0,
  reply: '',
  note: '',
})

/** Normalize one on-disk delegation; a record without an id or endpoints is dropped. */
const normalizeDelegation = (value) => {
  if (value === null || typeof value !== 'object') return null
  if (typeof value.id !== 'string' || value.id.length === 0) return null
  if (typeof value.from !== 'string' || value.from.length === 0) return null
  if (typeof value.to !== 'string' || value.to.length === 0) return null
  return {
    id: value.id,
    from: value.from,
    to: value.to,
    task: typeof value.task === 'string' ? clip(value.task, DELEGATION_TASK_CHARS) : '',
    mode: value.mode === 'steer' ? 'steer' : 'queue',
    status: DELEGATION_STATUSES.includes(value.status) ? value.status : 'pending',
    createdAt: asTime(value.createdAt),
    baselineSeq: typeof value.baselineSeq === 'number' && Number.isFinite(value.baselineSeq) && value.baselineSeq > 0 ? Math.floor(value.baselineSeq) : 0,
    settledAt: asTime(value.settledAt),
    reply: typeof value.reply === 'string' ? clip(value.reply, DELEGATION_REPLY_CHARS) : '',
    note: typeof value.note === 'string' ? clip(value.note, 400) : '',
  }
}

/** Parse a state file; anything unreadable degrades to an empty state, never a throw. */
const parseState = (raw) => {
  const state = blankState()
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
  const delegations = Array.isArray(parsed.delegations) ? parsed.delegations : []
  for (const value of delegations) {
    const delegation = normalizeDelegation(value)
    if (delegation !== null) state.delegations.push(delegation)
  }
  return state
}

/** Seed from the pre-0.2 notes file, so an upgrade in place keeps every note. */
const seedFromLegacy = async () => {
  const state = blankState()
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
    return { ...state, byId }
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
    return changed ? { ...state, byId } : null
  })

/** One session's persisted record, or undefined. */
export const recordOf = (state, sessionId) => (state !== null && state !== undefined && state.byId !== null && state.byId !== undefined ? state.byId[sessionId] : undefined)

// ── delegations: session_send(callback) and its outcome ledger ───────────────
//
// A delegation is a durable relation between two sessions: "I asked you to do
// this, and here is what came back". It lives in the same file as the notes so
// one writer, one atomic write and one reader cover both, and so a delegation
// outlives the process that created it — the watcher can pick a pending one up
// again after a restart, because completion is decided from the TARGET's durable
// log rather than from anything held in memory.

/** Record one delegation. Newest first; the ledger keeps the newest DELEGATION_KEEP entries. */
export const addDelegation = (delegation) =>
  change((state) => {
    const record = normalizeDelegation(delegation)
    if (record === null) return null
    const delegations = [record, ...state.delegations.filter((item) => item.id !== record.id)].slice(0, DELEGATION_KEEP)
    return { ...state, delegations }
  })

/**
 * Settle one delegation that is still pending. A record that already settled is
 * left alone (returning null skips the write), so a second watcher pass can
 * never overwrite a recorded outcome.
 */
export const settleDelegation = (id, patch) =>
  change((state) => {
    const index = state.delegations.findIndex((item) => item.id === id)
    if (index < 0) return null
    if (state.delegations[index].status !== 'pending') return null
    const merged = normalizeDelegation({ ...state.delegations[index], ...patch, settledAt: patch.settledAt !== undefined ? patch.settledAt : Date.now() })
    if (merged === null) return null
    const delegations = state.delegations.slice()
    delegations[index] = merged
    return { ...state, delegations }
  })

/** Append one note to a delegation in any state — used when the callback notice itself could not be delivered. */
export const noteDelegation = (id, text) =>
  change((state) => {
    const index = state.delegations.findIndex((item) => item.id === id)
    if (index < 0) return null
    const current = state.delegations[index]
    const note = current.note.length > 0 ? `${current.note} ${text}` : text
    const merged = normalizeDelegation({ ...current, note })
    if (merged === null || merged.note === current.note) return null
    const delegations = state.delegations.slice()
    delegations[index] = merged
    return { ...state, delegations }
  })

/** Forget one delegation record. */
export const dropDelegation = (id) =>
  change((state) => {
    const delegations = state.delegations.filter((item) => item.id !== id)
    return delegations.length === state.delegations.length ? null : { ...state, delegations }
  })

/** Every delegation still waiting for its target, oldest first. */
export const pendingDelegations = (state) => (state !== null && state !== undefined && Array.isArray(state.delegations) ? state.delegations.filter((item) => item.status === 'pending') : [])
