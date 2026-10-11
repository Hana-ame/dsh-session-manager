#!/bin/sh
# Install the session-manager package and its agent preset into a DSH home.
#
# The package is one unit with two data layers plus two peripheral ones:
#   lib/store.mjs      ① the durable per-session records (relations + describe notes)
#   lib/tools.mjs      ② the management tools the preset mounts
#   lib/loop.mjs       the preset's `/loop` command + per-session inspection timer
#   lib/ask-bridge.mjs ④ the host-plane answerer for a delegated session's question
#
# ④ is mounted by a HOST patch row, not by the preset: a preset row is scoped to
# one session, and a delegated worker usually runs a different preset, so a
# preset-scoped listener would never see that worker's question.
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
# ① / ② / `/loop` all travel as FILES, not as package exports: the preset reaches
# them by relative path, so this script must copy every module the composition
# names. Dropping one makes the whole preset fail to mount (a row that cannot be
# resolved is a boot error, not a no-op).
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
mkdir -p "$PKG_DIR/lib" "$PKG_DIR/test"
cp "$ROOT/package/package.json" "$PKG_DIR/package.json"
cp "$ROOT/package/lib/store.mjs" "$ROOT/package/lib/tools.mjs" "$ROOT/package/lib/ask-bridge.mjs" "$PKG_DIR/lib/"
# `lib/loop.mjs` is the `/loop` command row's package module (mounted by
# `tool-loop` in the composition). It is a sibling of the tools layer, not an
# entry export — but the preset row reaches it by the SAME relative path, so a
# reinstall that omits it makes the whole preset fail to mount with
# "row \"tool-loop\" names a plugin that cannot be resolved".
cp "$ROOT/package/lib/loop.mjs" "$PKG_DIR/lib/"
# Tests travel with the package so the installed copy can be verified in place
# (`node <pkg>/lib/ask-bridge.test.mjs`) without the repo checkout.
cp "$ROOT/package/lib/ask-bridge.test.mjs" "$PKG_DIR/lib/"
cp "$ROOT/package/lib/loop.test.mjs" "$PKG_DIR/lib/"
cp "$ROOT/package/test"/*.mjs "$PKG_DIR/test/" 2>/dev/null || :
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

# ── Ask bridge live? The host-plane row that unblocks a delegated worker. ────
# Deliberately REPORTED, not written: $DSH_HOME/cordis.patch.yml is your file,
# exactly like the profile patch above. The bridge must sit on the HOST plane —
# a preset row is scoped to one session and the worker usually runs another
# preset, so it would never see the worker's question — which means a row in a
# patch layer, and patch layers belong to you.
HOME_PATCH="$DSH_HOME_DIR/cordis.patch.yml"
if [ ! -f "$HOME_PATCH" ] || ! grep -q 'session-manager-ask-bridge' "$HOME_PATCH"; then
  printf '\nWARNING: %s has no ask-bridge row.\n' "$HOME_PATCH"
  printf 'Without it, a session you delegate to can block FOREVER on\n'
  printf 'ask_user_question: the tool has no timeout and nobody can answer a\n'
  printf 'question asked inside a session no browser is watching. With it, the\n'
  printf 'question is forwarded to YOU and the worker waits for your reply --\n'
  printf 'no fallback answer is ever invented.\n'
  printf 'Add this top-level entry to %s:\n\n' "$HOME_PATCH"
  printf -- '- insert:\n'
  printf -- '    - id: session-manager-ask-bridge\n'
  printf -- "      name: './profiles/node_modules/@local/dsh-session-manager/lib/ask-bridge.mjs'\n"
  printf -- '      config:\n'
  printf -- '        timeoutMs: 0        # 0 = wait for your decision forever; a positive\n'
  printf -- '                           # value (15000-86400000 ms) fails the call if it\n'
  printf -- '                           # expires instead of answering for the worker\n\n'
  printf 'A relative name resolves against $DSH_HOME (the patch file\047s own\n'
  printf 'directory), NOT against the profile directory.\n'
fi

printf '\nDone. Validate without restarting anything, then restart the profile:\n'
printf '  node %s/package/test/tools.test.mjs\n' "$ROOT"
printf '  node %s/package/lib/loop.test.mjs\n' "$ROOT"
printf '  node %s/package/lib/ask-bridge.test.mjs\n' "$ROOT"
printf '  dsh --profile web --dump-config | grep ask-bridge   # expect the row, resolved to an existing file\n'
