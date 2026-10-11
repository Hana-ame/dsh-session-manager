// Regression test for duplicate delegation-callback delivery.
//
// The failure this pins, observed in a live deployment: one
// `session_send(callback: true)` produced 4+ `[callback]` notices in the
// delegator's session, and `session_delegations(dismiss: <id>)` did not stop
// later ones. Root cause: the watcher notified off `settleDelegation` without
// checking whether THIS pass had actually won the transition, so every pass that
// observed an already-settled row re-sent its notice; and no durable "delivered"
// marker existed, so a restart re-sent everything again.
//
//   node package/test/delegation-idempotency.test.mjs
//
// Exits non-zero when any check fails, so it works as a CI check.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dshHome = await mkdtemp(join(tmpdir(), 'dsh-delegation-idempotency-'))
process.env.DSH_HOME = dshHome

const toolsUrl = new URL('../lib/tools.mjs', import.meta.url)
const statePath = join(dshHome, 'session-manager', 'state.json')
/** The store's process-global registry symbol; clearing it simulates a fresh process. */
const STORE_SYMBOL = Symbol.for('@local/dsh-session-manager.store.v2')

const results = []
const check = (label, condition, detail) => {
  results.push([condition ? 'PASS' : 'FAIL', label, condition ? '' : ` => ${String(detail)}`])
}

// ── a fake context whose prompt() records every notice actually enqueued ──────
//
// `prompted` is the whole point: it is every callback notice THIS process handed
// to the delegator's session controller, which is exactly what used to grow to
// 4+ per delegation.
const prompted = []
const logs = {}
const ticks = []
let failPrompt = false

const makeController = () => ({
  list: async () => ({ items: [] }),
  inspect: async (sessionId) => ({ meta: { id: sessionId }, inheritedEventCount: 0, events: logs[sessionId] ?? [] }),
  prompt: async (request) => {
    // The real controller dedupes on requestId (hasPromptRequest); model that so
    // a retry carrying the same id is observably a no-op, like production.
    if (prompted.some((row) => row.requestId === request.requestId)) return { accepted: true, deduped: true }
    if (failPrompt) throw new Error('delegator session is gone')
    prompted.push({ requestId: request.requestId, sessionId: request.sessionId, text: request.content[0].text })
    return { accepted: true }
  },
  cancel: async () => ({ accepted: true }),
  control: (signal) => (async function* () {
    yield { type: 'baseline', value: { queues: {}, jobs: {}, projections: {} } }
    await new Promise((resolve) => {
      if (signal.aborted) resolve()
      else signal.addEventListener('abort', resolve, { once: true })
    })
  })(),
})

const timer = { interval: (callback) => { ticks.push(callback); return () => {} } }

/** Import a FRESH module instance (bypassing the ESM cache) and apply it. */
const loadPlugin = async () => {
  const { default: register } = await import(`${toolsUrl.href}?instance=${String(Math.random())}`)
  const captured = {}
  register.apply({
    get: (name) => (name === 'sessionController' ? makeController() : (name === 'timer' ? timer : undefined)),
    tools: { register: (definition) => { captured[definition.name] = definition } },
  })
  return captured
}

/** Simulate a process restart: drop the process-global store registry. */
const restartProcess = async () => {
  delete globalThis[STORE_SYMBOL]
  return loadPlugin()
}

const callerExec = { agent: { id: 'me', session: { header: { cwd: '/tmp/repo' } } } }
const ledger = async () => JSON.parse(await readFile(statePath, 'utf8')).delegations
const noticesFor = (id) => prompted.filter((row) => row.text.includes(`delegation ${id} `))
const settle = (text) => [
  { type: 'user/message', seq: 10, time: 10, data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } },
  { type: 'assistant/message', seq: 11, time: 11, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'done and dusted' }] } } },
  { type: 'turn/end', seq: 12, time: 12, data: { turn: 1, reason: { kind: 'completed' } } },
]
const delegationIdOf = (result) => result.text.match(/callback (dlg-[a-z0-9-]+)/)[1]

// ── ① one terminal outcome is delivered exactly once ─────────────────────────

const tools1 = await loadPlugin()
const id1 = delegationIdOf(await tools1.session_send.execute({ sessionId: 'session-t1', text: 'task one', callback: true }, callerExec))
logs['session-t1'] = settle('task one')

