// Tests for the delegated-ask bridge (`lib/ask-bridge.mjs`).
//
// The bridge claims any `ask_user_question` asked by a session that is the target
// of a delegation in the ledger, delivers the question into its DELEGATOR's session
// as one queued prompt — the same `sessionController.prompt` and derived-`requestId`
// dedupe the settlement callbacks use — and then waits for the delegator's decision:
// one ordinary message sent back into the worker's inbox. There is no grace window
// on the worker's own UI, no fallback option, and no invented answer. The only
// exits are the delegator's reply, an abort of the worker's turn, a failed
// delivery, or a configured bound that fails loudly. This test pins all of that.
//
//   node package/lib/ask-bridge.test.mjs

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dshHome = mkdtempSync(join(tmpdir(), 'dsh-ask-bridge-'))
process.env.DSH_HOME = dshHome
process.on('exit', () => { try { rmSync(dshHome, { recursive: true, force: true }) } catch { /* best effort */ } })

const store = await import('./store.mjs')
const bridge = await import('./ask-bridge.mjs')

const DELEGATOR = 'session-delegator-0001'
const WORKER = 'session-worker-0002'
const OTHER = 'session-other-0003'

const results = []
const check = (label, condition, detail) => {
  results.push({ label, condition, detail: condition === true ? '' : ` => ${String(detail)}` })
}

/**
 * Yield to the microtask and I/O queues so an async listener can finish its
 * stat/readFile/writeFile hops. One turn is not enough; several are.
 */
const tick = async (turns = 8) => {
  for (let index = 0; index < turns; index += 1) await new Promise((resolve) => setImmediate(resolve))
}

/** Wait until the bridge has posted at least `count` notices. */
const waitNoticed = async (handle, count) => {
  for (let index = 0; index < 60 && handle.prompted.length < count; index += 1) await tick()
  return handle.prompted.length >= count
}

const question = (over = {}) => ({
  id: 'q1',
  question: 'Which path should I take?',
  options: [{ label: 'Fast (Recommended)' }, { label: 'Careful' }],
  ...over,
})

const UI_ANSWER = { answers: [{ id: 'q1', selected: ['the browser answered'] }] }

/** Capture every timer the bridge schedules, so a wait can be fired on demand. */
const installClock = () => {
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const scheduled = []
  globalThis.setTimeout = (callback, delay) => {
    const handle = { id: scheduled.length, delay: delay ?? 0, callback, cleared: false }
    scheduled.push(handle)
    return handle
  }
  globalThis.clearTimeout = (handle) => {
    if (handle !== null && typeof handle === 'object' && typeof handle.id === 'number') scheduled[handle.id].cleared = true
  }
  return {
    scheduled,
    fire: (index = 0) => {
      const handle = scheduled[index]
      if (handle !== undefined && handle.cleared === false) handle.callback()
    },
    restore: () => { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear },
  }
}

const mount = (opts = {}) => {
  const prompted = []
  const listeners = new Map()
  const effects = []
  const controller = {
    prompt: async (request) => {
      if (opts.promptFails !== undefined) throw new Error(opts.promptFails)
      prompted.push(request)
      return { accepted: true }
    },
  }
  const ctx = {
    get: (name) => (name === 'sessionController' ? (opts.noController === true ? undefined : controller) : opts.services?.[name]),
    on: (name, handler) => {
      const list = listeners.get(name) ?? []
      list.push(handler)
      listeners.set(name, list)
      return () => {}
    },
    effect: (factory, label) => {
      const dispose = factory()
      effects.push({ label, dispose })
      return { dispose: () => {} }
    },
  }
  bridge.apply(ctx, opts.config ?? {})

  /** Run the Agent-scoped waterfall: the bridge's listener first, then the browser. */
  const ask = (request, uiAnswer = UI_ANSWER) => {
    const chain = listeners.get('user-questions/request') ?? []
    let reachedBrowser = false
    const step = async (index) => {
      if (index >= chain.length) {
        reachedBrowser = true
        return uiAnswer
      }
      return chain[index](request, () => step(index + 1))
    }
    const promise = step(0)
    return { promise, reachedBrowser: () => reachedBrowser }
  }

  const inbox = (payload) => { for (const handler of listeners.get('agent/inbox/inserted') ?? []) handler(payload) }
  const reply = (agentId, text, over = {}) => inbox({
    agent: { id: agentId },
    message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }], ...over },
  })
  const dispose = () => { for (const effect of effects) effect.dispose() }

  return { ctx, prompted, ask, inbox, reply, dispose }
}

