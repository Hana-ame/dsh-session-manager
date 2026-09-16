/**
 * `/loop` — fixed-rate periodic inspection for the session-manager preset.
 *
 * A human-facing slash command plus a per-session timer. Every `intervalMs`
 * (default 120 s) the OWNER session runs one silent inspection round:
 *
 *   1. Read the delegation ledger through `readState()` — the durable store
 *      read, which has NO side effects: it never runs the delegation check
 *      pass and never queues a callback notice (unlike `session_delegations`,
 *      whose read intentionally runs a check pass first).
 *   2. Read the session list through `sessionController.list()` — read-only.
 *      This is the same read the existing `session_list` tool uses, so the
 *      "running / idle" view here matches what the coordinator sees.
 *
 * Only when a round has findings is the owner session woken — one queued
 * `[LOOP patrol]` message (the exact delivery mechanism the package already uses
 * for `[callback]`). When a round finds nothing it stays completely silent:
 * no message, no LLM turn, no check pass. This is what keeps a 120 s cadence
 * from ever "spraying a paragraph" at the user.
 *
 * Round rules (both enforced here and repeated inside the tick message):
 *   - Report minimally. One line per finding class.
 *   - The only permitted WRITE is the agent dismissing delegations it has
 *     ALREADY reported to the user, via the unchanged `session_delegations`
 *     `dismiss` action. Nothing is dismissed programmatically by this plugin;
 *     the agent's own judgment plus the durable status guard decide.
 *   - Never dismiss `pending`, `unknown`, or anything the agent is unsure
 *     about — leave it in the ledger.
 *   - Never auto-delegate, never re-deliver a task, never `session_stop` a
 *     session. This plugin does none of those; the tick instruction forbids
 *     them.
 *
 * Lifecycle and idempotency:
 *   - One timer per owner session, keyed by session id in `loops` below.
 *     Re-running `/loop` (with or without a new interval) replaces the timer —
 *     it never stacks a second one. `/loop stop|off` disposes it.
 *   - Each timer is registered through `ctx.effect`, so the timer is also
 *     cleaned up when this plugin's context is disposed (preset unmount /
 *     process exit).
 *   - The tick auto-stops the loop when the owner's agent is no longer live
 *     (session closed), and the loop never survives a process restart: all
 *     state here is in-memory, so after a restart the user re-runs `/loop`.
 *     The ledger itself is durable, so nothing reported is lost.
 *
 * Known interaction with the duplicate-callback bug (see delivery notes):
 * this plugin never invokes `checkDelegations()` / `notifyDelegator()`, so the
 * loop itself adds ZERO check passes and ZERO notifications. The only
 * amplification left is when a woken round makes the agent read
 * `session_delegations` (one check pass per read) — see the report.
 *
 * Plane: the plugin registers a command into the host `commands` registry and
 * consumes host `sessionController` / `agents` / `timer` through `ctx.get`.
 * It publishes no service, so the composition row sits loose — behind an
 * `isolate` realm it would resolve a private registry this preset never
 * populates.
 */
import { readState } from './store.mjs'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join as joinPath } from 'node:path'

/** Default cadence: 120 seconds. */
export const DEFAULT_INTERVAL_MS = 120 * 1000
/** Smallest accepted cadence (protects against accidental spindle loops). */
export const MIN_INTERVAL_MS = 30 * 1000
/** Largest accepted cadence. */
export const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000
/** A session is "suspected stuck" when running with no new prompt for this long. */
export const STUCK_IDLE_MS = 10 * 60 * 1000
/** Once reported, a suspected-stuck session is not re-reported for this long. */
export const STUCK_REPORT_COOLDOWN_MS = 6 * 60 * 60 * 1000
/** Effect label on every owned timer. */
const LOOP_LABEL = 'session-manager: /loop timer'
/** Effect label for the handler-owned cleanup of all loops on ctx dispose. */
const CLEANUP_LABEL = 'session-manager: /loop cleanup'

let requestSeq = 0

