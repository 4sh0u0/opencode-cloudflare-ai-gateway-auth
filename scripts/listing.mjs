#!/usr/bin/env bun
// Summarizes `magpie plugin --json` for this plugin: per vendor prefix, the
// model count, the AI SDK packages and the model ids (fine-tuned ids,
// which carry the org's name, are only counted). The raw listing names
// the account (gateway, account ID prefix) and holds magpie's
// accounts[].hint, the token's last characters, so it stays in the sandbox
// and only this summary is printed. Run with:
// bun scripts/listing.mjs <listing.json>
import { PROVIDER } from "../vendors.mjs"

export function summarize(listing) {
  const provider = (listing?.providers ?? []).find((p) => p?.id === PROVIDER)
  if (!provider) return [`${PROVIDER}: not listed`]
  const models = Array.isArray(provider.models) ? provider.models : []
  const vendors = {}
  for (const m of models) {
    const prefix = String(m?.id ?? "").split("/")[0]
    vendors[prefix] ??= { count: 0, npm: new Set(), ids: [], tuned: 0 }
    vendors[prefix].count++
    vendors[prefix].npm.add(m?.npm ?? m?.api?.npm ?? "?")
    const id = String(m?.id ?? "").slice(prefix.length + 1)
    // fine-tuned ids (ft:<base>:<org>::<id>) carry the org's name: counted only
    if (id.startsWith("ft:")) vendors[prefix].tuned++
    else vendors[prefix].ids.push(id)
  }
  return [
    `${PROVIDER}: signed in ${provider.signedIn === true}, ${models.length} models`,
    ...Object.keys(vendors)
      .sort()
      .flatMap((prefix) => [
        `  ${prefix}: ${vendors[prefix].count} models, npm ${[...vendors[prefix].npm].sort().join(", ")}`,
        ...(vendors[prefix].ids.length ? [`    ${vendors[prefix].ids.sort().join(" ")}`] : []),
        ...(vendors[prefix].tuned ? [`    ${vendors[prefix].tuned} fine-tuned models (ids hidden)`] : []),
      ]),
  ]
}

if (import.meta.main) {
  const lines = summarize(await Bun.file(process.argv[2]).json())
  console.log(lines.join("\n"))
  // not listed, or listed without models
  if (lines.length === 1) process.exit(1)
}