let sequence = 0
const resetLedger = async () => {
  const state = await store.readState()
  for (const row of state.delegations ?? []) await store.dropDelegation(row.id)
}

const addRow = async (over = {}) => {
  sequence += 1
  const id = `dlg-test-${String(sequence).padStart(4, '0')}`
  const record = {
    id,
    from: DELEGATOR,
    to: WORKER,
    task: 'do the thing',
    mode: 'queue',
    status: 'pending',
    createdAt: Date.now() + sequence,
    baselineSeq: 1,
    ...over,
  }
  await store.addDelegation(record)
  return record
}

const rowById = async (id) => {
  const state = await store.readState()
  return state.delegations.find((row) => row.id === id)
}

// ── 1. A session nobody delegated goes to its own UI, unchanged ──────────────

{
  await resetLedger()
  const h = mount()
  const ask = h.ask({ agent: { id: OTHER }, questions: [question()] })
  const answer = await ask.promise
  check('an undelegated session is answered by its own browser', answer === UI_ANSWER, JSON.stringify(answer))
  check('an undelegated session reaches its own browser', ask.reachedBrowser() === true, 'never reached')
  check('an undelegated session posts no notice', h.prompted.length === 0, JSON.stringify(h.prompted))
}

{
  await resetLedger()
  await addRow({ to: OTHER })
  const h = mount()
  const ask = h.ask({ agent: { id: WORKER }, questions: [question()] })
  const answer = await ask.promise
  check('a question is not claimed for another session delegation', answer === UI_ANSWER, JSON.stringify(answer))
  check('a foreign delegation posts no notice', h.prompted.length === 0, JSON.stringify(h.prompted))
  h.dispose()
}

// ── 2. A delegated worker is handed to its delegator ─────────────────────────

{
  await resetLedger()
  const row = await addRow()
  const h = mount()
  const ask = h.ask({ agent: { id: WORKER }, questions: [question()] })
  await waitNoticed(h, 1)
  check('a delegated question claims the worker and posts one notice', h.prompted.length === 1, JSON.stringify(h.prompted.map((p) => p.requestId)))
  const notice = h.prompted[0]
  check('the notice goes to the delegator session', notice.sessionId === DELEGATOR, notice.sessionId)
  check('the notice is queued, not interrupting', notice.mode === 'queue', notice.mode)
  check('the notice id is derived from the delegation', notice.requestId === bridge.noticeRequestId(row.id, bridge.questionDigest([question()]), 0), notice.requestId)
  const text = notice.content?.[0]?.text ?? ''
  check('the notice carries the question', text.includes('Which path should I take?'), text.slice(0, 200))
  check('the notice lists the options', text.includes('Fast (Recommended)') && text.includes('Careful'), text)
  check('the notice marks the recommendation', /推荐/.test(text), text)
  check('the notice names the worker session id', text.includes(WORKER), text)
  check('the notice shows how to answer', text.includes('session_send') && text.includes(bridge.REPLY_MARKER_PREFIX), text)
  check('the notice says nothing is answered on its behalf', /不会自己猜|不会超时放行/.test(text), text)
  check('the worker browser is never shown a panel', ask.reachedBrowser() === false, 'browser reached')
  h.reply(WORKER, 'Careful')
  const answer = await ask.promise
  check('the delegator reply resolves the blocked tool call', answer.answers?.[0]?.selected?.[0] === 'Careful', JSON.stringify(answer))
  check('an option answer carries no custom text', answer.answers[0].custom === undefined, JSON.stringify(answer))
  h.dispose()
}

