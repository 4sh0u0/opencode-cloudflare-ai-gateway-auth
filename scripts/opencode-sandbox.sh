#!/usr/bin/env bash
# Integration check in OpenCode 1.x: runs a pinned OpenCode with a throwaway
# HOME, this folder as a file:// plugin and a sign-in seeded from .env.local,
# lists the provider's models, then sends one short prompt to each model given.
# Usage: scripts/opencode-sandbox.sh <native|rest> <vendor/model>...
#   OPENCODE_VERSION picks the release (default 1.18.35).
#   BAD_TOKEN=1 seeds a token Cloudflare refuses and only lists, to check the
#   refusal is logged and doesn't break OpenCode.
#   VARIANT=high runs each prompt at that reasoning level.
set -euo pipefail
mode=${1:?usage: scripts/opencode-sandbox.sh <native|rest> <vendor/model>...}
case "$mode" in native | rest) ;; *) echo "usage: $0 <native|rest> <vendor/model>..." >&2; exit 2 ;; esac
shift
version=${OPENCODE_VERSION:-1.18.35}
variant=()
if [ -n "${VARIANT:-}" ]; then variant=(--variant "$VARIANT"); fi
root=$(cd "$(dirname "$0")/.." && pwd)
# npx keeps its download in the real npm cache, not the throwaway HOME
npm_cache=$(npm config get cache)
sb=$(mktemp -d)
trap 'rm -rf "$sb"' EXIT
mkdir -p "$sb/.config/opencode" "$sb/.local/share/opencode" "$sb/.local/state" "$sb/.cache" "$sb/work"
oc() {
  # Drop the caller's cloud and provider variables so only the seeded sign-in
  # and config reach OpenCode (its built-in loaders read these).
  local drop=() name
  while IFS= read -r name; do drop+=(-u "$name"); done < <(
    compgen -e | grep -E '^(CLOUDFLARE_|CF_|OPENCODE|ANTHROPIC_|OPENAI_|GOOGLE_|GEMINI_|DEEPSEEK_|XAI_)' || true
  )
  (cd "$sb/work" && env ${drop[@]+"${drop[@]}"} HOME="$sb" XDG_CONFIG_HOME="$sb/.config" XDG_DATA_HOME="$sb/.local/share" \
    XDG_STATE_HOME="$sb/.local/state" XDG_CACHE_HOME="$sb/.cache" npm_config_cache="$npm_cache" \
    npx -y "opencode-ai@$version" "$@")
}
# What OpenCode prints can name the account and gateway; only redacted text is shown.
redact() { (cd "$root" && bun --env-file=.env.local scripts/redact.mjs); }

cat >"$sb/.config/opencode/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugin": ["file://$root"],
  "enabled_providers": ["cloudflare-ai-gateway"],
  "autoupdate": false,
  "share": "disabled"
}
EOF

# Seed the sign-in the way OpenCode keeps it ($XDG_DATA_HOME/opencode/auth.json),
# so the token is never typed or echoed. The metadata comes from the plugin's
# own signIn, as `opencode auth login` stores it.
(cd "$root" && MODE="$mode" BAD="${BAD_TOKEN:-}" OUT="$sb/.local/share/opencode/auth.json" bun --env-file=.env.local -e '
  const { _internal } = await import(`${process.cwd()}/index.mjs`)
  const { CF_API_TOKEN, CF_ACCOUNT_ID: account, CF_GATEWAY_ID: gateway, MODE: mode, BAD: bad, OUT: out } = process.env
  const signed = _internal.signIn({ account, gateway, mode })
  if (signed.type !== "success") throw new Error(signed.error)
  const key = bad ? "refused-by-cloudflare" : CF_API_TOKEN
  await Bun.write(out, JSON.stringify({ "cloudflare-ai-gateway": { type: "api", key, metadata: signed.metadata } }))
')
chmod 600 "$sb/.local/share/opencode/auth.json"

status=0
# A provider with no models is dropped, and `opencode models <provider>` then
# fails with "Provider not found"; with a refused token, list them all instead.
if [ -n "${BAD_TOKEN:-}" ]; then list=(models); else list=(models cloudflare-ai-gateway); fi
oc "${list[@]}" --print-logs </dev/null >"$sb/models.txt" 2>"$sb/models.log" || {
  echo "FAILED: opencode ${list[*]} exited non-zero"
  tail -n 30 "$sb/models.log" | redact
  status=1
}
echo "== $(grep -c '^cloudflare-ai-gateway/' "$sb/models.txt" || true) models listed"
redact <"$sb/models.txt"
echo "== the plugin's log lines"
grep -E "Couldn't list the models|Nothing to list" "$sb/models.log" | redact || true

if [ -n "${BAD_TOKEN:-}" ]; then
  grep -q "Couldn't list the models" "$sb/models.log" || {
    echo "FAILED: no log line says why nothing is listed"
    status=1
  }
  exit $status
fi

for model in "$@"; do
  echo "== $model"
  if oc run -m "cloudflare-ai-gateway/$model" ${variant[@]+"${variant[@]}"} --print-logs "Reply with the single word OK." </dev/null >"$sb/run.txt" 2>"$sb/run.log" &&
    grep -qiw 'ok' "$sb/run.txt"; then
    redact <"$sb/run.txt"
  else
    echo "FAILED: $model"
    tail -n 30 "$sb/run.log" | redact
    status=1
  fi
done
exit $status
