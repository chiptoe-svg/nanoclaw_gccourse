#!/usr/bin/env bash
#
# NanoClaw v1 → v2 migration entry point.
#
# Invoked from a fresh v2 clone (a sibling of the v1 tree, not a worktree
# inside it) with the v1 project path as the one positional argument:
#
#     cd ~/nanoclaw-v2          # the v2 clone
#     bash migrate-v2.sh ~/nanoclaw-v1
#
# Or via curl-to-bash:
#
#     curl -sSL https://raw.githubusercontent.com/qwibitai/nanoclaw/main/migrate-v2.sh \
#       | bash -s -- ~/nanoclaw-v1
#     # (in curl mode, the script clones a fresh v2 sibling itself)
#
# The v1 tree is read-only during the migration — no new remotes, no
# worktree metadata, no files added. The v2 clone is where everything
# happens: pnpm install, central DB seed, CLAUDE.local.md copies. The
# final swap (if the operator chooses) is a separate manual step,
# guided by `.nanoclaw-migrations/guide.md` inside the v1 tree.

set -euo pipefail

# ─── color helpers (matches nanoclaw.sh) ────────────────────────────────

use_ansi() { [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; }
dim()      { use_ansi && printf '\033[2m%s\033[0m' "$1" || printf '%s' "$1"; }
gray()     { use_ansi && printf '\033[90m%s\033[0m' "$1" || printf '%s' "$1"; }
red()      { use_ansi && printf '\033[31m%s\033[0m' "$1" || printf '%s' "$1"; }
bold()     { use_ansi && printf '\033[1m%s\033[0m' "$1" || printf '%s' "$1"; }
brand_bold() {
  if use_ansi; then
    if [ "${COLORTERM:-}" = "truecolor" ] || [ "${COLORTERM:-}" = "24bit" ]; then
      printf '\033[1;38;2;43;183;206m%s\033[0m' "$1"
    else
      printf '\033[1;36m%s\033[0m' "$1"
    fi
  else
    printf '%s' "$1"
  fi
}

step() { printf '  %s  %s\n' "$(gray '◆')" "$1"; }
ok()   { printf '  %s  %s\n' "$(gray '◇')" "$1"; }
die()  {
  printf '\n  %s %s\n' "$(red '✗')" "$1"
  [ "${2:-}" ] && printf '  %s\n' "$(dim "$2")"
  printf '\n'
  exit 1
}

# ─── parse + validate args ──────────────────────────────────────────────

V1_ROOT_ARG="${1:-}"
if [ -z "$V1_ROOT_ARG" ]; then
  die "Missing v1 project path." "Usage: bash migrate-v2.sh <path-to-v1-checkout>"
fi

# Absolute-ify so the driver doesn't have to care about the caller's cwd.
if [ ! -d "$V1_ROOT_ARG" ]; then
  die "v1 path doesn't exist: $V1_ROOT_ARG" "Pass the absolute path to your v1 NanoClaw checkout."
fi
V1_ROOT="$(cd "$V1_ROOT_ARG" && pwd)"

# The v2 clone is wherever this script lives. Assumption: the user either
# cloned the repo and `cd`'d in, or the curl-to-bash one-liner cloned for
# them (see below).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# curl-to-bash detection: $0 is `bash` (or similar), not the path to us.
# In that case BASH_SOURCE is usually unreliable, and we need to clone v2
# ourselves into a fresh sibling of v1.
if [ -z "${BASH_SOURCE:-}" ] || [ "${BASH_SOURCE[0]}" = "$0" ] && [ ! -f "$SCRIPT_DIR/package.json" ]; then
  # Curl-to-bash path.
  CLONE_URL="${NANOCLAW_V2_REPO_URL:-https://github.com/qwibitai/nanoclaw.git}"
  CLONE_REF="${NANOCLAW_V2_REF:-main}"
  V2_ROOT="$(dirname "$V1_ROOT")/nanoclaw-v2"
  if [ -d "$V2_ROOT" ]; then
    die "Sibling $V2_ROOT already exists." "Remove it first, or cd into a v2 clone and run bash migrate-v2.sh <v1-path>."
  fi
  step "curl-to-bash mode detected — cloning v2 into $V2_ROOT"
  git clone --branch "$CLONE_REF" --depth 1 "$CLONE_URL" "$V2_ROOT" 2>&1 | sed 's/^/    /' || \
    die "Couldn't clone v2." "Check network and the repo URL (override with NANOCLAW_V2_REPO_URL)."
  cd "$V2_ROOT"
else
  cd "$SCRIPT_DIR"
  V2_ROOT="$SCRIPT_DIR"
fi

# ─── intro ──────────────────────────────────────────────────────────────

printf '\n  %s%s  %s\n' "$(bold 'Nano')" "$(brand_bold 'Claw')" "$(dim '· v1 → v2 migration')"
printf '  %s\n' "$(dim "v1: $V1_ROOT")"
printf '  %s\n\n' "$(dim "v2: $V2_ROOT")"

# ─── sanity-check both sides ────────────────────────────────────────────

# cwd must look like a v2 clone — package.json with version 2.x + the
# migrate driver on disk. This catches the easy mistake of running from a
# v1 checkout or a completely unrelated directory.
if [ ! -f "package.json" ]; then
  die "$V2_ROOT doesn't look like a NanoClaw checkout." "cd into the v2 clone and try again, or re-run via curl-to-bash."
fi
PKG_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "")
case "$PKG_VERSION" in
  2.*) ok "v2 clone detected (package.json @$PKG_VERSION)" ;;
  *)   die "$V2_ROOT is package version '$PKG_VERSION', not 2.x." "Clone or checkout the v2 branch first." ;;