{
  await resetLedger()
  const row = await addRow()
  const h = mount()
  const first = h.ask({ agent: { id: WORKER }, questions: [question()] })
  const second = h.ask({ agent: { id: WORKER }, questions: [question()] })
  await waitNoticed(h, 2)
  check('two identical questions get two distinct notices', new Set(h.prompted.map((p) => p.requestId)).size === 2, JSON.stringify(h.prompted.map((p) => p.requestId)))
  check('the notice sequence counts up', h.prompted[1].requestId === bridge.noticeRequestId(row.id, bridge.questionDigest([question()]), 1), h.prompted[1].requestId)
  h.reply(WORKER, 'Fast (Recommended)')
  const answer = await first.promise
  check('the first question is answered first', answer.answers[0].selected[0] === 'Fast (Recommended)', JSON.stringify(answer))
  h.reply(WORKER, 'Careful')
  const answer2 = await second.promise
  check('the second question is answered second', answer2.answers[0].selected[0] === 'Careful', JSON.stringify(answer2))
  h.dispose()
}

// ── 3. The delegator decides; nothing is invented meanwhile ──────────────────

{
  await resetLedger()
  await addRow()
  const clock = installClock()
  const h = mount()
  const ask = h.ask({ agent: { id: WORKER }, questions: [question()] })
  await waitNoticed(h, 1)
  check('nothing is scheduled: the default is to wait forever', clock.scheduled.length === 0, JSON.stringify(clock.scheduled))
  check('no fallback answer is exposed anymore', bridge.defaultAnswers === undefined, 'defaultAnswers still exported')
  h.reply(WORKER, 'just go with A')
  const answer = await ask.promise
  check('free text is returned verbatim as a custom answer', answer.answers[0].custom === 'just go with A', JSON.stringify(answer))
  check('a free-text answer selects no option', answer.answers[0].selected.length === 0, JSON.stringify(answer))
  clock.restore()
  h.dispose()
}

{
  await resetLedger()
  await addRow()
  const h = mount()
  const ask = h.ask({ agent: { id: WORKER }, questions: [question()] })
  await tick()
  let decided = false
  ask.promise.then(() => { decided = true }, () => { decided = true })
  h.reply(WORKER, 'Careful', { source: { kind: 'assistant' } })
  await tick()
  check('a non-user-authored inbox entry is not a decision', decided === false, 'the ask resolved anyway')
  h.reply(WORKER, 'Careful')
  const answer = await ask.promise
  check('the real reply still decides', answer.answers[0].selected[0] === 'Careful', JSON.stringify(answer))
  h.dispose()
}

{
  await resetLedger()
  await addRow()
  const h = mount()
  const ask = h.ask({ agent: { id: WORKER }, questions: [question()] })
  await waitNoticed(h, 1)
  h.reply(OTHER, 'Careful')
  await tick()
  h.reply(WORKER, 'Fast (Recommended)')
  const answer = await ask.promise
  check('a reply to another session is ignored', answer.answers[0].selected[0] === 'Fast (Recommended)', JSON.stringify(answer))
  h.dispose()
}

{
  await resetLedger()
  const row = await addRow()
  const h = mount()
  const first = h.ask({ agent: { id: WORKER }, questions: [question()] })
  const second = h.ask({ agent: { id: WORKER }, questions: [question({ id: 'q2', question: 'Second one?' })] })
  await waitNoticed(h, 2)
  const secondId = h.prompted[1].requestId
  h.reply(WORKER, `${bridge.REPLY_MARKER_PREFIX}${secondId}] Fast (Recommended)`)
  const answer = await second.promise
  check('a marked reply reaches the marked ask', answer.answers[0].selected[0] === 'Fast (Recommended)', JSON.stringify(answer))
  check('the marker does not leak into the answer', JSON.stringify(answer).includes(bridge.REPLY_MARKER_PREFIX) === false, JSON.stringify(answer))
  h.reply(WORKER, 'Careful')
  const answer1 = await first.promise
  check('the unmarked leftover ask is answered next', answer1.answers[0].selected[0] === 'Careful', JSON.stringify(answer1))
  h.dispose()
}

