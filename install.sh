#!/bin/sh
# Install the session-manager package and its agent preset into a DSH home.
#
# The package is one unit with two layers:
#   lib/store.mjs  ① the durable per-session records (relations + describe notes)
#   lib/tools.mjs  ② the management tools the preset mounts
#
# Two placement rules force the two destinations below, and neither is optional:
#
#   * `@deepseek-ai/dsh-agent-presets` resolves a row's "."-prefixed specifier
#     against the composition's own directory and a BARE package name against the
#     harness install. The preset's tools row therefore reaches the package by a
#     relative path, and the package must exist at that path.
#   * Nothing in this package is served to the browser any more: it declares no
#     `dsh.client`, so it needs no profile row and publishes no HTTP route. (The
#     client canvas that used to live here was removed in 0.3.0; step 3 below
#     only reports its leftovers, because cordis.patch.yml is your file.)
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
cp "$ROOT/package/lib/store.mjs" "$ROOT/package/lib/tools.mjs" "$PKG_DIR/lib/"
printf 'package   -> %s\n' "$PKG_DIR"

# 1b. Drop the 0.2 canvas layer when upgrading in place. Those two files are
#     unreachable now (no `dsh.client`, no entry export), but leaving them behind
#     only invites confusion about which half is live.
for stale in "$PKG_DIR/lib/client.js" "$PKG_DIR/lib/index.js"; do
  if [ -e "$stale" ]; then
    rm -f "$stale"
    printf 'removed   -> %s (0.2 canvas layer)\n' "$stale"
  fi
done

# 2. The preset, whose tools row points back into that package.
mkdir -p "$PRESET_DIR"
cp "$ROOT/preset/agent.cordis.yml" "$ROOT/preset/preset.yml" "$PRESET_DIR/"
printf 'preset    -> %s\n' "$PRESET_DIR"

# 3. Report — never rewrite — the leftovers of the removed canvas. A row that
#    named this package now points at one with no entry module, so it must go.
if [ -f "$PATCH" ] && grep -q "$PKG_ID" "$PATCH"; then
  printf '\nWARNING: %s still carries a Loader row for %s.\n' "$PATCH" "$PKG_ID"
  printf 'That row existed only to serve the canvas; the package no longer has an\n'
  printf 'entry module. Delete the `- insert:` block that names it.\n'
fi
if [ -d "$DSH_HOME_DIR/agent-canvas" ]; then
  printf '\nNOTE: %s/agent-canvas holds an even older canvas; nothing loads it.\n' "$DSH_HOME_DIR"
  printf 'Delete that directory too if you want it gone.\n'
fi

printf '\nDone. Validate without restarting anything, then restart the profile:\n'
printf '  node %s/package/test/tools.test.mjs\n' "$ROOT"
printf '  dsh --profile web --dump-config | grep session-manager   # expect no canvas row\n'
