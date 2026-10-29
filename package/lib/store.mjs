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
// `session_list` reads exactly the records the other tools write.
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
export const STATE_VERSION = 5
/** Cap on a describe note, in characters. */
export const NOTE_MAX_CHARS = 200
/** Cap on a persisted title, in characters. */
export const TITLE_MAX_CHARS = 120
/** Cap on the task excerpt one delegation keeps. */
export const DELEGATION_TASK_CHARS = 200
/** Cap on the reply one delegation keeps. */
export const DELEGATION_REPLY_CHARS = 1200
/**
 * Cap on one delegation's ask log. Settling a delegation rewrites `note` with the
 * turn outcome, so a question handed to the delegator cannot live there and still
 * be readable afterwards; this field is what records the hand-off and the
 * delegator's decision, and nothing that settles a row ever touches it.
 */
export const DELEGATION_ASK_LOG_CHARS = 800
/** How many delegations the ledger retains (newest first). */
export const DELEGATION_KEEP = 200
/**
 * How many delivery attempts one callback notice may make before the store
 * stops offering it. A notice whose delivery keeps throwing (the delegator
 * session was deleted, say) must not be retried forever; the failure reason
 * stays in the row's note either way.
 */
export const DELEGATION_NOTICE_MAX_ATTEMPTS = 5
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
  notifiedAt: 0,
  noticeAttempts: 0,
  reply: '',
  note: '',
  askLog: '',
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
    notifiedAt: asTime(value.notifiedAt),
    noticeAttempts: typeof value.noticeAttempts === 'number' && Number.isFinite(value.noticeAttempts) && value.noticeAttempts > 0 ? Math.floor(value.noticeAttempts) : 0,
    reply: typeof value.reply === 'string' ? clip(value.reply, DELEGATION_REPLY_CHARS) : '',
    note: typeof value.note === 'string' ? clip(value.note, 400) : '',
    askLog: typeof value.askLog === 'string' ? clip(value.askLog, DELEGATION_ASK_LOG_CHARS) : '',
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
  // A row written before `notifiedAt` existed carries no delivery marker, and
  // the pre-4 code announced every settled row (repeatedly, which is the bug),
  // so a settled legacy row was delivered unless its note records a failed
  // attempt. Back-filling `notifiedAt` for those keeps the upgrade from firing
  // one final catch-up round over the whole history, while leaving a genuinely
  // undelivered row for the recovery pass to retry once.
  const legacyRows = !(typeof parsed.version === 'number' && parsed.version >= STATE_VERSION)
  for (const value of delegations) {
    const delegation = normalizeDelegation(value)
    if (delegation === null) continue
    if (legacyRows && delegation.status !== 'pending' && delegation.notifiedAt === 0 && !delegation.note.includes('回调未投递')) {
      delegation.notifiedAt = delegation.settledAt > 0 ? delegation.settledAt : Date.now()
    }
    state.delegations.push(delegation)
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

// ── one writer per state file, per PROCESS (not per module instance) ─────────
//
// The cache and the write queue are keyed on the resolved state path in a
// process-global registry rather than on module-local bindings, and for the same
// reason `readState`/`flush` are stat-validated: this package's plugin file can
// be evaluated more than once in one process (a re-imported row, a second
// embedded runtime, a copied install). Module-local state would then give each
// instance its own cache and its own serialization queue, so two instances could
// both read a delegation as `pending`, both settle it and both enqueue a
// callback notice — the duplicate-delivery failure this file's delegation
// comment describes. Sharing the slot makes the "claim" in `settleDelegation`
// atomic across every instance in the process, which is what the caller relies
// on to notify exactly once.
const REGISTRY = Symbol.for('dsh-session-manager.store.v2')

/** The process-global store registry, created on first use. */
const registry = () => {
  const holder = globalThis
  const existing = holder[REGISTRY]
  if (existing !== undefined && existing !== null && typeof existing === 'object' && existing.files instanceof Map && existing.noticeInFlight instanceof Set) return existing
  const created = { files: new Map(), noticeInFlight: new Set() }
  holder[REGISTRY] = created
  return created
}

/** The shared `{ cache, stamp, queue, serial }` slot for one state path. */
const slotFor = (path) => {
  const files = registry().files
  let slot = files.get(path)
  if (slot === undefined) {
    slot = { cache: null, stamp: null, queue: Promise.resolve(), serial: 0 }
    files.set(path, slot)
  }
  return slot
}

/** Identity of the file on disk, or null when it does not exist yet. */
const fileStamp = async (path) => {
  try {
    const info = await stat(path)
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
  const path = statePath()
  const slot = slotFor(path)
  const current = await fileStamp(path)
  if (slot.cache !== null && current === slot.stamp) return slot.cache
  let raw = null
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    raw = null
  }
  slot.cache = raw === null ? await seedFromLegacy() : parseState(raw)
  slot.stamp = current
  return slot.cache
}

/** Write the whole state atomically and install it as the cache. */
const flush = async (state) => {
  const path = statePath()
  const slot = slotFor(path)
  await mkdir(stateDir(), { recursive: true })
  // The temp name is unique per write, not just per process: two module
  // instances in one process share `process.pid`, and a name derived from it
  // alone lets one instance rename away a temp file the other is still writing.
  slot.serial += 1
  const temp = `${path}.${String(process.pid)}.${String(slot.serial)}.tmp`
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(temp, path)
  slot.cache = state
  slot.stamp = await fileStamp(path)
  return slot.cache
}

/**
 * Serialize every write behind one queue — the PROCESS-wide queue for this state
 * path, so two module instances cannot interleave a read-modify-write. A change
 * function returning null means "nothing changed", which skips the file write
 * entirely.
 */
const change = (mutator) => {
  const slot = slotFor(statePath())
  const run = slot.queue.then(async () => {
    const state = await readState()
    const next = await mutator(state)
    return next === null ? state : flush(next)
  })
  slot.queue = run.then(() => undefined, () => undefined)
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
 * Persist the title one session is now known to carry, leaving its lineage alone.
 *
 * `observe` is the wrong writer for this: it is the listing's "what I just saw"
 * projection and it REPLACES every field it is given, so a row carrying only a
 * title would also blank that session's `parentId`, `kind` and `cwd` — renaming a
 * fork child would silently reclassify it as top-level and drop its parent edge.
 * This touches the one field it was asked about and nothing else, which is also
 * why it is a separate export rather than a flag on `observe`.
 *
 * @returns the updated state, or null when nothing changed.
 */
export const setTitle = (sessionId, title) =>
  change((state) => {
    const existing = state.byId[sessionId]
    const value = asText(title, TITLE_MAX_CHARS)
    if (existing !== undefined && existing.title === value) return null
    const byId = { ...state.byId }
    const record = { ...(existing ?? blankRecord()), title: value, updatedAt: Date.now() }
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
 * Settle one delegation that is still pending, returning the settled record.
 *
 * This is the **claim**: it is the only place a delegation moves out of
 * `pending`, and it runs inside the store's serialized write queue, so when
 * several watchers observe the same pending row in the same tick exactly one of
 * them gets a non-null record. Callers MUST notify only on a non-null return —
 * a null means "another pass already claimed (or dismissed) this row", and
 * notifying anyway is what delivered the same callback many times over. A
 * record that already settled is likewise left alone and answers null.
 *
 * @returns the settled record for the winner, or null when nothing changed.
 */
export const settleDelegation = (id, patch) => {
  let settled = null
  return change((state) => {
    settled = null
    const index = state.delegations.findIndex((item) => item.id === id)
    if (index < 0) return null
    if (state.delegations[index].status !== 'pending') return null
    const merged = normalizeDelegation({ ...state.delegations[index], ...patch, settledAt: patch.settledAt !== undefined ? patch.settledAt : Date.now() })
    if (merged === null) return null
    const delegations = state.delegations.slice()
    delegations[index] = merged
    settled = merged
    return { ...state, delegations }
  }).then(() => settled)
}

/**
 * Atomically claim the right to deliver one settled delegation's callback
 * notice, returning the claimed record for exactly one caller.
 *
 * The claim is a synchronous check-and-add on a process-global in-flight set,
 * so it is atomic with respect to every watcher pass in the process — the
 * timer's, a `session_delegations` read's, and a second module instance's. A
 * loser gets null and MUST NOT send. This is the fix for the duplicate
 * deliveries: the old code called `notifyDelegator` off a settle result it never
 * checked, so every concurrent pass that had read the same pending row re-sent
 * the same notice.
 *
 * `noticeAttempts` is incremented durably here, so a notice that keeps failing
 * is bounded across restarts. The claim is deliberately NOT the durable
 * delivered marker: `notifiedAt` is written by {@link markDelegationNotified}
 * only after the delegator's session controller ACCEPTED the notice, so a crash
 * between claiming and sending retries on the next start instead of dropping the
 * callback. The notice's request id is derived from the delegation id, so that
 * retry cannot double-deliver even if the first attempt did reach the target.
 *
 * @returns the claimed record for the winner, or null when it may not deliver.
 */
export const claimDelegationNotice = (id) => {
  const inFlight = registry().noticeInFlight
  if (inFlight.has(id)) return null
  inFlight.add(id)
  let claimed = null
  return change((current) => {
    claimed = null
    const index = current.delegations.findIndex((item) => item.id === id)
    if (index < 0) return null
    const found = current.delegations[index]
    if (found.status === 'pending' || found.notifiedAt > 0 || found.noticeAttempts >= DELEGATION_NOTICE_MAX_ATTEMPTS) return null
    const merged = normalizeDelegation({ ...found, noticeAttempts: found.noticeAttempts + 1 })
    if (merged === null) return null
    const delegations = current.delegations.slice()
    delegations[index] = merged
    claimed = merged
    return { ...current, delegations }
  }).then(() => {
    if (claimed === null) {
      inFlight.delete(id)
      return null
    }
    return claimed
  }, (error) => {
    inFlight.delete(id)
    throw error
  })
}

/**
 * Mark one delegation's callback notice as delivered, durably. Written only
 * after `sessionController.prompt` accepted it, so a restart never re-enqueues a
 * notice that already reached the delegator.
 *
 * @returns the updated record, or null when the row is gone.
 */
export const markDelegationNotified = (id) => {
  const inFlight = registry().noticeInFlight
  let marked = null
  return change((state) => {
    marked = null
    const index = state.delegations.findIndex((item) => item.id === id)
    if (index < 0) return null
    const current = state.delegations[index]
    if (current.notifiedAt > 0) return null
    const merged = normalizeDelegation({ ...current, notifiedAt: Date.now() })
    if (merged === null) return null
    const delegations = state.delegations.slice()
    delegations[index] = merged
    marked = merged
    return { ...state, delegations }
  }).then((state) => {
    inFlight.delete(id)
    return marked === null ? null : marked
  }, (error) => {
    inFlight.delete(id)
    throw error
  })
}

/**
 * Release a claim whose delivery failed, so a later pass may retry it. The
 * attempt was already counted when the claim was taken, so this cannot loop
 * forever.
 *
 * @returns true when a claim was outstanding and is now free.
 */
export const releaseDelegationNotice = (id) => {
  registry().noticeInFlight.delete(id)
  return true
}

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

/**
 * Append one line to a delegation's ask log — the record of a question handed to
 * the delegator and of its decision. Unlike `note`, this survives settling:
 * `settleDelegation` rewrites `note` with the turn outcome, which is why an ask
 * cannot be remembered there.
 *
 * @returns the updated record, or null when the delegation is absent or the log
 *   did not change.
 */
export const appendAskLog = (id, text) =>
  change((state) => {
    const index = state.delegations.findIndex((item) => item.id === id)
    if (index < 0) return null
    const current = state.delegations[index]
    const line = typeof text === 'string' ? text.trim() : ''
    if (line.length === 0) return null
    const askLog = current.askLog.length > 0 ? `${current.askLog}\n${line}` : line
    const merged = normalizeDelegation({ ...current, askLog })
    if (merged === null || merged.askLog === current.askLog) return null
    const delegations = state.delegations.slice()
    delegations[index] = merged
    return { ...state, delegations }
  })

/** Forget one delegation record. */
export const dropDelegation = (id) =>  change((state) => {
    const delegations = state.delegations.filter((item) => item.id !== id)
    return delegations.length === state.delegations.length ? null : { ...state, delegations }
  })

/** Every delegation still waiting for its target, oldest first. */
export const pendingDelegations = (state) => (state !== null && state !== undefined && Array.isArray(state.delegations) ? state.delegations.filter((item) => item.status === 'pending') : [])

/**
 * Every settled delegation whose callback notice has not been delivered yet,
 * oldest first. This is the watcher's recovery set: a row whose notice was lost
 * to a process exit between the settle and the delivery, or whose delivery threw
 * and was released for retry, shows up here and nowhere else. The attempt cap
 * keeps a permanently undeliverable notice from being retried forever.
 */
export const undeliveredDelegations = (state) =>
  state !== null && state !== undefined && Array.isArray(state.delegations)
    ? state.delegations
        .filter((item) => item.status !== 'pending' && item.notifiedAt === 0 && item.noticeAttempts < DELEGATION_NOTICE_MAX_ATTEMPTS)
        .sort((left, right) => left.settledAt - right.settledAt)
    : []
