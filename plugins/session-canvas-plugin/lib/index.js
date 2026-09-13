/**
 * Host half of Session Canvas.
 *
 * The interesting half is the client one. The browser reads the session list
 * through the ALREADY EXISTING `session` Remote namespace
 * (`ctx.remote.session.list`), which is the same `sessionController.list` the
 * composer and sidebar use — so this package contributes no service, no handler,
 * and no state. It exists as a composed profile row only because the client
 * module system scans the host Loader's entries for packages declaring
 * `dsh.client`; a client half with no host row would never be served.
 */
export default {
  name: 'session-canvas',
  apply() {},
}
