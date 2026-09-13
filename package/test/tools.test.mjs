// Smoke test for ../lib/tools.mjs — the tool layer of the package.
//
// Runs the real plugin file against a fake Cordis context and a throwaway
// DSH_HOME, so it exercises the durable store, the transcript extractors, the
// queue reader and the model-route reader without touching a live DSH process
// or the real ~/.dsh:
//
//   node package/test/tools.test.mjs
//
// Exits non-zero when any check fails, so it works as a CI check.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dshHome = await mkdtemp(join(tmpdir(), 'dsh-session-control-test-'))
process.env.DSH_HOME = dshHome

const { default: register } = await import(new URL('../lib/tools.mjs', import.meta.url))
const statePath = join(dshHome, 'session-manager', 'state.json')
/** Read the persisted store, tolerating the file not existing yet. */
const persisted = async () => JSON.parse(await readFile(statePath, 'utf8'))

// ── fake Cordis context ────────────────────────────────────────────────────

const captured = {}
const calls = []
/** Every signal a tool handed to the live control stream, so cancellation is observable. */
const controlSignals = []

const events = [
  { type: 'user/message', seq: 1, time: 1000, data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello there' }], source: { kind: 'user' } } },
  { type: 'assistant/message', seq: 2, time: 2000, data: { turn: 1, step: 1, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'hi back' }, { type: 'reasoning', text: 'secret thoughts' }], source: { kind: 'model', provider: 'p', model: 'm' } } } },
  { type: 'tool/call', seq: 3, time: 3000, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } },
  { type: 'tool/result', seq: 4, time: 4000, data: { turn: 1, step: 1, message: { id: 'm3', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'file-a\nfile-b' }] }], source: { kind: 'tool', callId: 'c1' } } } },
  { type: 'tool/result', seq: 5, time: 5000, data: { turn: 1, step: 1, message: { id: 'm4', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'boom' }], isError: true }], source: { kind: 'tool', callId: 'c2' } }, error: { name: 'ToolError', code: 'EXPLODED' } } },
  { type: 'system/message', seq: 6, time: 6000, data: { turn: 1, step: 1, message: { id: 'm5', role: 'system', content: [{ type: 'text', text: 'injected context' }], source: { kind: 'plugin', plugin: 'x' } } } },
  { type: 'session/title', seq: 7, time: 7000, data: { title: 'My title', messageSeqs: [], source: { kind: 'user' } } },
  { type: 'request/header', seq: 8, time: 8000, data: { header: { config: { provider: 'p9', model: 'm9', reasoningEffort: 'high' } }, reason: 'initial' } },
  { type: 'model/selection', seq: 9, time: 9000, data: { provider: 'p8', model: 'm8' } },
]

const controller = {  list: async () => ({ items: [
    { sessionId: 'session-a', updatedAt: 1700000000000, running: true, blank: false, cwd: '/tmp/repo', projections: { values: { title: 'Alpha', modelSelection: { lastUsed: { provider: 'p1', model: 'm1' }, next: { provider: 'p2', model: 'm9', reasoningEffort: 'low' } } } } },
    { sessionId: 'session-b', updatedAt: 1690000000000, running: false, blank: false, cwd: '/tmp/repo', parentSessionId: 'session-a', projections: { values: { title: 'Alpha · fork' } } },
    { sessionId: 'session-c', updatedAt: 1680000000000, running: false, blank: false, cwd: '/tmp/repo', parentSessionId: 'session-a', origin: 'subagent' },
  ] }),
  inspect: async () => ({ meta: { id: 'session-a', cwd: '/tmp/repo' }, inheritedEventCount: 0, events }),
  prompt: async (request) => { calls.push(['prompt', request.sessionId, request.mode, request.content[0].text]); return { accepted: true } },
  cancel: async (request) => { calls.push(['cancel', request.sessionId]); return { accepted: true } },
  control: (signal) => {
    controlSignals.push(signal)
    return (async function* () {
      calls.push(['control'])
      yield { type: 'baseline', value: { queues: {
        'session-a': [
          { id: 'msg-queued-01', placement: 'queued', message: { id: 'msg-queued-01', content: [{ type: 'text', text: 'run the tests after this turn' }] } },
          { id: 'msg-steering-02', placement: 'steering', message: { id: 'msg-steering-02', content: [{ type: 'text', text: 'stop and report' }] } },
          { id: 'msg-long-03', placement: 'queued', message: { id: 'msg-long-03', content: [{ type: 'text', text: 'x'.repeat(600) }] } },
        ],
        'session-live-empty': [],
      }, jobs: {}, projections: {} } }
      // A real control stream stays open until its caller aborts; the tool must
      // take the baseline and release the stream rather than wait for more frames.
      await new Promise((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', resolve, { once: true })
      })
      calls.push(['control-released'])
    })()
  },
  fork: async (request) => { calls.push(['fork', request.sessionId, String(request.atSeq)]); return { sessionId: 'session-forked' } },
  rename: async (request) => { calls.push(['rename', request.sessionId, request.title]); return { title: request.title, seq: 99 } },
  modelCatalog: async () => ({
    default: { provider: 'p1', model: 'm1' },
    routableProviders: ['p1', 'p2'],
    groups: [
      { id: 'p1', name: 'Provider One', models: [
        { id: 'm1', name: 'Model One', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' } },
        { id: 'm2' },
      ] },
      { id: 'p2', name: 'Provider Two', models: [] },
    ],
    failures: [{ id: 'p3', name: 'Provider Three', message: 'no credential' }],
  }),
  selectModel: async (request) => {
    calls.push(['selectModel', request.sessionId, request.provider, request.model, String(request.reasoningEffort)])
    return { selected: { provider: request.provider, model: request.model, ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }) } }
  },
}