{
  await resetLedger()
  await addRow()
  const h = mount()
  const ask = h.ask({ agent: { id: WORKER }, questions: [question({ multiSelect: true })] })
  await waitNoticed(h, 1)
  h.reply(WORKER, 'I want both Fast (Recommended) and Careful, please')
  const answer = await ask.promise
  check('a multi-select reply selects every matching option', answer.answers[0].selected.length === 2, JSON.stringify(answer))
  h.dispose()
}

{
  await resetLedger()
  await addRow()
  const h = mount()
  const ask = h.ask({ agent: { id: WORKER }, questions: [question(), question({ id: 'q2', question: 'Second one?' })] })
  await waitNoticed(h, 1)
  h.reply(WORKER, 'q1=[Careful]\nq2=go with the first option')
  const answer = await ask.promise
  check('a per-question reply answers each question', answer.answers[0].selected[0] === 'Careful' && answer.answers[1].custom === 'go with the first option', JSON.stringify(answer))
  h.dispose()
}

// ── 4. The record survives settling ──────────────────────────────────────────

{
  await resetLedger()
  const row = await addRow()
  const h = mount()
  const ask = h.ask({ agent: { id: WORKER }, questions: [question()] })
  await waitNoticed(h, 1)
  h.reply(WORKER, 'Careful')
  await ask.promise
  await tick()
  let record = await rowById(row.id)
  check('the decision is written to the delegation ask log', /你的答复：Careful/.test(record.askLog), JSON.stringify(record.askLog))
  await store.settleDelegation(row.id, { status: 'done', reply: 'the task is done', note: 'turn ended completed' })
  record = await rowById(row.id)
  check('settling overwrites the turn note as before', record.note === 'turn ended completed', JSON.stringify(record.note))
  check('settling does NOT erase the ask log', record.askLog.length > 0 && record.askLog.includes('Careful'), JSON.stringify(record.askLog))
  h.dispose()
}

// ── 5. Every exit is either a decision or a failure ──────────────────────────

{
  await resetLedger()
  const row = await addRow()
  const h = mount({ promptFails: 'no such session' })
  const ask = h.ask({ agent: { id: WORKER }, questions: [question()] })
  let message = ''
  try { await ask.promise } catch (error) { message = error.message }
  check('an undeliverable notice fails the tool call', message.includes('could not be delivered'), message)
  check('an undeliverable notice invents no answer', !/selected/.test(message), message)
  const afterFailure = (await rowById(row.id)).askLog
  check('the delivery failure is recorded in the ask log', afterFailure.includes('无法投递'), JSON.stringify(afterFailure))
  h.reply(WORKER, 'Careful')
  await tick()
  check('a late reply cannot revive a failed ask', (await rowById(row.id)).askLog === afterFailure, JSON.stringify((await rowById(row.id)).askLog))
  h.dispose()
}

{
  await resetLedger()
  await addRow()
  const h = mount()
  const controller = new AbortController()
  const ask = h.ask({ agent: { id: WORKER }, questions: [question()], signal: controller.signal })
  await waitNoticed(h, 1)
  let message = ''
  try {
    controller.abort()
    await ask.promise
  } catch (error) { message = error.message }
  check('an aborted turn fails the tool call', message.includes('aborted'), message)
  h.dispose()

  const again = mount()
  const second = again.ask({ agent: { id: WORKER }, questions: [question()] })
  await waitNoticed(again, 1)
  again.reply(WORKER, 'Careful')
  const answer = await second.promise
  check('a worker can ask again after an abort', answer.answers[0].selected[0] === 'Careful', JSON.stringify(answer))
  again.dispose()
}

