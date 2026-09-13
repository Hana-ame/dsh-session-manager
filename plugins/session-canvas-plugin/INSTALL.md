# Installing Session Canvas as a real client plugin

```sh
# 1. the package must be resolvable from the profile directory
mkdir -p "$DSH_HOME/profiles/node_modules/@local/dsh-session-canvas/lib"
cp package.json  "$DSH_HOME/profiles/node_modules/@local/dsh-session-canvas/package.json"
cp lib/index.js  "$DSH_HOME/profiles/node_modules/@local/dsh-session-canvas/lib/"
cp lib/client.js "$DSH_HOME/profiles/node_modules/@local/dsh-session-canvas/lib/"

# 2. the row: a client half is only served for a host Loader ENTRY
cat >> "$DSH_HOME/profiles/web/cordis.patch.yml" <<'YAML'

- insert:
    - id: session-canvas
      name: '@local/dsh-session-canvas'
YAML

# 3. validate the composition offline, then restart
dsh --profile web --dump-config | grep -A1 session-canvas
```

Removing the row from `cordis.patch.yml` withdraws the canvas completely.

## Notes

- The client half declares `inject: ['remote', 'remote.session', 'slots']`. `remote.session` is not a
  property of the `remote` service: it is a **Remote namespace mounted as its own Cordis service** by
  `ctx.remote.$mount(...)`. Reading it without declaring the injection is rejected by the Cordis guard
  (`cannot get property "remote.session" without inject`) and the canvas renders `error:` with 0 nodes.
- Editing `lib/client.js` needs **no restart**: the profile's `client-hmr` polls each bundle's
  mtime/size every 500 ms and pushes a hot swap over SSE, so an open page picks the new code up in
  seconds. Changing `package.json` (the `dsh.client` metadata) or adding/removing the row does need a
  restart, because that is what the composition scan reads.
- The canvas is scoped to the **current Workspace** and deliberately draws nothing when the current
  session belongs to none.