/** The host command registry: `/compact` is what session_compact drives. */
const commands = {
  execute: async (agent, line, attachments, signal) => {
    calls.push(['command', agent.id, line, String(signal !== undefined && signal !== null), String(attachments.length)])
    if (agent.id === 'session-busy') return { commandId: 'cmd-busy', result: { kind: 'error', text: 'Compaction is unavailable because this process has an active compaction, or the agent is not idle.' } }
    if (agent.id === 'session-minimal' || agent.id === 'session-cold') return undefined
    return { commandId: 'cmd-1', result: { kind: 'success', text: 'Compacted 12 history items (~3400 tokens).' } }
  },
}
/** Everything has a live agent here except `session-cold`, which never attached. */
const agents = { get: (id) => (id === 'session-cold' ? undefined : { id }) }

register.apply({
  get: (name) => (name === 'sessionController' ? controller : (name === 'commands' ? commands : (name === 'agents' ? agents : undefined))),
  tools: { register: (definition) => { captured[definition.name] = definition } },
})

// ── assertions ─────────────────────────────────────────────────────────────

const callerExec = { agent: { id: 'me', session: { header: { cwd: '/tmp/repo' } } } }
const bareExec = { agent: undefined }
const results = []
const check = (label, condition, detail) => {
  results.push([condition ? 'PASS' : 'FAIL', label, condition ? '' : ` => ${String(detail)}`])
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

check('ten tools registered', same(Object.keys(captured).sort(), [
  'session_compact', 'session_describe', 'session_fork', 'session_list', 'session_model', 'session_models', 'session_queue', 'session_read', 'session_send', 'session_stop',
]), Object.keys(captured).join(','))

// The pre-0.2 note file must survive an in-place upgrade. Seed one before the
// store has ever been read, then check it is what the tool reports.
await mkdir(join(dshHome, 'session-manager'), { recursive: true })
await writeFile(
  join(dshHome, 'session-manager', 'descriptions.json'),
  JSON.stringify({ version: 1, byId: { 'session-legacy': { description: 'migrated note', updatedAt: 1 } } }),
)
check('legacy notes migrate into the store',
  (await captured.session_describe.execute({ sessionId: 'session-legacy' })).text.includes('migrated note'))

// session_list
const list = await captured.session_list.execute({ scope: 'workspace' }, callerExec)
check('list ok', list.ok === true, list.text)
check('missing caller cwd is explicit, not silently empty',
  (await captured.session_list.execute({ scope: 'workspace' }, bareExec)).ok === false)
check('list distinguishes fork from subagent',
  list.text.includes('fork of session-a') && list.text.includes('subagent child of session-a'), list.text)
check('list shows each model route', list.text.includes('session-a') && list.text.includes('| model p2/m9'), list.text)
check('list shows unknown route when no projection', list.text.includes('| model (unknown)'), list.text)

// session_models
const models = await captured.session_models.execute({})
check('models lists default', models.text.includes('deployment default: p1/m1'), models.text)
check('models lists grouped ids and efforts', models.text.includes('p1/m1') && models.text.includes('efforts: low/high (default low)'), models.text)
check('models reports discovery failures', models.text.includes('p3: no credential'), models.text)
check('models survives an empty provider group', models.text.includes('p2 (Provider Two):') && models.text.includes('(no models listed)'), models.text)

// session_model: read
const readA = await captured.session_model.execute({ sessionId: 'session-a' }, callerExec)
check('model read prefers the projection', readA.text.includes('next request will use: p2/m9 (effort low)') && readA.text.includes('last request ran on:   p1/m1'), readA.text)
check('model read does not resume', !calls.some((c) => c[0] === 'selectModel'), JSON.stringify(calls))
const readB = await captured.session_model.execute({ sessionId: 'session-b' }, callerExec)
check('model read falls back to folding the log',
  readB.text.includes('next request will use: p8/m8') && readB.text.includes('last request ran on:   p9/m9 (effort high)'), readB.text)

// session_model: write
const switched = await captured.session_model.execute({ sessionId: 'session-a', provider: 'p2', model: 'm9', reasoningEffort: 'high' }, callerExec)
check('model switch ok', switched.ok === true && switched.text.includes('now uses p2/m9 (effort high)'), switched.text)
check('model switch passes the full request',
  calls.some((c) => c[0] === 'selectModel' && c[1] === 'session-a' && c[2] === 'p2' && c[3] === 'm9' && c[4] === 'high'), JSON.stringify(calls))
check('model switch discloses the default-model side effect', switched.text.includes('deployment default'), switched.text)
check('model switch without effort omits the field',
  switched.ok === true && (await captured.session_model.execute({ sessionId: 'session-b', provider: 'p1', model: 'm1' }, callerExec)).ok === true
  && calls.some((c) => c[0] === 'selectModel' && c[1] === 'session-b' && c[4] === 'undefined'))
const halfPair = await captured.session_model.execute({ sessionId: 'session-a', provider: 'p2' }, callerExec)
check('half a pair is rejected with guidance', halfPair.ok === false && halfPair.text.includes('both provider and model'), halfPair.text)

// session_describe
const set = await captured.session_describe.execute({ sessionId: 'session-a', description: 'owns the parser work' })
check('describe write', set.ok === true && set.text.includes('owns the parser work'), set.text)
check('note file on disk', (await persisted()).byId['session-a'].description === 'owns the parser work')
check('describe read', (await captured.session_describe.execute({ sessionId: 'session-a' })).text.includes('owns the parser work'))
check('note shows in session_list', (await captured.session_list.execute({ scope: 'workspace' }, callerExec)).text.includes('note: owns the parser work'))
check('lineage persisted by the listing',
  (await persisted()).byId['session-b'].parentId === 'session-a'
  && (await persisted()).byId['session-b'].kind === 'fork'
  && (await persisted()).byId['session-c'].kind === 'subagent'
  && (await persisted()).byId['session-a'].kind === 'top-level',
  JSON.stringify((await persisted()).byId))
const beforeRepeat = await readFile(statePath, 'utf8')
await captured.session_list.execute({ scope: 'workspace' }, callerExec)
check('an unchanged store is not rewritten', (await readFile(statePath, 'utf8')) === beforeRepeat)
check('describe clear', (await captured.session_describe.execute({ sessionId: 'session-a', description: '' })).text.includes('Cleared'))
check('clearing a note keeps the persisted relations', (await persisted()).byId['session-a'].description === '' && (await persisted()).byId['session-a'].kind === 'top-level')
check('unknown id warns', (await captured.session_describe.execute({ sessionId: 'session-nope', description: 'x' })).text.includes('Warning'))

// session_read detail levels
const textOnly = await captured.session_read.execute({ sessionId: 'session-a', detail: 'text' })
check('text detail has prose', textOnly.text.includes('hello there') && textOnly.text.includes('hi back'), textOnly.text)
check('text detail hides tools and reasoning', !textOnly.text.includes('bash(') && !textOnly.text.includes('file-a') && !textOnly.text.includes('secret thoughts'), textOnly.text)

const withTools = await captured.session_read.execute({ sessionId: 'session-a', detail: 'tools' })
check('tools detail has call', withTools.text.includes('bash({"command":"ls"})'), withTools.text)
check('tools detail unwraps result', withTools.text.includes('file-a') && withTools.text.includes('file-b'), withTools.text)
check('tools detail shows failure', withTools.text.includes('failed ToolError: EXPLODED') && withTools.text.includes('boom'), withTools.text)
check('tools detail hides system and reasoning', !withTools.text.includes('injected context') && !withTools.text.includes('secret thoughts'), withTools.text)

const all = await captured.session_read.execute({ sessionId: 'session-a', detail: 'all' })
check('all detail has system, reasoning and title',
  all.text.includes('injected context') && all.text.includes('secret thoughts') && all.text.includes('My title'), all.text)
check('oldest first ordering kept', all.text.indexOf('hello there') < all.text.indexOf('My title'), all.text)

// send / stop / fork
check('send ok', (await captured.session_send.execute({ sessionId: 'session-b', text: 'status?', mode: 'steer' }, callerExec)).ok === true
  && calls.some((c) => c[0] === 'prompt' && c[2] === 'steer' && c[3] === 'status?'))
check('self send blocked', (await captured.session_send.execute({ sessionId: 'whatever', text: 'x' }, { agent: { id: 'whatever' } })).ok === false)
check('empty send rejected', (await captured.session_send.execute({ sessionId: 'session-b', text: '   ' }, callerExec)).ok === false)
check('stop ok', (await captured.session_stop.execute({ sessionId: 'session-c' }, callerExec)).ok === true
  && calls.some((c) => c[0] === 'cancel' && c[1] === 'session-c'))
check('fork returns child', (await captured.session_fork.execute({ sessionId: 'session-a' }, callerExec)).text.includes('session-forked'))
check('fork auto-titles "<title> · fork"', calls.some((c) => c[0] === 'rename' && c[1] === 'session-forked' && c[2] === 'Alpha · fork'))
await captured.session_fork.execute({ sessionId: 'session-a', atSeq: 42, title: 'branch B' }, callerExec)
check('fork passes atSeq and title', calls.some((c) => c[0] === 'fork' && c[2] === '42') && calls.some((c) => c[1] === 'session-forked' && c[2] === 'branch B'))

// session_queue
const mutationsBefore = calls.filter((c) => c[0] === 'prompt' || c[0] === 'cancel').length
const queue = await captured.session_queue.execute({ sessionId: 'session-a' }, callerExec)
check('queue lists pending messages in delivery order', queue.ok === true
  && queue.text.indexOf('run the tests after this turn') < queue.text.indexOf('stop and report'), queue.text)
check('queue shows placement per message',
  queue.text.includes('[queued]') && queue.text.includes('[steering]'), queue.text)
check('queue reports the count and the session', queue.text.includes('3 pending messages in session-a'), queue.text)
check('queue clips long text by default', queue.text.includes('…') && !queue.text.includes('x'.repeat(500)), queue.text.slice(0, 200))
check('queue honours maxChars', (await captured.session_queue.execute({ sessionId: 'session-a', maxChars: 100 }, callerExec)).text.split('\n')[3].length < 160)
check('queue handles an attached session with nothing pending',
  (await captured.session_queue.execute({ sessionId: 'session-live-empty' }, callerExec)).text.includes('nothing pending'))
check('queue explains a session with no live inbox',
  (await captured.session_queue.execute({ sessionId: 'session-b' }, callerExec)).text.includes('No live inbox is registered'))
check('queue requires a sessionId', (await captured.session_queue.execute({}, callerExec)).ok === false)
check('queue releases the live stream it borrowed',
  controlSignals.length >= 1 && controlSignals.every((signal) => signal.aborted === true), JSON.stringify(controlSignals.map((s) => s.aborted)))
check('queue is read-only', calls.filter((c) => c[0] === 'prompt' || c[0] === 'cancel').length === mutationsBefore, JSON.stringify(calls))

// session_compact
const compacted = await captured.session_compact.execute({ sessionId: 'session-b' }, callerExec)
check('compact runs /compact for the target',
  compacted.ok === true && calls.some((c) => c[0] === 'command' && c[1] === 'session-b' && c[2] === '/compact'), compacted.text)
check('compact reports what it folded', compacted.text.includes('Compacted 12 history items'), compacted.text)
check('compact passes a real cancellation signal and no attachments',
  calls.some((c) => c[0] === 'command' && c[3] === 'true' && c[4] === '0'), JSON.stringify(calls.filter((c) => c[0] === 'command')))
check('compact surfaces a refused compaction',
  (await captured.session_compact.execute({ sessionId: 'session-busy' }, callerExec)).text.includes('not idle'))
check('compact explains a preset without compaction',
  (await captured.session_compact.execute({ sessionId: 'session-minimal' }, callerExec)).text.includes('does not compose compaction'))
check('compact explains a cold session',
  (await captured.session_compact.execute({ sessionId: 'session-cold' }, callerExec)).text.includes('no attached agent'))
check('compact refuses the caller itself',
  (await captured.session_compact.execute({ sessionId: 'me' }, callerExec)).ok === false)
check('compact requires a sessionId', (await captured.session_compact.execute({}, callerExec)).ok === false)

const failures = results.filter((row) => row[0] === 'FAIL')
for (const [status, label, detail] of results) console.log(`${status}  ${label}${detail}`)
console.log(`\n${results.length - failures.length}/${results.length} passed`)
await rm(dshHome, { recursive: true, force: true })
if (failures.length > 0) process.exit(1)
