#!/usr/bin/env bash
# Integration check: runs magpie with a throwaway HOME, this folder as its
# plugin and an account seeded from .env.local, then tests each model given.
# Usage: scripts/sandbox.sh <native|rest> <model key>...
set -euo pipefail
mode=${1:?usage: scripts/sandbox.sh <native|rest> <model key>...}
shift
root=$(cd "$(dirname "$0")/.." && pwd)
sb=$(mktemp -d)
trap 'rm -rf "$sb"' EXIT
m() { env HOME="$sb" XDG_CONFIG_HOME="$sb/.config" XDG_CACHE_HOME="$sb/.cache" MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }

mkdir -p "$sb/.config/magpie"
# Seed the sign-in the way magpie keeps it (plugin-auth.json), so the token
# is never typed or echoed. authorize() is covered by the unit tests.
(cd "$root" && MODE="$mode" OUT="$sb/.config/magpie/plugin-auth.json" bun --env-file=.env.local -e '
  const { CF_API_TOKEN: key, CF_ACCOUNT_ID: account, CF_GATEWAY_ID: gateway, MODE: mode, OUT: out } = process.env
  const metadata = { account, gateway, mode, alias: "", email: `${gateway} · ${account.slice(0, 8)}` }
  await Bun.write(out, JSON.stringify({ "cloudflare-ai-gateway": { type: "api", key, metadata } }))
')
chmod 600 "$sb/.config/magpie/plugin-auth.json"

m plugin add "$root" </dev/null
m plugin --json >"$root/.sandbox-plugin.json"
echo "plugin listing saved to .sandbox-plugin.json"
status=0
for model in "$@"; do
  m provider test cloudflare-ai-gateway "$model" || { echo "FAILED: $model"; status=1; }
done
exit $status
