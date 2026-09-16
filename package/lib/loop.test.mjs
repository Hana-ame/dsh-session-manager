// Evidence harness for the /loop tick: drives createLoopRuntime with mocks.
// Run: node lib/loop.test.mjs   (from the package dir)
import assert from 'node:assert/strict'
import { createLoopRuntime, classifyRound, frameLoopTick, parseIntervalSeconds, sampleKbHealth, DEFAULT_INTERVAL_MS, STUCK_IDLE_MS } from './loop.mjs'

const OWNER = 'owner-session-1'
const TARGET = 'target-session-2'
const OTHER = 'other-session-3'

const dlg = (over) => ({
  id: 'dlg-abcd1234',
  from: OWNER,
  to: TARGET,
  task: 'do the thing',
  mode: 'queue',
  status: 'pending',
  createdAt: 1000,
  baselineSeq: 0,
  settledAt: 0,
  reply: '',
  note: '',
  ...over,
})

const ledger = (rows) => ({ version: 3, byId: {}, delegations: rows })

const makeFakes = () => {
  const prompted = []
  const disposed = []
  const intervals = new Map()
  let liveAgents = new Set([OWNER])
  let items = []
  const controller = {
    list: async () => ({ items }),
    prompt: async (request) => {
      prompted.push(request)
      return {}
    },
  }
  const agents = { get: (id) => (liveAgents.has(id) ? { id } : undefined) }
  const startInterval = (cb, ms) => {
    const id = `iv-${intervals.size}`
    intervals.set(id, { cb, ms, alive: true })
    return () => { disposed.push(id); if (intervals.has(id)) intervals.get(id).alive = false }
  }
  return { prompted, disposed, intervals, controller, agents, startInterval, state: { set: (s) => { ledgerState = s }, get: () => ledgerState }, setItems: (v) => { items = v }, setLive: (ids) => { liveAgents = new Set(ids) }, setPromptFail: (v) => { controller.prompt = async () => { if (v) throw new Error('prompt exploded'); return {} } } }
}
let ledgerState = ledger([])

const runtime = (ctx) => createLoopRuntime({ controller: () => ctx.controller, agents: () => ctx.agents, startInterval: ctx.startInterval, readLedger: async () => ctx.state.get() })

// 1 — parse
assert.equal(parseIntervalSeconds(''), 120)
assert.equal(parseIntervalSeconds('300'), 300)
assert.equal(parseIntervalSeconds(' 45 '), 45)
assert.equal(parseIntervalSeconds('abc'), null)
assert.equal(parseIntervalSeconds('10'), null) // below 30s floor
assert.equal(parseIntervalSeconds('999999'), null)

// 2 — classifyRound: conservative ledger logic
{
  const st = ledger([
    dlg({ id: 'a', status: 'done' }),
    dlg({ id: 'b', status: 'failed' }),
    dlg({ id: 'c', status: 'pending' }),          // never surfaced
    dlg({ id: 'd', status: 'unknown' }),          // never surfaced — 宁可留着
    dlg({ id: 'e', from: OTHER, status: 'done' }), // other owner — not ours
  ])
  const f = classifyRound({ ownerId: OWNER, state: st, items: [], stuckIdleMs: STUCK_IDLE_MS, surfaced: new Set() })
  assert.deepEqual(f.newSettled.map((d) => d.id), ['a', 'b'])
  assert.deepEqual(f.stuck, [])
  // Already surfaced → suppressed
  const f2 = classifyRound({ ownerId: OWNER, state: st, items: [], stuckIdleMs: STUCK_IDLE_MS, surfaced: new Set(['a']) })
  assert.deepEqual(f2.newSettled.map((d) => d.id), ['b'])
}

// 3 — classifyRound: stuck sessions
{
  const now = 1000 * 60 * 60
  const items = [
    { sessionId: OTHER, running: true, updatedAt: now - 20 * 60 * 1000 },   // 20m stale → stuck
    { sessionId: 'active', running: true, updatedAt: now - 1000 },           // active → ok
    { sessionId: OWNER, running: true, updatedAt: 1 },                       // owner excluded
    { sessionId: 'child', running: true, updatedAt: 1, origin: 'subagent' }, // subagent excluded
    { sessionId: 'cold', running: false, updatedAt: 1 },                     // not running → ok
    { sessionId: 'nostale', running: true, updatedAt: now - 5 * 60 * 1000 }, // 5m < 10m → ok
  ]
  const f = classifyRound({ ownerId: OWNER, state: ledger([]), items, stuckIdleMs: STUCK_IDLE_MS, now })
  assert.deepEqual(f.stuck.map((s) => s.sessionId), [OTHER])
  // Cooldown suppresses repeats
  const reported = new Map([[OTHER, now - 1000]])
  const f2 = classifyRound({ ownerId: OWNER, state: ledger([]), items, stuckIdleMs: STUCK_IDLE_MS, now, stuckReportedAt: reported })
  assert.deepEqual(f2.stuck, [])
  // Cooldown expired → re-report
  const reported2 = new Map([[OTHER, now - 7 * 60 * 60 * 1000]])
  const f3 = classifyRound({ ownerId: OWNER, state: ledger([]), items, stuckIdleMs: STUCK_IDLE_MS, now, stuckReportedAt: reported2 })
  assert.deepEqual(f3.stuck.map((s) => s.sessionId), [OTHER])
}