{
  await resetLedger()
  const row = await addRow()
  const clock = installClock()
  const h = mount({ config: { timeoutMs: 3600000 } })
  const ask = h.ask({ agent: { id: WORKER }, questions: [question()] })
  await waitNoticed(h, 1)
  check('a configured bound schedules exactly one timer', clock.scheduled.length === 1 && clock.scheduled[0].delay === 3600000, JSON.stringify(clock.scheduled))
  let message = ''
  const outcome = ask.promise
  outcome.catch((error) => { message = error.message })
  clock.fire(0)
  await tick()
  await outcome.catch(() => {})
  check('a bound that passes fails loudly', message.includes("delegator's decision") === true || message.includes('delegator'), message)
  check('a bound that passes invents no answer', message.includes('nothing was answered on its behalf'), message)
  check('a failed bound clears the timer', clock.scheduled[0].cleared === true, 'timer still armed')
  clock.restore()
  check('the bound failure is not an invented option', /selected/.test(message) === false, message)
  h.dispose()
}

{
  await resetLedger()
  const row = await addRow({ status: 'done', settledAt: Date.now() })
  const h = mount()
  const ask = h.ask({ agent: { id: WORKER }, questions: [question()] })
  await waitNoticed(h, 1)
  check('a settled delegation is still routed to its delegator', h.prompted.length === 1 && h.prompted[0].sessionId === DELEGATOR, JSON.stringify(h.prompted.map((p) => p.sessionId)))
  h.reply(WORKER, 'Careful')
  const answer = await ask.promise
  check('the settled-delegation reply still decides', answer.answers[0].selected[0] === 'Careful', JSON.stringify(answer))
  h.dispose()
}

{
  await resetLedger()
  await addRow()
  const h = mount({ noController: true })
  const ask = h.ask({ agent: { id: WORKER }, questions: [question()] })
  const answer = await ask.promise
  check('without a controller the question keeps its old path', answer === UI_ANSWER, JSON.stringify(answer))
  check('without a controller the browser is still reached', ask.reachedBrowser() === true, 'never reached')
  h.dispose()
}

{
  await resetLedger()
  await addRow()
  const h = mount()
  const ask = h.ask({ agent: { id: WORKER }, questions: [question()] })
  await tick()
  h.dispose()
  let message = ''
  try { await ask.promise } catch (error) { message = error.message }
  check('unloading the bridge fails the wait, not guesses', message.includes('unloaded'), message)
}

// ── 6. Pure helpers ──────────────────────────────────────────────────────────

check('a question digest is stable', bridge.questionDigest([question()]) === bridge.questionDigest([question()]), 'unstable')
check('a question digest changes with the question', bridge.questionDigest([question()]) !== bridge.questionDigest([question({ question: 'Another?' })]), 'collided')
check('a recommended label is preferred over the first option', bridge.recommendedLabel({ options: [{ label: 'A' }, { label: 'B (Recommended)' }] }) === 'B (Recommended)', String(bridge.recommendedLabel({ options: [{ label: 'A' }, { label: 'B (Recommended)' }] })))
check('a first option stands in for the recommendation', bridge.recommendedLabel({ options: [{ label: 'A' }, { label: 'B' }] }) === 'A', String(bridge.recommendedLabel({ options: [{ label: 'A' }, { label: 'B' }] })))
check('no options mean no recommendation', bridge.recommendedLabel({}) === null, String(bridge.recommendedLabel({})))

check('an exact reply matches one option', bridge.matchOption('Careful', question(), false).join() === 'Careful', JSON.stringify(bridge.matchOption('Careful', question(), false)))
check('a case-insensitive exact match still matches', bridge.matchOption('careful', question(), false).join() === 'Careful', 'no match')
check('a substring reply matches one option', bridge.matchOption('please take the careful route', question(), false).join() === 'Careful', 'wrong')
check('a multi-select substring reply keeps both', bridge.matchOption('fast (recommended) and careful', question(), true).length === 2, 'one only')
check('a single-select substring reply takes the first match', bridge.matchOption('fast (recommended) and careful', question(), false).join() === 'Fast (Recommended)', 'wrong')
check('an empty reply matches nothing', bridge.matchOption('', question(), false).length === 0, 'matched')
check('a non-matching reply matches nothing', bridge.matchOption('something else', question(), false).length === 0, 'matched')

