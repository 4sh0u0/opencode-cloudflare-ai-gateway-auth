#!/usr/bin/env bash
# Integration check: runs magpie with a throwaway HOME, this folder as its
# plugin and an account seeded from .env.local, then prints magpie's output
# and a summary of the model list, with the account ID, gateway ID and token
# hidden, and tests each model given.
# Usage: scripts/sandbox.sh <native|rest> <model key>...
set -euo pipefail
mode=${1:?usage: scripts/sandbox.sh <native|rest> <model key>...}
case "$mode" in native | rest) ;; *) echo "usage: $0 <native|rest> <model key>..." >&2; exit 2 ;; esac
shift
root=$(cd "$(dirname "$0")/.." && pwd)
sb=$(mktemp -d)
trap 'rm -rf "$sb"' EXIT
m() { env HOME="$sb" XDG_CONFIG_HOME="$sb/.config" XDG_CACHE_HOME="$sb/.cache" MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
# What magpie prints can name the account (gateway · account ID prefix); only redacted text is shown.
redact() { (cd "$root" && bun --env-file=.env.local scripts/redact.mjs); }

mkdir -p "$sb/.config/magpie"
# Seed the sign-in the way magpie keeps it (plugin-auth.json), so the token
# is never typed or echoed. authorize() is covered by the unit tests.
# The metadata comes from the plugin's own signIn, so the account's name is
# the one a real sign-in gives.
(cd "$root" && MODE="$mode" OUT="$sb/.config/magpie/plugin-auth.json" bun --env-file=.env.local -e '
  const { _internal } = await import(`${process.cwd()}/index.mjs`)
  const { CF_API_TOKEN: key, CF_ACCOUNT_ID: account, CF_GATEWAY_ID: gateway, MODE: mode, OUT: out } = process.env
  const signed = _internal.signIn({ account, gateway, mode })
  if (signed.type !== "success") throw new Error(signed.error)
  await Bun.write(out, JSON.stringify({ "cloudflare-ai-gateway": { type: "api", key, metadata: signed.metadata } }))
')
chmod 600 "$sb/.config/magpie/plugin-auth.json"

m plugin add "$root" </dev/null 2>&1 | redact
# The raw listing names the account and holds the token's last characters,
# so it stays in the sandbox (removed on exit); only a summary is printed.
m plugin --json >"$sb/plugin.json"
status=0
bun "$root/scripts/listing.mjs" "$sb/plugin.json" | redact || status=1
for model in "$@"; do
  m provider test cloudflare-ai-gateway "$model" </dev/null 2>&1 | redact || { echo "FAILED: $model"; status=1; }
done
exit $status
