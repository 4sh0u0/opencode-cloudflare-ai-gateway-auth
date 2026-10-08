#!/usr/bin/env bun
// Copies stdin to stdout with the token, account ID (and its first 8
// characters, which sign-in names show) and gateway ID from .env.local
// hidden. The values are trimmed first (the account ID is also lower-cased,
// as the plugin does) and matched as literal text, ignoring case.
// Run with: bun --env-file=.env.local scripts/redact.mjs
const names = ["CF_API_TOKEN", "CF_ACCOUNT_ID", "CF_GATEWAY_ID"]
const [token, rawAccount, gateway] = names.map((name) => (process.env[name] ?? "").trim())
const account = rawAccount.toLowerCase()
// Fail closed: without all three values nothing could be hidden reliably.
const missing = names.filter((_, i) => ![token, account, gateway][i])
if (missing.length) {
  console.error(`redact: ${missing.join(", ")} not set; refusing to print unredacted text`)
  process.exit(1)
}
const literal = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&"), "gi")
let text = await Bun.stdin.text()
// The full account ID goes before its 8-character prefix.
for (const [secret, mask] of [
  [token, "<token>"],
  [account, "<account>"],
  [account.slice(0, 8), "<account8>"],
  [gateway, "<gateway>"],
])
  text = text.replace(literal(secret), mask)
process.stdout.write(text)