/** Mint one prompt correlation id for `sessionController.prompt`. */
const nextRequestId = () => `loop-${Date.now().toString(36)}-${(++requestSeq).toString(36)}`

/** `sessionController.prompt()` needs a signal-shaped argument; nothing here is cancellable. */
const callerSignal = {
  aborted: false,
  throwIfAborted() {},
  addEventListener() {},
  removeEventListener() {},
}

const messageOf = (error) => (error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error))
/** Shorten one opaque id to its distinguishing tail. */
export const shortId = (id) => (typeof id === 'string' && id.length > 10 ? `…${id.slice(id.length - 8)}` : String(id || '?'))
/** Human age like "12m" / "<1m". */
export const fmtAge = (ms) => {
  const minutes = Math.round(ms / 60000)
  return minutes < 1 ? '<1m' : String(minutes) + 'm'
}
/** Parse `/loop <seconds>`; returns null when the input is not a valid interval. */
export const parseIntervalSeconds = (raw) => {
  const text = String(raw === null || raw === undefined ? '' : raw).trim()
  if (text.length === 0) return Math.round(DEFAULT_INTERVAL_MS / 1000)
  if (!/^\d+$/u.test(text)) return null
  const seconds = Number(text)
  if (!Number.isSafeInteger(seconds)) return null
  const ms = seconds * 1000
  if (ms < MIN_INTERVAL_MS || ms > MAX_INTERVAL_MS) return null
  return seconds
}

/**
 * Pure classification of one inspection round — exported for testing.
 *
 * @param {object} input
 * @param {string} input.ownerId - the loop owner session id.
 * @param {object} input.state - a `readState()` ledger value.
 * @param {Array} input.items - `sessionController.list()` rows.
 * @param {number} input.stuckIdleMs - idle threshold for "suspected stuck".
 * @param {Set<string>} [input.surfaced] - delegation ids this loop already surfaced.
 * @param {Map<string, number>} [input.stuckReportedAt] - sessionId → last report time.
 * @param {object} [input.kb] - KB health snapshot (from `sampleKbHealth`); only
 *   findings that changed since the last round are reported:
 *   `{ orphans: string[], dangling: string[], newNodes: string[] }`.
 * @param {Set<string>} [input.kbReportedOrphans] - orphan ids already surfaced.
 * @param {Set<string>} [input.kbReportedDangling] - dangling keys already surfaced.
 * @param {Set<string>} [input.kbReportedNodes] - node ids already surfaced as new.
 * @param {number} [input.now] - clock for tests.
 * @returns {{ newSettled: Array, stuck: Array, kb: Array }} fully conservative findings.
 */