// 4 — framing
{
  const text = frameLoopTick(
    { newSettled: [dlg({ id: 'dlg-long-id-abcdef123456', status: 'done' })], stuck: [{ sessionId: OTHER, idleMs: 20 * 60 * 1000 }] },
    120,
  )
  assert.ok(text.includes('[LOOP patrol]'))
  assert.ok(text.includes('新结算委托 1 个'))
  assert.ok(text.includes('疑似卡住会话 1 个'))
  assert.ok(text.includes('不要派活、不要重投任务、不要 session_stop'))
  console.log('── frameLoopTick sample ──\n' + text + '\n')
}

// 5 — full tick: silent when nothing; prompt once with findings; dedupe; owner closed stops
{
  const ctx = makeFakes()
  const rt = runtime(ctx)
  ctx.state.set(ledger([]))
  ctx.setItems([])

  // start
  const out = rt.start(OWNER, DEFAULT_INTERVAL_MS)
  assert.equal(out.wasRunning, false)
  assert.equal(ctx.intervals.size, 1)

  // tick with nothing → silent, no prompt
  const silent = await rt.runTick(OWNER)
  assert.deepEqual(silent, { prompted: false, newSettled: [], stuck: [], kb: [] })
  assert.equal(ctx.prompted.length, 0)
  console.log('── tick 1 (nothing) ── silent, prompted =', ctx.prompted.length)

  // a delegation settles + a session looks stuck → one prompt, durably
  ctx.state.set(ledger([dlg({ id: 'dlg-aaa', status: 'done', settledAt: 5000 })]))
  ctx.setItems([{ sessionId: OTHER, running: true, updatedAt: Date.now() - 20 * 60 * 1000 }])
  const found = await rt.runTick(OWNER)
  assert.equal(found.prompted, true)
  assert.equal(found.newSettled.length, 1)
  assert.equal(found.stuck.length, 1)
  assert.equal(ctx.prompted.length, 1)
  assert.equal(ctx.prompted[0].sessionId, OWNER)
  assert.equal(ctx.prompted[0].mode, 'queue')
  assert.ok(ctx.prompted[0].content[0].text.includes('[LOOP patrol]'))
  console.log('── tick 2 (findings) ── prompted =', ctx.prompted.length, '| message head:', ctx.prompted[0].content[0].text.slice(0, 60) + '…')

  // next tick: same settlement already surfaced → silent even though ledger unchanged
  const again = await rt.runTick(OWNER)
  assert.equal(again.prompted, false)
  assert.equal(ctx.prompted.length, 1)
  console.log('── tick 3 (same facts) ── prompted =', ctx.prompted.length, '(no duplicate wake)')

  // dismiss happened (agent dropped the row) → bookkeeping pruned, still silent
  ctx.state.set(ledger([]))
  const afterDismiss = await rt.runTick(OWNER)
  assert.equal(afterDismiss.prompted, false)
  assert.equal(ctx.prompted.length, 1)

  // owner closed → loop stops itself
  ctx.setLive([])
  const gone = await rt.runTick(OWNER)
  assert.equal(gone.reason, 'owner-closed')
  assert.equal(rt.loops.size, 0)
  assert.equal(ctx.disposed.length, 1)
  console.log('── tick 4 (owner closed) ── loop stopped, timers disposed =', ctx.disposed.length)

  // restart after owner returns: fresh loop, no parallel timers after re-run
  ctx.setLive([OWNER])
  rt.start(OWNER, DEFAULT_INTERVAL_MS)
  const replace = rt.start(OWNER, 300 * 1000) // re-run /loop with a new interval
  assert.equal(replace.wasRunning, true)
  assert.equal(replace.hadSameInterval, false)
  assert.equal(ctx.disposed.length, 2)        // old timer disposed, one live remains
  const live = [...ctx.intervals.values()].filter((i) => i.alive)
  assert.equal(live.length, 1)
  assert.equal(live[0].ms, 300 * 1000)
  console.log('── interval change ── live timers =', live.length, '| ms =', live[0].ms)

  // stop
  rt.stop(OWNER)
  assert.equal(rt.loops.size, 0)
  assert.equal([...ctx.intervals.values()].filter((i) => i.alive).length, 0)
  console.log('── stop ── loops =', rt.loops.size, '| live timers = 0')
}

