# Installing the session-manager package

```sh
./install.sh                       # honours $DSH_HOME, defaults to ~/.dsh
```

That writes two destinations that both read **one** package copy:

```
$DSH_HOME/profiles/node_modules/@local/dsh-session-manager/   # the package (all three layers)
$DSH_HOME/.agent-presets/session-manager/                     # the preset that mounts ②
$DSH_HOME/profiles/web/cordis.patch.yml                       # the row that gets ③ served
```

## Why two destinations for one package

Both are forced by how the harness resolves things, and neither can be worked
around by moving files:

- **The preset mounts the tools by a relative path into the package.**
  `@deepseek-ai/dsh-agent-presets` resolves a row whose specifier starts with
  `.` against the composition's own directory, and a bare package name against
  the **harness install**. `../../profiles/node_modules/@local/dsh-session-manager/lib/tools.mjs`
  is therefore the one specifier form that reaches an installed package without
  copying the tools next to the preset. Verified by composing the preset for
  real (`ctx.agentPresets.standingKeyFor('session-manager')`).
- **The canvas needs a host Loader entry.** The client module system scans the
  host composition's entries for packages declaring `dsh.client`; a preset
  subtree is never scanned, so a client half cannot live in the preset.

## Layers

| Layer | File | Mounted by | Reads/writes |
| --- | --- | --- | --- |
| ① persistence | `lib/store.mjs` | imported by ② and the host half | `<DSH_HOME>/session-manager/state.json` |
| ② tools | `lib/tools.mjs` | the preset row (`tool-session-control`) | the store, `sessionController`, `agents` |
| ③ canvas | `lib/client.js` | the profile row's client half | `remote.session.list` + the store route |

The host half `lib/index.js` exists so that ① reaches the page: a durable client
bundle can only `require` react, cordis and the slot/primitive/dockkit modules —
the Package-private `harness`/`host` bridge is for dynamic packages only. It
serves `GET /session-manager/state` (same origin, so the page's own credentials
apply) with the serialized records.

## Notes and pitfalls

- The client half declares `inject: ['remote', 'remote.session', 'slots']`.
  `remote.session` is a Remote namespace **mounted as its own Cordis service** by
  `ctx.remote.$mount(...)`, not a property of the `remote` service; reading it
  undeclared is rejected by the Cordis guard (`cannot get property "remote.session"
  without inject`) and the panel renders `error:` with 0 nodes.
- The bundle's envelope id **must** be the package name
  (`window.__ModuleLoader__.load({ id: '@local/dsh-session-manager', ... })`) —
  that is how the module system matches a loaded factory to the graph row.
- Editing `lib/client.js` needs **no restart**: the profile's `client-hmr` polls
  each bundle's mtime/size every 500 ms and pushes a hot swap over SSE. Changing
  `package.json`, the preset composition, or the profile row does need a
  restart — that is what the boot scan reads.
- Removing the row from `cordis.patch.yml` withdraws the canvas; deleting the
  package directory withdraws the tools the preset row mounts.
- `state.json` is the package's only durable file. It is seeded once from the
  pre-0.2 `descriptions.json` when that file exists and `state.json` does not, so
  an upgrade in place keeps every note.
- Upgrading from the standalone `@local/dsh-session-canvas` package: delete that
  `- insert:` block from `cordis.patch.yml` and its directory under
  `profiles/node_modules/@local/`; the merged package serves both halves now.