export const classifyRound = ({ ownerId, state, items, stuckIdleMs, surfaced, stuckReportedAt, kb, kbReportedOrphans, kbReportedDangling, kbReportedNodes, now }) => {
  const newSettled = []
  const ledger = state !== null && typeof state === 'object' && Array.isArray(state.delegations) ? state.delegations : []
  for (const delegation of ledger) {
    if (delegation === null || typeof delegation !== 'object') continue
    // Only delegations OWED BY the loop owner. Only done/failed count as
    // settled; `unknown` explicitly does not (nothing confirmed it), matching
    // the "宁可留着" rule.
    if (delegation.from !== ownerId) continue
    if (delegation.status !== 'done' && delegation.status !== 'failed') continue
    if (surfaced !== undefined && surfaced !== null && surfaced.has(delegation.id)) continue
    newSettled.push(delegation)
  }
  const stuck = []
  const stamp = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
  if (Array.isArray(items)) {
    for (const item of items) {
      if (item === null || typeof item !== 'object') continue
      if (item.sessionId === ownerId) continue
      // Subagent children are not manageable by this preset; skip them.
      if (item.origin === 'subagent') continue
      if (item.running !== true) continue
      if (typeof item.updatedAt !== 'number' || !Number.isFinite(item.updatedAt) || item.updatedAt <= 0) continue
      const idleMs = stamp - item.updatedAt
      if (idleMs < stuckIdleMs) continue
      // Cooldown: do not re-report the same stuck session over and over.
      if (stuckReportedAt !== undefined && stuckReportedAt !== null) {
        const last = stuckReportedAt.get(item.sessionId)
        if (typeof last === 'number' && stamp - last < STUCK_REPORT_COOLDOWN_MS) continue
      }
      stuck.push({ sessionId: item.sessionId, idleMs })
    }
  }
  // KB health: only report what changed since the last round.
  const kbFindings = []
  if (kb !== null && kb !== undefined && typeof kb === 'object') {
    const orphans = Array.isArray(kb.orphans) ? kb.orphans : []
    const dangling = Array.isArray(kb.dangling) ? kb.dangling : []
    const newNodes = Array.isArray(kb.newNodes) ? kb.newNodes : []
    const freshOrphans = orphans.filter((id) => kbReportedOrphans === undefined || kbReportedOrphans === null || !kbReportedOrphans.has(id))
    const freshDangling = dangling.filter((key) => kbReportedDangling === undefined || kbReportedDangling === null || !kbReportedDangling.has(key))
    const freshNew = newNodes.filter((id) => kbReportedNodes === undefined || kbReportedNodes === null || !kbReportedNodes.has(id))
    if (freshOrphans.length > 0) kbFindings.push({ kind: 'orphans', items: freshOrphans })
    if (freshDangling.length > 0) kbFindings.push({ kind: 'dangling', items: freshDangling })
    if (freshNew.length > 0) kbFindings.push({ kind: 'newNodes', items: freshNew })
  }
  return { newSettled, stuck, kb: kbFindings }
}

/**
 * Sample knowledge-base health with pure Node (no shell dependency).
 *
 * Scans the notes directory for markdown files and every wiki-link reference
 * in the indexes directory tree, then reports:
 *   - orphans  — note ids that appear in NO index file (unregistered nodes);
 *   - dangling — index references whose target note id does not exist
 *                (keys are "referencing-file -> target", first N only);
 *   - newNodes — note ids not present in prevNodeIds (new since last round).
 *
 * Pure Node: uses node:fs and node:path only, so the loop can run it every
 * tick without a shell. Exporting it keeps the scan unit-testable.
 *
 * @param {string} kbRoot - absolute path to the knowledge base root.
 * @param {Set<string>} [prevNodeIds] - node ids seen last round (default empty).
 * @param {number} [limit] - cap on dangling entries (default 10).
 * @returns {Promise<{ orphans: string[], dangling: string[], newNodes: string[] }>}
 */
export const sampleKbHealth = async (kbRoot, prevNodeIds = new Set(), limit = 10) => {
  const notesDir = joinPath(kbRoot, 'notes')
  const indexesDir = joinPath(kbRoot, 'indexes')
  let noteFiles = []
  try { noteFiles = readdirSync(notesDir).filter((f) => f.endsWith('.md')) } catch { noteFiles = [] }
  // note id = filename minus .md
  const nodeIds = new Set(noteFiles.map((f) => f.slice(0, -3)))
  // collect index files recursively
  const indexFiles = []
  const walk = (dir) => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = joinPath(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.md')) indexFiles.push(full)
    }
  }
  walk(indexesDir)
  // every [[id]] in index files
  const referenced = new Set()
  const danglingKeys = []
  for (const file of indexFiles) {
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { continue }
    const re = /\[\[([a-z0-9-]+)\]\]/gi
    let m
    while ((m = re.exec(text)) !== null) {
      const id = m[1]
      if (!nodeIds.has(id)) {
        const key = `${basename(file)} -> ${id}`
        if (!danglingKeys.includes(key)) danglingKeys.push(key)
      } else {
        referenced.add(id)
      }
    }
  }
  const orphans = [...nodeIds].filter((id) => !referenced.has(id)).sort()
  const newNodes = [...nodeIds].filter((id) => !prevNodeIds.has(id)).sort()
  return { orphans, dangling: danglingKeys.slice(0, limit), newNodes }
}