esac
if [ ! -f "setup/migrate.ts" ]; then
  die "Missing setup/migrate.ts in $V2_ROOT." "This v2 checkout is too old — pull the latest."
fi

# v1 side — refuse if the shape doesn't match.
if [ -f "$V1_ROOT/data/v2.db" ] && [ ! -f "$V1_ROOT/store/messages.db" ]; then
  die "$V1_ROOT is already v2." "Delete data/v2.db and re-run if you want to re-seed."
fi
if [ ! -f "$V1_ROOT/store/messages.db" ] && [ ! -f "$V1_ROOT/.env" ]; then
  die "Can't find a v1 install at $V1_ROOT." "Expected store/messages.db + .env. Check the path and retry."
fi
ok "v1 install detected"

# ─── Node + pnpm ────────────────────────────────────────────────────────

if ! command -v node >/dev/null 2>&1; then
  die "Node isn't installed." "Install Node 20+ and retry (v2 uses pnpm via corepack, which ships with Node 20)."
fi
NODE_MAJOR=$(node -v | sed -E 's/^v([0-9]+)\..*/\1/')
if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
  die "Node $(node -v) is too old." "v2 requires Node ≥ 20. Upgrade and retry."
fi
ok "Node $(node -v)"

step "Enabling pnpm via corepack…"
if ! corepack enable pnpm >/dev/null 2>&1; then
  corepack enable pnpm || \
    die "corepack enable pnpm failed." "Run 'sudo corepack enable pnpm' manually and retry."
fi
ok "pnpm $(pnpm --version 2>/dev/null || echo '(version unknown)')"

# ─── install deps ───────────────────────────────────────────────────────

if [ ! -d "node_modules" ]; then
  step "Installing v2 dependencies (pnpm install --frozen-lockfile)…"
  if ! pnpm install --frozen-lockfile 2>&1 | sed 's/^/    /'; then
    die "pnpm install failed in $V2_ROOT." "See output above."
  fi
  ok "Dependencies installed."
else
  ok "Dependencies already installed."
fi

# ─── hand off to the TS driver ──────────────────────────────────────────

printf '\n  %s\n\n' "$(dim 'Handing off to the migration driver…')"

# exec so Ctrl-C propagates directly to the driver and we don't waste a
# PID just holding the slot.
exec pnpm --silent run migrate:v1-to-v2 -- --v1-root "$V1_ROOT"
