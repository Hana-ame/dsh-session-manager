/**
 * Session manager — HOST half of the durable package.
 *
 * The package has three layers over one another: `lib/store.mjs` owns the
 * durable per-session records (①), `lib/tools.mjs` is the management tool half
 * the agent preset mounts (②), and `lib/client.js` is the canvas (③). The tools
 * and this host half import the SAME store module — one instance in one process,
 * with a stat-checked cache — so the tools' writes are what the canvas sees.
 *
 * This half exists for two reasons:
 *
 *   1. A client half is only served for a host Loader entry (the client module
 *      system scans the host composition, not preset subtrees), so the package
 *      needs exactly one profile row.
 *   2. The persisted records have to reach the page somehow. A durable client
 *      bundle can only `require` react, cordis, the slot/primitive/dockkit
 *      modules and other client bundles — the Package-private `harness`/`host`
 *      bridge belongs to DYNAMIC packages only. So the state is served over one
 *      same-origin GET route, which the page's own fetch reads with its session
 *      cookie; it carries no authority beyond that page.
 */
import { readState, statePath } from './store.mjs'

/** The one route this package serves. */
export const STATE_ROUTE = '/session-manager/state'

/** Serialize the durable state for the canvas. */
const bodyOf = (state) => JSON.stringify({ version: state.version, file: statePath(), byId: state.byId })

const respond = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('session-manager: method not allowed')
    return
  }
  try {
    const body = bodyOf(await readState())
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(req.method === 'HEAD' ? undefined : body)
  } catch (error) {
    const message = error !== null && error !== undefined && typeof error.message === 'string' ? error.message : String(error)
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ version: 0, byId: {}, error: message }))
  }
}

export default {
  name: 'session-manager',
  inject: ['webServer'],
  apply(ctx) {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: STATE_ROUTE, handler: (req, res) => { void respond(req, res) } }),
      `session-manager: ${STATE_ROUTE}`,
    )
  },
}