/** Frame the one queued tick message. Findings are assumed non-empty. */
export const frameLoopTick = (facts, intervalSeconds) => {
  const lines = [`[LOOP patrol] 定时巡检（每 ${String(intervalSeconds)} 秒一轮）发现：`]
  if (facts.newSettled.length > 0) {
    const detail = facts.newSettled
      .map((delegation) => `${shortId(delegation.id)}(→${shortId(delegation.to)}, ${delegation.status})`)
      .join('、')
    lines.push(`- 新结算委托 ${String(facts.newSettled.length)} 个：${detail}`)
  }
  if (facts.stuck.length > 0) {
    const detail = facts.stuck
      .map((stuck) => `${shortId(stuck.sessionId)}（running，已 ${fmtAge(stuck.idleMs)} 无新进展）`)
      .join('、')
    lines.push(`- 疑似卡住会话 ${String(facts.stuck.length)} 个：${detail}`)
  }
  if (Array.isArray(facts.kb) && facts.kb.length > 0) {
    for (const finding of facts.kb) {
      if (finding.kind === 'orphans') {
        lines.push(`- 知识库新增孤儿节点 ${String(finding.items.length)} 个（未被任何索引登记）：${finding.items.slice(0, 8).join('、')}${finding.items.length > 8 ? ' …' : ''}`)
      } else if (finding.kind === 'dangling') {
        lines.push(`- 知识库新增悬空引用 ${String(finding.items.length)} 条：${finding.items.slice(0, 4).join('、')}${finding.items.length > 4 ? ' …' : ''}`)
      } else if (finding.kind === 'newNodes') {
        lines.push(`- 知识库新增节点 ${String(finding.items.length)} 个：${finding.items.slice(0, 8).join('、')}${finding.items.length > 8 ? ' …' : ''}`)
      }
    }
  }
  lines.push(
    '请：① 向用户极简汇报以上事实（每类一行，可合并）；'
    + '② 对「你已经向用户汇报过」的已结算委托，用 session_delegations(dismiss=委托id) 清理 delegation ledger；'
    + '③ 知识库类目只汇报、不要自行改库（新增孤儿/悬空/节点提醒是给协调者的信号，登记/订正由协调者决定）；'
    + '绝不 dismiss pending/unknown/状态拿不准的条目；'
    + '④ 不要派活、不要重投任务、不要 session_stop。',
  )
  return lines.join('\n')
}

/**
 * Create one loop runtime against injected dependencies (exported for tests).
 *
 * @param {object} deps
 * @param {() => object|undefined} deps.controller - resolves `sessionController`.
 * @param {() => object|undefined} deps.agents - resolves the `agents` service.
 * @param {(callback: () => void, ms: number) => () => void} deps.startInterval - returns a disposer.
 * @param {() => Promise<object>} deps.readLedger - durable ledger read; defaults to `readState()`.
 */