// Several passes all observe the same settled row: a timer tick, three explicit
// reads, and three overlapping ticks fired without awaiting between them.
ticks[0]()
await tools1.session_delegations.execute({}, callerExec)
await tools1.session_delegations.execute({}, callerExec)
await tools1.session_delegations.execute({}, callerExec)
await Promise.all([Promise.resolve(ticks[0]()), Promise.resolve(ticks[0]()), Promise.resolve(ticks[0]())])

check('one terminal outcome produces exactly one notice', noticesFor(id1).length === 1, JSON.stringify(noticesFor(id1)))
const row1 = (await ledger()).find((item) => item.id === id1)
check('the row settles done', row1.status === 'done', JSON.stringify(row1))
check('the delivered marker is persisted', row1.notifiedAt > 0, JSON.stringify(row1))

// The notice is a short acknowledgement: it must NOT carry the reply body, and
// must point at session_read for the full delivery. The worker's reply here is
// 'done and dusted'; a notice that quotes it is the old truncating behaviour.
const notice1 = noticesFor(id1)[0].text
check('the notice does not carry the reply body', !notice1.includes('done and dusted'), notice1)
check('the notice reports the reply length', notice1.includes(`${'done and dusted'.length} 字符`), notice1)
check('the notice points at session_read', notice1.includes('session_read'), notice1)

// ── ③ reading the ledger N times adds no deliveries ──────────────────────────

const beforeReads = noticesFor(id1).length
for (let index = 0; index < 25; index += 1) await tools1.session_delegations.execute({}, callerExec)
for (let index = 0; index < 10; index += 1) ticks[0]()
await new Promise((resolve) => setTimeout(resolve, 30))
check('25 reads plus 10 ticks deliver nothing further', noticesFor(id1).length === beforeReads, String(noticesFor(id1).length))

// ── ② dismiss suppresses later delivery ──────────────────────────────────────

// (a) dismiss a row that settles but whose notice could not be delivered.
const tools2 = await loadPlugin()
const id2 = delegationIdOf(await tools2.session_send.execute({ sessionId: 'session-t2', text: 'task two', callback: true }, callerExec))
logs['session-t2'] = settle('task two')
failPrompt = true
ticks[0]()
await tools2.session_delegations.execute({}, callerExec)
failPrompt = false
const settledUndelivered = (await ledger()).find((item) => item.id === id2)
check('a failed delivery leaves the row settled but unnotified',
  settledUndelivered.status === 'done' && settledUndelivered.notifiedAt === 0, JSON.stringify(settledUndelivered))
await tools2.session_delegations.execute({ dismiss: id2 }, callerExec)
check('dismiss forgets the row', (await ledger()).every((item) => item.id !== id2))
for (let index = 0; index < 5; index += 1) await tools2.session_delegations.execute({}, callerExec)
ticks[0]()
await new Promise((resolve) => setTimeout(resolve, 30))
check('a dismissed delegation is never delivered', noticesFor(id2).length === 0, JSON.stringify(noticesFor(id2)))

// (b) dismiss a row that has not even settled yet.
const tools2b = await loadPlugin()
const id2b = delegationIdOf(await tools2b.session_send.execute({ sessionId: 'session-t2b', text: 'task two b', callback: true }, callerExec))
await tools2b.session_delegations.execute({ dismiss: id2b }, callerExec)
logs['session-t2b'] = settle('task two b')
ticks[0]()
await tools2b.session_delegations.execute({}, callerExec)
await new Promise((resolve) => setTimeout(resolve, 30))
check('a delegation dismissed before settling is never delivered', noticesFor(id2b).length === 0, JSON.stringify(noticesFor(id2b)))

// ── ④ a restart does not re-deliver an already-notified row ──────────────────

const tools3 = await loadPlugin()
const id3 = delegationIdOf(await tools3.session_send.execute({ sessionId: 'session-t3', text: 'task three', callback: true }, callerExec))
logs['session-t3'] = settle('task three')
ticks[0]()
await tools3.session_delegations.execute({}, callerExec)
const afterFirst = noticesFor(id3).length
check('the pre-restart row was delivered once', afterFirst === 1, String(afterFirst))

logs['session-t3'] = settle('task three')
const toolsRestarted = await restartProcess()
await toolsRestarted.session_delegations.execute({}, callerExec)
ticks[ticks.length - 1]()
await toolsRestarted.session_delegations.execute({}, callerExec)
await new Promise((resolve) => setTimeout(resolve, 30))
check('a restarted watcher does not re-deliver a notified row', noticesFor(id3).length === afterFirst, String(noticesFor(id3).length))

// ── ⑤ a crash between settle and delivery still delivers (no lost callback) ───

