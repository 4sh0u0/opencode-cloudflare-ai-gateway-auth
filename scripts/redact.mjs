#!/usr/bin/env bun
// Copies stdin to stdout with the token, account ID (and its first 8
// characters, which sign-in names show) and gateway ID from .env.local
// hidden. Run with: bun --env-file=.env.local scripts/redact.mjs
const { CF_API_TOKEN: token, CF_ACCOUNT_ID: account, CF_GATEWAY_ID: gateway } = process.env
let text = await Bun.stdin.text()
for (const [secret, mask] of [
  [token, "<token>"],
  [account, "<account>"],
  [account?.slice(0, 8), "<account8>"],
  [gateway, "<gateway>"],
])
  if (secret) text = text.replaceAll(secret, mask)
process.stdout.write(text)