check('an ask id is stable and distinct per sequence', bridge.askIdFor('d1', 'abc12345', 0) === bridge.noticeRequestId('d1', 'abc12345', 0) && bridge.askIdFor('d1', 'abc12345', 1) !== bridge.askIdFor('d1', 'abc12345', 0), bridge.askIdFor('d1', 'abc12345', 0))
check('an ask id keeps its prefix', bridge.askIdFor('d1', 'abc12345', 0).startsWith(bridge.ASK_NOTICE_PREFIX), bridge.askIdFor('d1', 'abc12345', 0))

const MARKER = `${bridge.REPLY_MARKER_PREFIX}abc-123]`
check('a reply marker is parsed', bridge.parseReplyMarker(`${MARKER} text`) === 'abc-123', String(bridge.parseReplyMarker(`${MARKER} text`)))
check('a reply without a marker parses to null', bridge.parseReplyMarker('Careful') === null, String(bridge.parseReplyMarker('Careful')))
check('a marker is stripped from a reply', bridge.stripReplyMarker(`${MARKER} Careful`) === 'Careful', bridge.stripReplyMarker(`${MARKER} Careful`))
check('a marker-only reply keeps its text', bridge.stripReplyMarker(MARKER) === MARKER, bridge.stripReplyMarker(MARKER))

check('no bound is the default', bridge.resolveTimeoutMs(undefined) === 0, String(bridge.resolveTimeoutMs(undefined)))
check('zero means wait forever', bridge.resolveTimeoutMs(0) === 0, String(bridge.resolveTimeoutMs(0)))
check('a negative value means no bound', bridge.resolveTimeoutMs(-5) === 0, String(bridge.resolveTimeoutMs(-5)))
check('a non-numeric value means no bound', bridge.resolveTimeoutMs('soon') === 0, String(bridge.resolveTimeoutMs('soon')))
check('a tiny bound is floored', bridge.resolveTimeoutMs(1) === bridge.MIN_TIMEOUT_MS, String(bridge.resolveTimeoutMs(1)))
check('an enormous bound is capped', bridge.resolveTimeoutMs(1e15) === bridge.MAX_TIMEOUT_MS, String(bridge.resolveTimeoutMs(1e15)))
check('a sane bound is kept', bridge.resolveTimeoutMs(180000) === 180000, String(bridge.resolveTimeoutMs(180000)))

check('a wait is described in minutes', bridge.describeWindow(180000) === '3 分钟', bridge.describeWindow(180000))
check('a wait is described in seconds', bridge.describeWindow(30000) === '30 秒', bridge.describeWindow(30000))
check('a wait is described in hours', bridge.describeWindow(7200000) === '2 小时', bridge.describeWindow(7200000))

check('the newest delegation targeting a worker wins', (() => {
  return bridge.findDelegation({ delegations: [{ id: 'a', to: WORKER, createdAt: 1 }, { id: 'b', to: WORKER, createdAt: 2 }] }, WORKER)?.id === 'b'
})(), 'wrong row')
check('a delegation with no target yields nothing', bridge.findDelegation({ delegations: [{ id: 'a', to: OTHER, createdAt: 1 }] }, WORKER) === null, 'not null')

// ── Report ───────────────────────────────────────────────────────────────────

const failed = results.filter((result) => result.condition !== true)
for (const result of failed) console.log(`FAIL ${result.label}${result.detail}`)
console.log(`${String(results.length - failed.length)}/${String(results.length)} passed`)
if (failed.length > 0) process.exitCode = 1