export const createLoopRuntime = ({ controller, agents, startInterval, readLedger = readState, kbRoot, kbSampler = sampleKbHealth }) => {
  /** sessionId → { intervalMs, dispose, lastTickAt, surfaced, stuckReportedAt } */
  const loops = new Map()

  const prompt = (sessionId, text) => {
    const controllerValue = controller()
    if (controllerValue === null || controllerValue === undefined || typeof controllerValue.prompt !== 'function') {
      throw new Error('sessionController is unavailable; cannot wake the loop owner.')
    }
    return controllerValue.prompt(
      { requestId: nextRequestId(), sessionId, mode: 'queue', content: [{ type: 'text', text }] },
      callerSignal,
    )
  }

  /** Stop one owner's loop (its timer, its entry). Idempotent. */
  const stop = (sessionId) => {
    const entry = loops.get(sessionId)
    if (entry === undefined) return false
    try {
      entry.dispose()
    } catch (error) {
      // The timer is already gone; dropping the entry is the important part.
    }
    loops.delete(sessionId)
    return true
  }

  /** Start (or replace) one owner's loop. Never stacks a second timer. */
  const start = (sessionId, intervalMs, label) => {
    const previous = loops.get(sessionId)
    const wasRunning = previous !== undefined
    const hadSameInterval = wasRunning && previous.intervalMs === intervalMs
    // Preserve per-owner bookkeeping across an interval change.
    const surfaced = previous !== undefined ? previous.surfaced : new Set()
    const stuckReportedAt = previous !== undefined ? previous.stuckReportedAt : new Map()
    const kbReportedOrphans = previous !== undefined ? previous.kbReportedOrphans : new Set()
    const kbReportedDangling = previous !== undefined ? previous.kbReportedDangling : new Set()
    const kbReportedNodes = previous !== undefined ? previous.kbReportedNodes : new Set()
    const lastTickAt = previous !== undefined ? previous.lastTickAt : 0
    if (wasRunning) {
      try {
        previous.dispose()
      } catch (error) {
        // Ignore; replace below.
      }
    }
    const entry = {
      intervalMs,
      dispose: () => {},
      lastTickAt,
      surfaced,
      stuckReportedAt,
      kbReportedOrphans,
      kbReportedDangling,
      kbReportedNodes,
      kbSeenNodes: previous !== undefined && previous.kbSeenNodes !== undefined ? previous.kbSeenNodes : new Set(),
    }
    entry.dispose = startInterval(() => {
      void runTick(sessionId)
    }, intervalMs)
    loops.set(sessionId, entry)
    return { wasRunning, hadSameInterval }
  }

  /** Prune per-owner bookkeeping that no longer refers to live ledger rows. */
  const pruneBooks = (entry, ledgerIds) => {
    const seen = new Set(ledgerIds)
    const kept = new Set()
    let changed = false
    for (const id of entry.surfaced) {
      if (seen.has(id)) kept.add(id)
      else changed = true
    }
    if (changed) entry.surfaced = kept
    const cutoff = Date.now() - STUCK_REPORT_COOLDOWN_MS * 2
    for (const [sessionId, at] of entry.stuckReportedAt) {
      if (at < cutoff) entry.stuckReportedAt.delete(sessionId)
    }
  }

  /**
   * Run one inspection round for an owner.
   * @returns {Promise<{prompted: boolean, newSettled: Array, stuck: Array, reason?: string}>}
   */
  const runTick = async (sessionId) => {
    const entry = loops.get(sessionId)
    if (entry === undefined) return { prompted: false, newSettled: [], stuck: [], reason: 'not-running' }
    const agentsValue = agents()
    const controllerValue = controller()
    if (controllerValue === null || controllerValue === undefined || typeof controllerValue.list !== 'function') {
      return { prompted: false, newSettled: [], stuck: [], reason: 'no-controller' }
    }
    // Owner session gone (closed / never resumed) → the loop has nobody to
    // report to: stop it, honestly.
    if (agentsValue === null || agentsValue === undefined || typeof agentsValue.get !== 'function' || agentsValue.get(sessionId) === undefined) {
      stop(sessionId)
      return { prompted: false, newSettled: [], stuck: [], reason: 'owner-closed' }
    }
    let state
    let listed
    try {
      state = await readLedger()
    } catch (error) {
      return { prompted: false, newSettled: [], stuck: [], reason: `ledger-read: ${messageOf(error)}` }
    }
    try {
      listed = await controllerValue.list({}, undefined)
    } catch (error) {
      return { prompted: false, newSettled: [], stuck: [], reason: `list-read: ${messageOf(error)}` }
    }
    const items = listed !== null && listed !== undefined && Array.isArray(listed.items) ? listed.items : []
    // KB health snapshot (pure Node). When no kbRoot is configured the loop
    // keeps its original behavior (ledger + stuck only).
    let kb = null
    if (typeof kbRoot === 'string' && kbRoot.length > 0 && typeof kbSampler === 'function') {
      try {
        kb = await kbSampler(kbRoot, entry.kbSeenNodes)
        entry.kbSeenNodes = new Set(Array.isArray(kb.newNodes) ? kb.newNodes : [])
      } catch (error) {
        kb = null
      }
    }
    const facts = classifyRound({
      ownerId: sessionId,
      state,
      items,
      stuckIdleMs: STUCK_IDLE_MS,
      surfaced: entry.surfaced,
      stuckReportedAt: entry.stuckReportedAt,
      kb,
      kbReportedOrphans: entry.kbReportedOrphans,
      kbReportedDangling: entry.kbReportedDangling,
      kbReportedNodes: entry.kbReportedNodes,
    })
    entry.lastTickAt = Date.now()
    if (facts.newSettled.length === 0 && facts.stuck.length === 0 && facts.kb.length === 0) {
      pruneBooks(entry, Array.isArray(state.delegations) ? state.delegations.map((delegation) => delegation.id) : [])
      return { prompted: false, newSettled: [], stuck: [], kb: [] }
    }
    const text = frameLoopTick(facts, Math.round(entry.intervalMs / 1000))
    try {
      await prompt(sessionId, text)
      for (const delegation of facts.newSettled) entry.surfaced.add(delegation.id)
      for (const stuck of facts.stuck) entry.stuckReportedAt.set(stuck.sessionId, Date.now())
      for (const finding of facts.kb) {
        if (finding.kind === 'orphans') for (const id of finding.items) entry.kbReportedOrphans.add(id)
        if (finding.kind === 'dangling') for (const key of finding.items) entry.kbReportedDangling.add(key)
        if (finding.kind === 'newNodes') for (const id of finding.items) entry.kbReportedNodes.add(id)
      }
      pruneBooks(entry, Array.isArray(state.delegations) ? state.delegations.map((delegation) => delegation.id) : [])
      return { prompted: true, newSettled: facts.newSettled, stuck: facts.stuck, kb: facts.kb }
    } catch (error) {
      // The findings stay unsurfaced: the next tick retries them.
      return { prompted: false, newSettled: facts.newSettled, stuck: facts.stuck, kb: facts.kb, reason: `prompt: ${messageOf(error)}` }
    }
  }

  /** Human text for `/loop status`. */
  const status = async (sessionId) => {
    const entry = loops.get(sessionId)
    if (entry === undefined) return '/loop：当前没有运行中的巡检定时器。\n用法：/loop [秒数|stop|off|status] —— 默认 ' + String(Math.round(DEFAULT_INTERVAL_MS / 1000)) + ' 秒。'
    const ledger = (await readLedger()).delegations.filter((delegation) => delegation.from === sessionId)
    const count = (statusValue) => ledger.filter((delegation) => delegation.status === statusValue).length
    return [
      `巡检：运行中（每 ${String(Math.round(entry.intervalMs / 1000))} 秒一轮）`,
      `上次巡检：${entry.lastTickAt > 0 ? new Date(entry.lastTickAt).toISOString() : '尚未执行'}`,
      `已播报：新结算委托 ${String(entry.surfaced.size)} 个 · 卡住会话冷却内 ${String(entry.stuckReportedAt.size)} 个 · 知识库孤儿/悬空/新节点已报 ${String(entry.kbReportedOrphans.size + entry.kbReportedDangling.size + entry.kbReportedNodes.size)} 项`,
      `知识库监视：${kbRoot.length > 0 ? `开启（${kbRoot}）` : '未配置（仅监视委托与会话）'}`,
      `delegation ledger（本会话发出）：pending ${String(count('pending'))} · done ${String(count('done'))} · failed ${String(count('failed'))} · unknown ${String(count('unknown'))}`,
    ].join('\n')
  }

  /** Count of live loop owners (for diagnostics/tests). */
  const size = () => loops.size

  return { start, stop, status, runTick, size, loops, prompt }
}

