// ④ Ask bridge — a delegated worker's question is the delegator's to decide.
//
// `ask_user_question` (@deepseek-ai/dsh-tool-ask-user) never times out: it awaits
// the Agent-scoped `user-questions/request` waterfall until an answerer answers
// or the calling turn's signal aborts. The seam rejects a runtime-OWNED child
// (`DELEGATED_CALLER`) precisely because such a child has no human answerer — but
// a session delegated with `session_send` is its own runtime ROOT, so it passes
// that guard, reaches the waterfall, and only ITS OWN session's browser client can
// answer it. Nobody is watching that session, so the tool call blocks forever.
// That is the 107-minute stall: the task was finished and the worker sat inside
// one unanswered tool call.
//
// This module installs the answerer that case is missing, on the HOST plane, once
// per process (NOT per session — a preset row mounts one copy per session and a
// worker usually runs a different preset, so a preset-scoped listener would never
// see the worker's question):
//
//   * A question whose asking agent is the TARGET of any delegation in the ledger
//     is claimed here instead of being left for a browser that may not exist. The
//     listener is registered `prepend`, so it decides before the api-remotes
//     forwarder parks the same request on an absent browser. The delegation may
//     already be settled: a follow-up sent without `callback: true` records no new
//     row, and its delegator is still the one to decide.
//   * The question is delivered into the DELEGATOR's own session as ONE queued
//     prompt, through the very same `sessionController.prompt` primitive and the
//     same derived-`requestId` dedupe (`hasPromptRequest`) the settlement callbacks
//     use. One delivery path, no second mechanism, and no session-manager tool is
//     modified.
//   * The delegator decides by sending one ordinary message back to the worker
//     (`session_send`); that reply lands in the worker's inbox as a durable user
//     message. This module watches that inbox insertion and returns the reply text
//     as the question's answer, so the worker's blocked tool call unblocks.
//   * There is no grace window on the worker's own UI, no fallback option, and no
//     invented answer. The worker keeps waiting until the delegator decides. The
//     only other ways out are an abort — the worker's turn was cancelled — and a
//     delivery failure, both of which fail the tool call instead of pretending an
//     answer existed. A question nobody can decide is a failure, not a guess.
//
// Foreground human use is untouched: a question from a session that is not a
// delegation target falls straight through with `next()`, exactly as before this
// row existed.
//
// Plane: host composition. It publishes no service (so it needs no `isolate`
// realm) and must be mounted exactly once per process; see `INSTALL.md`.
//
// It imports `./store.mjs` — the one durable ledger — by relative path, so it
// shares that module's single reader/writer over
// `<DSH_HOME>/session-manager/state.json` rather than opening the file again.

import { createHash } from 'node:crypto'
import { appendAskLog, readState } from './store.mjs'

/** How long the delegator has to decide. `0` — the default — waits forever. */
export const DEFAULT_TIMEOUT_MS = 0
/** Smallest bound a positive value is floored to, in milliseconds. */
export const MIN_TIMEOUT_MS = 15000
/** Largest bound accepted, in milliseconds (one day). */
export const MAX_TIMEOUT_MS = 86400000

/** Prefix of the ask notice's prompt correlation id; distinct from the settlement notice's. */
export const ASK_NOTICE_PREFIX = 'preset-delegation-ask'
/** Optional marker a reply may carry so one worker's several open asks stay apart. */
export const REPLY_MARKER_PREFIX = '[提问答复 ask='
const REPLY_MARKER_RE = /\[?提问答复 ask=([A-Za-z0-9._-]+)\]?/

const clip = (value, limit) => {
  const text = typeof value === 'string' ? value : ''
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

const shortId = (id) => (typeof id === 'string' ? id.replace(/^session-/, '').slice(0, 8) : String(id ?? ''))

/** Stable digest of a question body: an identical question dedupes, a new one does not. */
export const questionDigest = (questions) => {
  const body = (Array.isArray(questions) ? questions : []).map((question) => ({
    id: question !== null && typeof question === 'object' ? question.id : undefined,
    question: question !== null && typeof question === 'object' ? question.question : undefined,
    options: Array.isArray(question?.options) ? question.options.map((option) => option?.label) : [],
  }))
  return createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 8)
}

/**
 * The identity of one blocked ask. Distinct per question instance, so two identical
 * questions in one task get two distinct records instead of one silently dropped.
 */
export const askIdFor = (delegationId, digest, sequence) => `${ASK_NOTICE_PREFIX}-${delegationId}-${digest}-${sequence}`

/**
 * The prompt correlation id of one ask notice, derived (never minted fresh) so the
 * controller's `hasPromptRequest` dedupe makes a retried delivery a no-op.
 */
