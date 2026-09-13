// Session Canvas — dynamic Cordis package, HOST half.
//
// This file is NOT an ES module: the whole file IS the function body you pass as
// `code.host` to the cordis_define tool. That is why it opens with a top-level
// `return` and imports nothing — it is evaluated inside the dynamic-package
// sandbox, where `harness`, `ctx`, and `console` are provided.
//
// Exported from a live DSH process:
//   plugin scanv-7 / package pkg-12 / run-29
//
// It registers exactly one Package-private RPC method, `sessions-graph`, which the
// client half calls through `host.call`. The payload is plain JSON: one row per
// session this process knows about. Reading the list never resumes an Agent.
return {
  apply(ctx) {
    const controller = ctx.get('sessionController')
    if (controller === undefined) {
      console.error('session-canvas: sessionController is unavailable; the canvas has no data source')
      return
    }

    harness.handle('sessions-graph', async () => {
      try {
        const listed = await controller.list({}, undefined)
        const items = listed !== null && typeof listed === 'object' && Array.isArray(listed.items) ? listed.items : []
        const sessions = []
        for (const item of items) {
          if (item === null || typeof item !== 'object') continue
          const id = typeof item.sessionId === 'string' ? item.sessionId : null
          if (id === null) continue
          let title = null
          const projections = item.projections
          if (projections !== null && typeof projections === 'object') {
            const values = projections.values
            if (values !== null && typeof values === 'object' && typeof values.title === 'string' && values.title.length > 0) title = values.title
          }
          const parentId = typeof item.parentSessionId === 'string' ? item.parentSessionId : null
          let updatedAt = 0
          if (typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt)) updatedAt = item.updatedAt
          // NOTE: `origin === 'subagent'` is the only exact subagent marker; a fork
          // carries `parentSession` too, so it must not be folded into isSubagent.
          // pkg-12 (the instance this was exported from) still uses the older
          // `origin === 'subagent' || parentId !== null` test, which mislabels forks.
          sessions.push({
            id: id,
            title: title,
            cwd: typeof item.cwd === 'string' ? item.cwd : null,
            running: item.running === true,
            blank: item.blank === true,
            parentId: parentId,
            isSubagent: item.origin === 'subagent',
            isFork: item.origin !== 'subagent' && parentId !== null,
            updatedAt: updatedAt,
          })
        }
        return { ok: true, now: Date.now(), sessions: sessions }
      } catch (error) {
        const message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error)
        return { ok: false, error: message }
      }
    })

    console.log('session-canvas: host handler sessions-graph ready')
  },
}
