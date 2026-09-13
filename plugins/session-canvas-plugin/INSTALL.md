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
