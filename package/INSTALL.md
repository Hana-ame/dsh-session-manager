# Installing the session-manager package

```sh
./install.sh                       # honours $DSH_HOME, defaults to ~/.dsh
```

That writes two destinations that both read **one** package copy:

```
$DSH_HOME/profiles/node_modules/@local/dsh-session-manager/   # the package (both layers)
$DSH_HOME/.agent-presets/session-manager/                     # the preset that mounts ②
```

## Why two destinations for one package

The placement is forced by how the harness resolves a preset row, and it cannot
be worked around by moving files:

- **The preset mounts the tools by a relative path into the package.**
  `@deepseek-ai/dsh-agent-presets` resolves a row whose specifier starts with
  `.` against the composition's own directory, and a bare package name against
  the **harness install**. `../../profiles/node_modules/@local/dsh-session-manager/lib/tools.mjs`
  is therefore the one specifier form that reaches an installed package without
  copying the tools next to the preset. Verified by composing the preset for
  real (`ctx.agentPresets.standingKeyFor('session-manager')`).

## Layers

| Layer | File | Mounted by | Reads/writes |
| --- | --- | --- | --- |
| ① persistence | `lib/store.mjs` | imported by ② | `<DSH_HOME>/session-manager/state.json` |
| ② tools | `lib/tools.mjs` | the preset row (`tool-session-control`) | the store, `sessionController`, `agents`, `commands`, `workspaceRegistry` |

The package has no third layer. It declares no `dsh.client`, exports no entry
module, serves no route and owns no profile row: nothing here is sent to the
browser.

## Notes and pitfalls

- The ② row publishes no service, so it must stay **outside** every `isolate`
  realm in the composition. Behind one it would resolve a private registry the
  preset never populates, and its tools would silently contribute nothing.
- `state.json` is the package's only durable file. It is seeded once from the
  pre-0.2 `descriptions.json` when that file exists and `state.json` does not, so
  an upgrade in place keeps every note.
- Editing `lib/store.mjs` / `lib/tools.mjs` takes effect on the next preset
  mount. Changing `package.json` or the preset composition needs a restart.
- The relative specifier in `agent.cordis.yml` counts on the package living at
  `profiles/node_modules/@local/dsh-session-manager/`. Move it and the preset
  stops mounting the tools.

## Removing the 0.2 canvas

0.3.0 deleted the client half — the canvas was not good enough to keep. If you
are upgrading an existing install, three leftovers have to go by hand; the
installer only reports them, because `cordis.patch.yml` is your file.

1. The Loader row that existed only to get the client half served:
   delete the `- insert:` block naming `@local/dsh-session-manager` (id
   `session-manager`) from `$DSH_HOME/profiles/web/cordis.patch.yml`. A row
   pointing at a package with no entry module is a boot error, not a no-op.
2. `lib/client.js` and `lib/index.js` under
   `$DSH_HOME/profiles/node_modules/@local/dsh-session-manager/` — `install.sh`
   removes these for you on the next run.
3. If you also have the even older `$DSH_HOME/agent-canvas/` directory, nothing
   loads it; delete it as well.
4. Upgrading from the standalone `@local/dsh-session-canvas` package: delete that
   `- insert:` block from `cordis.patch.yml` and its directory under
   `profiles/node_modules/@local/`.

Then restart the profile. Everything the package still does — the twelve
`session_*` tools and the preset that mounts them — is unaffected.