export default {
  name: 'loop-control',
  apply(ctx) {
    const controller = () => ctx.get('sessionController')
    const agents = () => ctx.get('agents')
    const timer = ctx.get('timer')
    if (timer === null || timer === undefined || typeof timer.interval !== 'function') {
      // No timer service: this preset's delegation watcher already degrades
      // gracefully in the same situation; so do we.
      return
    }
    const startInterval = (callback, ms) => ctx.effect(() => timer.interval(callback, ms), LOOP_LABEL)
    // KB root: discover the knowledge base next to the preset home when present.
    // Explicitly optional — without it the loop keeps its original behavior.
    let kbRoot = ''
    try {
      const home = ctx.get('home')
      const candidate = home !== null && home !== undefined && typeof home.data === 'string' && home.data.length > 0
        ? home.data
        : homedir()
      const guess = joinPath(candidate, 'knowledge-base')
      if (existsSync(joinPath(guess, 'notes')) && existsSync(joinPath(guess, 'indexes'))) kbRoot = guess
    } catch {
      kbRoot = ''
    }
    const runtime = createLoopRuntime({
      controller,
      agents,
      startInterval,
      kbRoot,
    })

    const handler = (invocation) => {
      const agent = invocation !== null && typeof invocation === 'object' ? invocation.agent : null
      const sessionId = agent !== null && agent !== undefined && typeof agent.id === 'string' ? agent.id : null
      if (sessionId === null || sessionId.length === 0) {
        return { kind: 'error', text: '/loop: 无法识别调用它的会话。' }
      }
      const raw = String(invocation.rawInput === null || invocation.rawInput === undefined ? '' : invocation.rawInput).trim()
      const lower = raw.toLowerCase()
      if (lower === 'stop' || lower === 'off') {
        const stopped = runtime.stop(sessionId)
        return {
          kind: 'success',
          text: stopped ? '/loop：已停止定时巡检。' : '/loop：当前没有运行中的巡检定时器。',
        }
      }
      if (lower === 'status') {
        return runtime.status(sessionId).then(
          (text) => ({ kind: 'success', text }),
          (error) => ({ kind: 'error', text: `/loop status: ${messageOf(error)}` }),
        )
      }
      const seconds = parseIntervalSeconds(raw)
      if (seconds === null) {
        return {
          kind: 'error',
          text: `用法：/loop [秒数|stop|off|status] —— 秒数 ${String(Math.round(MIN_INTERVAL_MS / 1000))}–${String(Math.round(MAX_INTERVAL_MS / 1000))}，默认 ${String(Math.round(DEFAULT_INTERVAL_MS / 1000))} 秒。`,
        }
      }
      const intervalMs = seconds * 1000
      const outcome = runtime.start(sessionId, intervalMs)
      const kbNote = kbRoot.length > 0
        ? '；同时每轮监视知识库（孤儿/悬空/新增节点），有变化才汇报'
        : ''
      return {
        kind: 'success',
        text: outcome.wasRunning
          ? (outcome.hadSameInterval
            ? `/loop：巡检已在运行（每 ${String(seconds)} 秒一轮），未重复注册定时器。`
            : `/loop：已把巡检间隔更新为每 ${String(seconds)} 秒一轮（替换了原定时器，没有并行定时器）。`)
          : `/loop：已启动定时巡检，每 ${String(seconds)} 秒一轮。`
            + '只在发现「新结算委托」「疑似卡住会话」或知识库异常（孤儿/悬空/新增节点）时才唤醒汇报，无事保持静默；'
            + kbNote + '。'
            + '已结算且已向用户汇报过的委托会在巡检轮中由你 dismiss（绝不清理 pending/unknown/拿不准的）。'
            + ' /loop status 查看，/loop stop 停止。',
      }
    }

    const commands = ctx.get('commands')
    if (commands !== null && commands !== undefined && typeof commands.register === 'function') {
      commands.register({
        name: 'loop',
        description: '定时巡检本会话：每 N 秒（默认 120）检查 delegation ledger、会话状态与知识库健康（孤儿/悬空/新增节点），发现新结算委托、疑似卡住会话或知识库异常时唤醒汇报；可 start / 改间隔 / stop。',
        handler,
      })
    }

    // Everything this plugin owns lives in `runtime`; dispose it with the ctx.
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        for (const entry of runtime.loops.values()) {
          try {
            entry.dispose()
          } catch (error) {
            // Best-effort cleanup.
          }
        }
        runtime.loops.clear()
      }, CLEANUP_LABEL)
    }
  },
}