export const noticeRequestId = (delegationId, digest, sequence) => `${ASK_NOTICE_PREFIX}-${delegationId}-${digest}-${sequence}`

/** The option this bridge tags as recommended: the tool contract puts it first. */
export const recommendedLabel = (question) => {
  const options = Array.isArray(question?.options)
    ? question.options.filter((option) => option !== null && typeof option === 'object' && typeof option.label === 'string')
    : []
  if (options.length === 0) return null
  const tagged = options.find((option) => /\(recommended\)|（推荐）|\(推荐\)|推荐/i.test(option.label))
  return (tagged ?? options[0]).label
}

/** Match one free-text reply against a question's options; exact first, then substring. */
export const matchOption = (text, question, multiSelect) => {
  const options = Array.isArray(question?.options)
    ? question.options.filter((option) => option !== null && typeof option === 'object' && typeof option.label === 'string')
    : []
  const normalize = (value) => String(value).trim().toLowerCase()
  const reply = normalize(text)
  if (reply.length === 0) return []
  const exact = options.find((option) => normalize(option.label) === reply)
  if (exact !== undefined) return [exact.label]
  const contained = options.filter((option) => reply.includes(normalize(option.label)))
  if (contained.length === 0) return []
  return (multiSelect === true ? contained : [contained[0]]).map((option) => option.label)
}

/** One `id=text` line, for answering several questions with one reply. */
const PER_QUESTION_RE = /^([^\s:=：]+)\s*[:：=]\s*(.+)$/

/**
 * Turn one free-text delegator reply into the answer shape `ask()` resolves with.
 *
 * A reply may carry one `id=text` line per question, for the questions the worker
 * asked; a question with no such line is answered with the whole reply, which is
 * what a single-line answer must do for a single-question ask.
 */
export const answersFromReply = (text, questions) => {
  const body = typeof text === 'string' ? text.trim() : ''
  const list = Array.isArray(questions) ? questions : []
  const byId = new Map()
  for (const line of body.split(/\r?\n/)) {
    const match = PER_QUESTION_RE.exec(line.trim())
    if (match === null) continue
    const id = String(match[1])
    if (list.some((question) => String(question?.id ?? '') === id)) byId.set(id, String(match[2]).trim())
  }
  return {
    answers: list.map((question) => {
      const id = String(question?.id ?? '')
      const forThis = byId.has(id) ? byId.get(id) : body
      const selected = matchOption(forThis, question, question?.multiSelect)
      return {
        id,
        selected,
        ...(selected.length === 0 ? { custom: forThis } : {}),
      }
    }),
  }
}

/** Read the ask id out of a reply's optional marker, or null when it carries none. */
export const parseReplyMarker = (text) => {
  const match = REPLY_MARKER_RE.exec(typeof text === 'string' ? text.trim() : '')
  return match !== null ? match[1] : null
}

/** Drop a reply's marker so it never leaks into the answer's free text. */
export const stripReplyMarker = (text) => {
  const body = typeof text === 'string' ? text.trim() : ''
  const stripped = body.replace(REPLY_MARKER_RE, '').trim()
  return stripped.length > 0 ? stripped : body
}

/** Human-readable duration for a configured bound; never rounds a real wait to "0 秒". */
export const describeWindow = (ms) => {
  const value = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0
  if (value >= 3600000) return `${String(Math.round(value / 3600000))} 小时`
  if (value >= 60000) return `${String(Math.round(value / 60000))} 分钟`
  return `${String(Math.round(value / 1000))} 秒`
}

/** The prompt text delivered into the delegator's session. */
export const renderNotice = (delegation, questions, askId) => {
  const list = Array.isArray(questions) ? questions : []
  const worker = delegation.to
  const lines = [
    `[委托提问] 会话 ${shortId(worker)} 在做你交给它的任务时停下来提问了。它只等你的决定——不会自己猜、也不会超时放行；你不答复，它就会一直等下去。`,
    `任务：「${delegation.task.length > 0 ? clip(delegation.task, 120) : '(no task text)'}」`,
    '',
  ]
  list.forEach((question, index) => {
    const header = typeof question?.header === 'string' && question.header.length > 0 ? `（${question.header}）` : ''
    lines.push(`问题 ${index + 1}/${list.length}${header}`)
    lines.push(`  ${String(question?.question ?? '')}`)
    const options = Array.isArray(question?.options) ? question.options : []
    const recommended = recommendedLabel(question)
    if (options.length > 0) {
      for (const option of options) {
        const tag = option?.label === recommended ? '  ← 推荐' : ''
        const detail = typeof option?.description === 'string' && option.description.length > 0 ? ` — ${option.description}` : ''
        lines.push(`  - ${String(option?.label ?? '')}${detail}${tag}`)
      }
    } else {
      lines.push('  （没有选项：你的答复就是自由文本，会原样作为这个提问的结果返回给它）')
    }
    lines.push('')
  })
  lines.push('答复方式：给它回一条消息，例如')
  lines.push(`  session_send(sessionId="${worker}", text="[Fast (Recommended)]")`)
  lines.push(`  session_send(sessionId="${worker}", text="先按 A 做，遇到 X 再回来问我")`)
  lines.push('你的答复会作为这个提问的结果原样返回给它，然后它继续干活。')
  if (list.length > 1) {
    lines.push('几个问题可以一条消息里分别答复，一行一个：')
    for (const question of list) lines.push(`  ${String(question?.id ?? '')}=[你选的那一项]`)
    lines.push('没有单独答复的问题会按你消息里的通用内容回答。')
  }
  lines.push(`有不止一个问题在等时，在文本开头加上 ${REPLY_MARKER_PREFIX}${askId}] 指定你答的是哪一个。`)
  return lines.join('\n')
}

