# Installing the session-manager package

```sh
./install.sh                       # honours $DSH_HOME, defaults to ~/.dsh
```

That writes two destinations that both read **one** package copy:

```
$DSH_HOME/profiles/node_modules/@local/dsh-session-manager/   # the package (all layers)
$DSH_HOME/.agent-presets/session-manager/                     # the preset that mounts ②
```

plus one row **you** add to a patch layer, for layer ④ (see below). The preset mounts a second package module too — `lib/loop.mjs`, the `/loop` command row — so a reinstall must copy it along with `tools.mjs`.

## Layers

| Layer | File | Mounted by | Reads/writes |
| --- | --- | --- | --- |
| ① persistence | `lib/store.mjs` | imported by ②, `/loop` and ④ | `<DSH_HOME>/session-manager/state.json` |
| ② tools | `lib/tools.mjs` | the preset row (`tool-session-control`) | the store, `sessionController`, `agents`, `commands`, `workspaceRegistry` |
| `/loop` | `lib/loop.mjs` | the preset row (`tool-loop`) | the store (**read-only**), `commands`, `sessionController`, `agents`, `timer` |
| ④ ask bridge | `lib/ask-bridge.mjs` | a row in **`$DSH_HOME/cordis.patch.yml`** | the store, `userQuestions`, `sessionController`, `agent/inbox/inserted` |

The package declares no `dsh.client`, exports no entry module and serves no route:
nothing here is sent to the browser.

## ④ The ask bridge — why it exists and why it is HOST-plane

`ask_user_question` has **no timeout**. The `userQuestions` seam rejects a caller
that is a *runtime-owned child* (`DELEGATED_CALLER`) precisely because such a child
has no human answerer — but a session delegated with `session_send` is its own
runtime **root**, so it passes that guard, reaches the `user-questions/request`
waterfall, and only its own session's browser can answer it. Nobody is watching
that session, so the tool call blocks forever. Observed in production: a delegated
worker sat inside one unanswered question for **107 minutes** while its task was
already finished.

The bridge is the answerer that case is missing. For a question whose asking
agent is the **target of any delegation** in the ledger — pending or already
settled, so that a follow-up sent without `callback: true` still reaches the
right place — it:

1. takes the decision before `api-remotes` can park the request on a browser that
   may not exist (its listener is registered `prepend`);
2. forwards the question — text, options, the recommended option marked, how to
   answer — into the **delegator's** session as one queued prompt, reusing the same
   `sessionController.prompt` + `hasPromptRequest` dedupe the callback notices use,
   with a `requestId` derived from the delegation id, a digest of the question and
   a per-delegation sequence;
3. waits for the delegator's `session_send` reply, by watching the worker's own
   inbox for that user message, and returns it as the answer;
4. and nothing else. There is no grace on the worker's own UI, no fallback option
   and no invented answer: the only other exits are an abort, a failed delivery
   and an explicitly configured bound, all of which fail the tool call.

A question from a session that is **not** any delegation's target falls straight
through with `next()` — ordinary foreground use is untouched.

**It must sit on the host plane.** A preset-scoped row would never see the
question: the worker usually runs a different preset (`ptc`, `standard`, …), and
even the same preset mounts one copy per session. It publishes no service, so it
needs no `isolate` realm and no `package.json` export — the row reaches the file by
relative path.

### The row

Add this top-level entry to `$DSH_HOME/cordis.patch.yml` (the home-layer patch, so
one row covers every profile):

```yaml
- insert:
    - id: session-manager-ask-bridge
      name: './profiles/node_modules/@local/dsh-session-manager/lib/ask-bridge.mjs'
      config:
        timeoutMs: 0          # 0 = wait for the delegator forever; the default
```

A relative `name` in a patch layer resolves against **the patch file's own
directory** (`$DSH_HOME`), *not* the profile directory — so `./profiles/...` is
correct here and `../node_modules/...` is not. Verify with:

```sh
dsh --profile web --dump-config | grep -A2 ask-bridge   # name must resolve to a real file
```

`timeoutMs: 0` — the default — waits for the delegator's decision indefinitely. A
positive value is floored to 15000 ms and capped at 86400000 ms, and when it
expires the tool call **fails** rather than answering the question on the worker's
behalf. Omitting `config` gives the same default.

## Why two destinations for one package

The placement is forced by how the harness resolves a row, and cannot be worked
around by moving files:

- **The preset mounts the tools by a relative path into the package.**
  `@deepseek-ai/dsh-agent-presets` resolves a row whose specifier starts with
  `.` against that composition's own directory, and a bare package name against
  the **harness install**. `../../profiles/node_modules/@local/dsh-session-manager/lib/tools.mjs`
  is therefore the one specifier form that reaches an installed package without
  copying the tools next to the preset. Verified by composing the preset for
  real (`ctx.agentPresets.standingKeyFor('session-manager')`).
- **A patch layer resolves against its own directory.** That is why the ④ row in
  `$DSH_HOME/cordis.patch.yml` uses `./profiles/...` while the preset's ② row uses
  `../../profiles/...`. Both land on the same file.

## Notes and pitfalls

- The ② row publishes no service, so it must stay **outside** every `isolate`
  realm in the composition. Behind one it would resolve a private registry the
  preset never populates, and its tools would silently contribute nothing. The
  same is true of ④.
- ④ must be mounted **exactly once per process**. Two copies would forward every
  delegated question twice; the derived `requestId` makes the second delivery a
  dedupe rather than a duplicate notice, but one row is the intent.
- `state.json` is the package's only durable file. It is seeded once from the
  pre-0.2 `descriptions.json` when that file exists and `state.json` does not, so
  an upgrade in place keeps every note.
- Editing `lib/store.mjs` / `lib/tools.mjs` takes effect on the next preset mount.
  Editing `lib/ask-bridge.mjs` is picked up when the patch layer re-imports the
  row: **touch `cordis.patch.yml`** to trigger that under `patchReload: live`, or
  restart the profile. A module already imported keeps its old copy in Node's ESM
  cache until the row is re-created.
- Changing `package.json` or a preset composition needs a restart.
- The relative specifiers count on the package living at
  `profiles/node_modules/@local/dsh-session-manager/`. Move it and both rows stop
  resolving.

## Verifying an install

```sh
node <pkg>/lib/ask-bridge.test.mjs                  # 83 decisions
node <pkg>/lib/loop.test.mjs                        # /loop classification, wake-up and idempotency
node <pkg>/test/tools.test.mjs                      # 104
node <pkg>/test/delegation-idempotency.test.mjs     # 15
```

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

Then restart the profile. Everything the package still does — the thirteen
`session_*` tools, the `/loop` command row, and the preset that mounts them — is
unaffected.
