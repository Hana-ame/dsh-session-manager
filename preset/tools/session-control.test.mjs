// Smoke test for ./session-control.mjs.
//
// Runs the real plugin file against a fake Cordis context and a throwaway
// DSH_HOME, so it exercises the note store, the transcript extractors and the
// model-route reader without touching a live DSH process or the real ~/.dsh:
//
//   node preset/tools/session-control.test.mjs
//
// Exits non-zero when any check fails, so it works as a CI check.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dshHome = await mkdtemp(join(tmpdir(), 'dsh-session-control-test-'))
process.env.DSH_HOME = dshHome

const { default: register } = await import(new URL('./session-control.mjs', import.meta.url))
const notePath = join(dshHome, 'session-manager', 'descriptions.json')

// ── fake Cordis context ────────────────────────────────────────────────────

const captured = {}
const calls = []

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

const controller = {
  list: async () => ({ items: [
    { sessionId: 'session-a', updatedAt: 1700000000000, running: true, blank: false, cwd: '/tmp/repo', projections: { values: { title: 'Alpha', modelSelection: { lastUsed: { provider: 'p1', model: 'm1' }, next: { provider: 'p2', model: 'm9', reasoningEffort: 'low' } } } } },
    { sessionId: 'session-b', updatedAt: 1690000000000, running: false, blank: false, cwd: '/tmp/repo', parentSessionId: 'session-a', projections: { values: { title: 'Alpha · fork' } } },
    { sessionId: 'session-c', updatedAt: 1680000000000, running: false, blank: false, cwd: '/tmp/repo', parentSessionId: 'session-a', origin: 'subagent' },
  ] }),
  inspect: async () => ({ meta: { id: 'session-a', cwd: '/tmp/repo' }, inheritedEventCount: 0, events }),
  prompt: async (request) => { calls.push(['prompt', request.sessionId, request.mode, request.content[0].text]); return { accepted: true } },
  cancel: async (request) => { calls.push(['cancel', request.sessionId]); return { accepted: true } },
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

register.apply({
  get: (name) => (name === 'sessionController' ? controller : undefined),
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

check('eight tools registered', same(Object.keys(captured).sort(), [
  'session_describe', 'session_fork', 'session_list', 'session_model', 'session_models', 'session_read', 'session_send', 'session_stop',
]), Object.keys(captured).join(','))

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
check('note file on disk', JSON.parse(await readFile(notePath, 'utf8')).byId['session-a'].description === 'owns the parser work')
check('describe read', (await captured.session_describe.execute({ sessionId: 'session-a' })).text.includes('owns the parser work'))
check('note shows in session_list', (await captured.session_list.execute({ scope: 'workspace' }, callerExec)).text.includes('note: owns the parser work'))
check('describe clear', (await captured.session_describe.execute({ sessionId: 'session-a', description: '' })).text.includes('Cleared'))
check('note removed from disk', JSON.parse(await readFile(notePath, 'utf8')).byId['session-a'] === undefined)
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

const failures = results.filter((row) => row[0] === 'FAIL')
for (const [status, label, detail] of results) console.log(`${status}  ${label}${detail}`)
console.log(`\n${results.length - failures.length}/${results.length} passed`)
await rm(dshHome, { recursive: true, force: true })
if (failures.length > 0) process.exit(1)
