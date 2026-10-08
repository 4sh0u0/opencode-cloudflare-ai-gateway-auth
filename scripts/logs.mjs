#!/usr/bin/env bun
// Prints the gateway's latest logs, to check the plugin's requests went
// through it. Run with: bun --env-file=.env.local scripts/logs.mjs
const { CF_API_TOKEN: token, CF_ACCOUNT_ID: account, CF_GATEWAY_ID: gateway } = process.env
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/ai-gateway/gateways/${gateway}/logs`
const headers = { authorization: `Bearer ${token}` }
const res = await fetch(`${base}?per_page=20&order_by=created_at&order_by_direction=desc`, { headers })
const body = await res.json()
if (!body.success) {
  console.error(JSON.stringify(body.errors))
  process.exit(1)
}
console.table(
  body.result.map(({ created_at, provider, model, path, status_code, success, cost }) => ({
    created_at,
    provider,
    model,
    path,
    status_code,
    success,
    cost,
  })),
)
const first = body.result[0]
if (first) {
  const detail = await (await fetch(`${base}/${first.id}`, { headers })).json()
  console.log("detail fields:", Object.keys(detail.result ?? {}).join(", "))
}