/** The newest delegation whose target is `workerId` — any state, not just pending. */
export const findDelegation = (state, workerId) => {
  const rows = state !== null && state !== undefined && Array.isArray(state.delegations) ? state.delegations : []
  let best = null
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    if (row.to !== workerId) continue
    if (best === null || row.createdAt > best.createdAt) best = row
  }
  return best
}

/**
 * Normalize one config value into a bound in milliseconds.
 *
 * `0` — the default — means "wait for the delegator forever". A positive finite
 * value is clamped into [MIN_TIMEOUT_MS, MAX_TIMEOUT_MS]; past it the ask fails
 * loudly rather than inventing an answer. Absent, null, non-numeric or negative
 * values all mean "no bound", because guessing a decision is what this module
 * exists to stop.
 */
export const resolveTimeoutMs = (value) => {
  if (value === undefined || value === null || value === 0) return 0
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0
  return Math.min(Math.max(Math.trunc(value), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)
}

export const name = 'session-manager-ask-bridge'

/**
 * No hard dependency: a deployment without `sessionController` must still mount
 * this row (it simply falls through every question), never sit waiting for a
 * service and take the composition down with it.
 */
export const inject = []

export function apply(ctx, config) {
  const timeoutMs = resolveTimeoutMs(config !== null && typeof config === 'object' ? config.timeoutMs : undefined)

  /** askId → the one settle() callback the blocked tool call is waiting on. */
  const waiters = new Map()
  /** workerId → the askIds it currently has open, oldest first. */
  const byWorker = new Map()
  /** Per-delegation counters, so a repeated question gets a distinct id. */
  const counters = new Map()
  const timers = new Set()

  /** Forget one ask that has decided (or failed): it can never settle again. */
  const forget = (askId, workerId) => {
    waiters.delete(askId)
    const open = byWorker.get(workerId)
    if (open === undefined) return
    const rest = open.filter((id) => id !== askId)
    if (rest.length === 0) byWorker.delete(workerId)
    else byWorker.set(workerId, rest)
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      for (const settle of waiters.values()) settle({ kind: 'disposed' })
      waiters.clear()
      byWorker.clear()
    }, 'session-manager: ask-bridge')
  }

  // The reply path. The delegator's `session_send` puts an ordinary user message
  // into the worker's inbox. That append is durable and emits immediately,
  // independent of the worker's blocked turn, so this fires while `ask()` waits.
  ctx.on('agent/inbox/inserted', (payload) => {
    const agent = payload !== null && typeof payload === 'object' ? payload.agent : undefined
    const message = payload !== null && typeof payload === 'object' ? payload.message : undefined
    if (agent === null || agent === undefined || typeof agent.id !== 'string') return
    if (!isUserAuthored(message)) return
    const text = messageText(message).trim()
    if (text.length === 0) return
    const open = byWorker.get(agent.id)
    if (open === undefined || open.length === 0) return
    // A marker pins the reply to one ask; without it the oldest open ask is the
    // one being answered — it is the one still blocking the worker.
    const marked = parseReplyMarker(text)
    const askId = marked !== null && open.includes(marked) ? marked : open[0]
    const settle = waiters.get(askId)
    if (settle === undefined) return
    settle({ kind: 'reply', text: stripReplyMarker(text), askId })
  })

  // `prepend` is what makes this the deciding answerer: api-remotes registers its
  // forwarding listener on the same host plane at boot, and running after it would
  // park a delegated question on a browser that may not be there.
  ctx.on('user-questions/request', async function (request, next) {
    const agent = request !== null && typeof request === 'object' ? request.agent : undefined
    if (agent === undefined || agent === null || typeof agent.id !== 'string') return next()

    // Who sent this session out? Any ledger row targeting it, newest first — a
    // pending one (the task is still running) or a settled one (a follow-up was
    // sent without recording a new delegation). Anything else is a foreground
    // session and goes to its own UI exactly as before this row existed.
    let delegation = null
    try {
      delegation = findDelegation(await readState(), agent.id)
    } catch {
      delegation = null
    }
    if (delegation === null) return next()

    const controller = ctx.get('sessionController')
    if (
      controller === undefined ||
      controller === null ||
      typeof controller.prompt !== 'function' ||
      typeof delegation.from !== 'string' ||
      delegation.from.length === 0
    ) {
      return next()
    }

    const questions = Array.isArray(request.questions) ? request.questions : []
    const digest = questionDigest(questions)
    const sequence = counters.get(delegation.id) ?? 0
    counters.set(delegation.id, sequence + 1)
    const askId = askIdFor(delegation.id, digest, sequence)
    const delegator = delegation.from
    const signal = request.signal

    let settled = false
    let deadline = null
    let decision = null
    const outcome = new Promise((resolve) => { decision = resolve })
    const onAbort = () => settle({ kind: 'abort' })
    const settle = (value) => {
      if (settled) return
      settled = true
      forget(askId, agent.id)
      if (deadline !== null) {
        clearTimeout(deadline)
        timers.delete(deadline)
      }
      if (signal !== undefined && signal !== null && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort)
      }
      decision(value)
    }

    // Register the waiter BEFORE the notice is delivered, so a reply that races
    // the delivery is not lost. If the delivery fails the waiter is released
    // again and the tool call fails — it does not hang with no path at all.
    waiters.set(askId, settle)
    const open = byWorker.get(agent.id)
    if (open === undefined) byWorker.set(agent.id, [askId])
    else open.push(askId)

    try {
      await controller.prompt(
        {
          requestId: noticeRequestId(delegation.id, digest, sequence),
          sessionId: delegator,
          mode: 'queue',
          content: [{ type: 'text', text: renderNotice(delegation, questions, askId) }],
        },
        callerSignal,
      )
    } catch (error) {
      try {
        await appendAskLog(delegation.id, `${askId} 提问无法投递给 ${shortId(delegator)}：${error instanceof Error ? error.message : String(error)}`)
      } catch {
        // Recording the failure is best-effort; failing the tool call is what matters.
      }
      settle({ kind: 'undeliverable', error })
    }

    if (timeoutMs > 0) {
      deadline = setTimeout(() => settle({ kind: 'timeout' }), timeoutMs)
      timers.add(deadline)
    }

    if (signal !== undefined && signal !== null && typeof signal.addEventListener === 'function') {
      if (signal.aborted === true) settle({ kind: 'abort' })
      else signal.addEventListener('abort', onAbort)
    }

    const result = await outcome
    if (result.kind === 'reply') {
      try {
        await appendAskLog(delegation.id, `${askId} 你的答复：${clip(result.text, 200)}`)
      } catch {
        // The reply itself unblocks the worker; the log is observability.
      }
      return answersFromReply(result.text, questions)
    }
    if (result.kind === 'abort') throw new Error('ask_user_question was aborted before the delegator decided')
    if (result.kind === 'timeout') {
      throw new Error(`ask_user_question waited ${describeWindow(timeoutMs)} for the delegator's decision and got none; nothing was answered on its behalf`)
    }
    if (result.kind === 'undeliverable') {
      const reason = result.error !== undefined && result.error !== null
        ? (result.error instanceof Error ? result.error.message : String(result.error))
        : 'no reason given'
      throw new Error(`the delegated question could not be delivered to its delegator session ${delegator} (${reason}); no other answerer exists here, so the question stays unanswered`)
    }
    throw new Error('ask_user_question was left without an answerer: the ask bridge unloaded while waiting for the delegator')
  }, { prepend: true })
}

/** Read the readable text of one user message's content blocks. */
const messageText = (message) => {
  if (message === null || message === undefined || typeof message !== 'object') return ''
  const blocks = Array.isArray(message.content) ? message.content : []
  let out = ''
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

/** Only a real user-authored message counts as the delegator's reply. */
const isUserAuthored = (message) => {
  if (message === null || typeof message !== 'object' || message.role !== 'user') return false
  const source = message.source
  return source !== null && source !== undefined && typeof source === 'object' && source.kind === 'user'
}

/** The signal-shaped argument `sessionController.prompt` requires; nothing here is cancellable. */
const callerSignal = { aborted: false, throwIfAborted() {}, addEventListener() {}, removeEventListener() {} }

export default { name, inject, apply }