{
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  state.delegations = [{
    id: 'dlg-orphan-1', from: 'me', to: 'session-orphan', task: 'orphan task', mode: 'queue',
    status: 'done', createdAt: Date.now() - 1000, baselineSeq: 0, settledAt: Date.now() - 500,
    notifiedAt: 0, noticeAttempts: 0, reply: 'orphan reply', note: 'turn ended completed',
  }, ...state.delegations]
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}
const tools5 = await restartProcess()
await tools5.session_delegations.execute({}, callerExec)
ticks[ticks.length - 1]()
await tools5.session_delegations.execute({}, callerExec)
await new Promise((resolve) => setTimeout(resolve, 30))
check('a settled-but-unnotified row is recovered exactly once', noticesFor('dlg-orphan-1').length === 1,
  JSON.stringify(noticesFor('dlg-orphan-1')))
const orphanRow = (await ledger()).find((item) => item.id === 'dlg-orphan-1')
check('the recovered row records its delivery', orphanRow.notifiedAt > 0, JSON.stringify(orphanRow))

// ── ⑥ two module instances racing deliver once, not twice ────────────────────

const id6 = delegationIdOf(await tools5.session_send.execute({ sessionId: 'session-t6', text: 'task six', callback: true }, callerExec))
logs['session-t6'] = settle('task six')
const toolsOther = await loadPlugin()
// Two independent module instances (own caches, own single-flight guards) run a
// pass over the same row at the same time; the process-global claim must let
// exactly one of them send.
await Promise.all([
  tools5.session_delegations.execute({}, callerExec),
  toolsOther.session_delegations.execute({}, callerExec),
  Promise.resolve(ticks[ticks.length - 1]()),
  Promise.resolve(ticks[ticks.length - 2]()),
])
await new Promise((resolve) => setTimeout(resolve, 30))
check('two racing watcher instances deliver once', noticesFor(id6).length === 1, JSON.stringify(noticesFor(id6)))

// ── ⑦ the 4.x upgrade back-fills the marker instead of replaying history ─────
//
// A v3 ledger has no notifiedAt. Replaying every settled row once after an
// upgrade would be a fresh duplicate storm, so the upgrade marks them delivered.

{
  const v3 = {
    version: 3,
    byId: {},
    delegations: [{
      id: 'dlg-legacy-1', from: 'me', to: 'session-legacy', task: 'legacy task', mode: 'queue',
      status: 'done', createdAt: 1, baselineSeq: 0, settledAt: 2, reply: 'old reply', note: 'turn ended completed',
    }],
  }
  await writeFile(statePath, `${JSON.stringify(v3, null, 2)}\n`, 'utf8')
}
const tools7 = await restartProcess()
await tools7.session_delegations.execute({}, callerExec)
ticks[ticks.length - 1]()
await tools7.session_delegations.execute({}, callerExec)
await new Promise((resolve) => setTimeout(resolve, 30))
check('a pre-4 settled row is not replayed after upgrade', noticesFor('dlg-legacy-1').length === 0,
  JSON.stringify(noticesFor('dlg-legacy-1')))

// A legacy settled row whose note records a FAILED attempt was never delivered,
// so the upgrade must still let the recovery pass deliver it once.
{
  const v3 = {
    version: 3,
    byId: {},
    delegations: [{
      id: 'dlg-legacy-2', from: 'me', to: 'session-legacy', task: 'legacy task 2', mode: 'queue',
      status: 'done', createdAt: 1, baselineSeq: 0, settledAt: 2, reply: 'old reply',
      note: 'turn ended completed 回调未投递：delegator session is gone',
    }],
  }
  await writeFile(statePath, `${JSON.stringify(v3, null, 2)}\n`, 'utf8')
}
const tools8 = await restartProcess()
await tools8.session_delegations.execute({}, callerExec)
ticks[ticks.length - 1]()
await tools8.session_delegations.execute({}, callerExec)
await new Promise((resolve) => setTimeout(resolve, 30))
check('a pre-4 row whose delivery failed is still retried once', noticesFor('dlg-legacy-2').length === 1,
  JSON.stringify(noticesFor('dlg-legacy-2')))

// ── report ───────────────────────────────────────────────────────────────────

const failures = results.filter((row) => row[0] === 'FAIL')
for (const [status, label, detail] of results) console.log(`${status}  ${label}${detail}`)
console.log(`\n${results.length - failures.length}/${results.length} passed`)
await rm(dshHome, { recursive: true, force: true })
if (failures.length > 0) process.exit(1)
