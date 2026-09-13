#!/bin/sh
# Install the session-manager package and its agent preset into a DSH home.
#
# The package is one unit with three layers:
#   lib/store.mjs  ① the durable per-session records (relations + describe notes)
#   lib/tools.mjs  ② the management tools the preset mounts
#   lib/client.js  ③ the canvas that renders ①
#
# Two placement rules force the two destinations below, and neither is optional:
#
#   * `@deepseek-ai/dsh-agent-presets` resolves a row's "."-prefixed specifier
#     against the composition's own directory and a BARE package name against the
#     harness install. The preset's tools row therefore reaches the package by a
#     relative path, and the package must exist at that path.
#   * The client module system only serves a client half for a host Loader ENTRY,
#     so the canvas needs a profile row even though the preset could never carry
#     it.
#
# Both destinations read the SAME package directory: one copy, two mount points.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DSH_HOME_DIR=${DSH_HOME:-"$HOME/.dsh"}
PKG_ID='@local/dsh-session-manager'
PKG_DIR="$DSH_HOME_DIR/profiles/node_modules/$PKG_ID"
PRESET_DIR="$DSH_HOME_DIR/.agent-presets/session-manager"
PATCH="$DSH_HOME_DIR/profiles/web/cordis.patch.yml"

# 1. The package: the one physical copy.
mkdir -p "$PKG_DIR/lib"
cp "$ROOT/package/package.json" "$PKG_DIR/package.json"
cp "$ROOT/package/lib/store.mjs" "$ROOT/package/lib/tools.mjs" "$ROOT/package/lib/index.js" "$ROOT/package/lib/client.js" "$PKG_DIR/lib/"
printf 'package   -> %s\n' "$PKG_DIR"

# 2. The preset, whose tools row points back into that package.
mkdir -p "$PRESET_DIR"
cp "$ROOT/preset/agent.cordis.yml" "$ROOT/preset/preset.yml" "$PRESET_DIR/"
printf 'preset    -> %s\n' "$PRESET_DIR"

# 3. The profile row that gets the client half served.
if [ ! -f "$PATCH" ]; then
  mkdir -p "$(dirname -- "$PATCH")"
  : > "$PATCH"
fi
if grep -q "name: '$PKG_ID'" "$PATCH"; then
  printf 'profile   -> row already present in %s\n' "$PATCH"
else
  printf "\n- insert:\n    - id: session-manager\n      name: '%s'\n" "$PKG_ID" >> "$PATCH"
  printf 'profile   -> appended the row to %s (restart the profile to load it)\n' "$PATCH"
fi

if grep -q "@local/dsh-session-canvas" "$PATCH"; then
  printf '\nNOTE: %s still carries the OLD "@local/dsh-session-canvas" row.\n' "$PATCH"
  printf 'Delete that `- insert:` block (id: session-canvas) and the old package\n'
  printf 'directory %s/profiles/node_modules/@local/dsh-session-canvas; the merged\n' "$DSH_HOME_DIR"
  printf 'package now serves both halves.\n'
fi

printf '\nDone. Validate without restarting anything, then restart the profile:\n'
printf '  node %s/preset/../package/test/tools.test.mjs\n' "$ROOT"
printf '  node %s/package/test/scope.test.mjs\n' "$ROOT"
printf '  dsh --profile web --dump-config | grep -A1 session-manager\n'