// 6 — prompt failure keeps findings unsurfaced (retried next tick)
{
  const ctx = makeFakes()
  const rt = runtime(ctx)
  ctx.state.set(ledger([dlg({ id: 'dlg-bbb', status: 'done' })]))
  ctx.setItems([])
  ctx.setPromptFail(true)
  rt.start(OWNER, DEFAULT_INTERVAL_MS)
  const failed = await rt.runTick(OWNER)
  assert.equal(failed.prompted, false)
  assert.equal(failed.reason, 'prompt: prompt exploded')
  ctx.setPromptFail(false)
  const retried = await rt.runTick(OWNER)
  assert.equal(retried.prompted, true)
  console.log('── prompt failure ── retried next tick, prompted =', retried.prompted, '| reason was:', failed.reason)
}

// 7 — sampleKbHealth: pure Node KB scan (notes vs indexes)
{
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-kb-'))
  try {
    fs.mkdirSync(path.join(tmp, 'notes'))
    fs.mkdirSync(path.join(tmp, 'indexes'))
    fs.mkdirSync(path.join(tmp, 'indexes', 'sub'))
    // three notes: a & b registered, c orphan
    fs.writeFileSync(path.join(tmp, 'notes', 'a.md'), '---\nid: a\n---\n')
    fs.writeFileSync(path.join(tmp, 'notes', 'b.md'), '---\nid: b\n---\n')
    fs.writeFileSync(path.join(tmp, 'notes', 'c.md'), '---\nid: c\n---\n')
    // index registers a + b, and one dangling ref to missing 'z'
    fs.writeFileSync(path.join(tmp, 'indexes', 'main.md'), '- [[a]]\n- [[b]]\n- [[z]]\n')
    fs.writeFileSync(path.join(tmp, 'indexes', 'sub', 'deep.md'), '- [[a]]\n')

    // first scan: c orphan, z dangling, all three new
    const first = await sampleKbHealth(tmp, new Set())
    assert.deepEqual(first.orphans, ['c'])
    assert.deepEqual(first.dangling, ['main.md -> z'])
    assert.deepEqual(first.newNodes.sort(), ['a', 'b', 'c'])
    // limit caps dangling
    const capped = await sampleKbHealth(tmp, new Set(), 1)
    assert.equal(capped.dangling.length, 1)

    // second scan with prev nodes → no newNodes
    const second = await sampleKbHealth(tmp, new Set(['a', 'b', 'c']))
    assert.deepEqual(second.newNodes, [])

    // missing dir → empty, no throw
    const missing = await sampleKbHealth(path.join(tmp, 'nope'))
    assert.deepEqual(missing, { orphans: [], dangling: [], newNodes: [] })
    console.log('── sampleKbHealth ── orphans [c], dangling [main.md -> z], new 3 → 0')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// 8 — classifyRound: KB findings only report deltas
{
  const kb = { orphans: ['c'], dangling: ['main.md -> z'], newNodes: ['a', 'b'] }
  const fresh = classifyRound({ ownerId: OWNER, state: ledger([]), items: [], stuckIdleMs: STUCK_IDLE_MS, kb })
  assert.equal(fresh.newSettled.length, 0)
  assert.equal(fresh.stuck.length, 0)
  assert.equal(fresh.kb.length, 3)
  assert.deepEqual(fresh.kb.map((k) => k.kind), ['orphans', 'dangling', 'newNodes'])
  // already reported → suppressed
  const silent = classifyRound({
    ownerId: OWNER, state: ledger([]), items: [], stuckIdleMs: STUCK_IDLE_MS, kb,
    kbReportedOrphans: new Set(['c']),
    kbReportedDangling: new Set(['main.md -> z']),
    kbReportedNodes: new Set(['a', 'b']),
  })
  assert.deepEqual(silent.kb, [])
  console.log('── classifyRound kb ── fresh 3 findings, reported → 0')
}

// 9 — frameLoopTick renders KB lines + instruction keeps "no kb edits"
{
  const text = frameLoopTick(
    { newSettled: [], stuck: [], kb: [{ kind: 'orphans', items: ['c'] }, { kind: 'dangling', items: ['main.md -> z'] }, { kind: 'newNodes', items: ['a', 'b'] }] },
    120,
  )
  assert.ok(text.includes('知识库新增孤儿节点 1 个'))
  assert.ok(text.includes('知识库新增悬空引用 1 条'))
  assert.ok(text.includes('知识库新增节点 2 个'))
  assert.ok(text.includes('知识库类目只汇报、不要自行改库'))
  console.log('── frameLoopTick kb ── 3 lines rendered, no-edit instruction present')
}

console.log('\nALL LOOP TESTS PASSED')