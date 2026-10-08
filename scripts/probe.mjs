#!/usr/bin/env bun
// Live probe for the open questions in the design spec (V1–V7, V9).
// Reads CF_API_TOKEN, CF_ACCOUNT_ID and CF_GATEWAY_ID from .env.local
// (run with: bun --env-file=.env.local scripts/probe.mjs).
// Optional: PROBE_MODEL_<VENDOR> picks the model to call per vendor;
// PROBE_REST_MODEL_<VENDOR> the catalog ids the REST calls use instead;
// PROBE_V5=1 also runs the no-wholesale checks against the "default" gateway.
// Writes probe-report.json and never prints the token or whole bodies.

const token = process.env.CF_API_TOKEN
const account = process.env.CF_ACCOUNT_ID
const gateway = process.env.CF_GATEWAY_ID
if (!token || !account || !gateway) {
  console.error("Set CF_API_TOKEN, CF_ACCOUNT_ID and CF_GATEWAY_ID in .env.local")
  process.exit(2)
}

const GW = `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}`
const REST = `https://api.cloudflare.com/client/v4/accounts/${account}`
const PROMPT = "Reply with OK."
const MESSAGES = [{ role: "user", content: PROMPT }]
const report = {}

const redact = (text) => text.replaceAll(token, "<token>").slice(0, 300)

async function call(name, url, { method = "GET", headers = {}, body } = {}) {
  const started = Date.now()
  try {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    })
    const text = await res.text()
    report[name] = {
      status: res.status,
      type: res.headers.get("content-type"),
      ms: Date.now() - started,
      body: redact(text),
    }
    return { status: res.status, text }
  } catch (e) {
    report[name] = { error: String(e?.message ?? e) }
    return { status: 0, text: "" }
  }
}

const aig = { "cf-aig-authorization": `Bearer ${token}`, "cf-aig-no-wholesale": "true" }
const anthropicVersion = { "anthropic-version": "2023-06-01" }
const SKIP = /embed|tts|image|audio|-live|realtime|moderation|whisper|dall-e|sora|transcribe|computer-use|deep-research/i
const CHEAP = /mini|flash|haiku|chat|fast|nano|lite/i

function pick(ids) {
  const text = ids.filter((id) => !SKIP.test(id))
  return text.find((id) => CHEAP.test(id)) ?? text[0]
}

// V2: vendor lists through the gateway, with the stored keys
const LISTS = {
  openai: ["/openai/models", (j) => j.data?.map((m) => m.id)],
  anthropic: ["/anthropic/v1/models?limit=1000", (j) => j.data?.map((m) => m.id)],
  google: [
    "/google-ai-studio/v1beta/models?pageSize=1000",
    (j) =>
      j.models
        ?.filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
        .map((m) => m.name.replace(/^models\//, "")),
  ],
  deepseek: ["/deepseek/models", (j) => j.data?.map((m) => m.id)],
  xai: ["/grok/v1/models", (j) => j.data?.map((m) => m.id)],
}
const picked = {}
for (const [vendor, [path, ids]] of Object.entries(LISTS)) {
  const name = `V2.${vendor}.list`
  const r = await call(name, GW + path, { headers: { ...aig, ...anthropicVersion } })
  let found = []
  try {
    found = ids(JSON.parse(r.text)) ?? []
  } catch {}
  report[name].count = found.length
  report[name].sample = found.slice(0, 8)
  if (found.length) delete report[name].body
  picked[vendor] = process.env[`PROBE_MODEL_${vendor.toUpperCase()}`] ?? pick(found)
}
report.picked = picked

// V1: native endpoints, vendor auth headers left out
if (picked.openai)
  await call("V1.openai.responses", `${GW}/openai/responses`, {
    method: "POST",
    headers: aig,
    body: { model: picked.openai, input: PROMPT, max_output_tokens: 16 },
  })
if (picked.anthropic)
  await call("V1.anthropic.messages", `${GW}/anthropic/v1/messages`, {
    method: "POST",
    headers: { ...aig, ...anthropicVersion },
    body: { model: picked.anthropic, max_tokens: 1, messages: MESSAGES },
  })
if (picked.google)
  await call("V1.google.generate", `${GW}/google-ai-studio/v1beta/models/${picked.google}:generateContent`, {
    method: "POST",
    headers: aig,
    body: { contents: [{ role: "user", parts: [{ text: PROMPT }] }], generationConfig: { maxOutputTokens: 1 } },
  })
if (picked.deepseek)
  await call("V1.deepseek.chat", `${GW}/deepseek/chat/completions`, {
    method: "POST",
    headers: aig,
    body: { model: picked.deepseek, max_tokens: 1, messages: MESSAGES },
  })
if (picked.xai)
  await call("V1.xai.chat", `${GW}/grok/v1/chat/completions`, {
    method: "POST",
    headers: aig,
    body: { model: picked.xai, max_tokens: 1, messages: MESSAGES },
  })

// V6: Anthropic streaming, tools and a beta header through the gateway
if (picked.anthropic)
  await call("V6.anthropic.stream-tools", `${GW}/anthropic/v1/messages`, {
    method: "POST",
    headers: { ...aig, ...anthropicVersion, "anthropic-beta": "fine-grained-tool-streaming-2025-05-14" },
    body: {
      model: picked.anthropic,
      max_tokens: 16,
      stream: true,
      tools: [{ name: "noop", description: "Does nothing.", input_schema: { type: "object", properties: {} } }],
      messages: MESSAGES,
    },
  })

// V7: Gemini streaming path
if (picked.google)
  await call(
    "V7.google.stream",
    `${GW}/google-ai-studio/v1beta/models/${picked.google}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: aig,
      body: { contents: [{ role: "user", parts: [{ text: PROMPT }] }], generationConfig: { maxOutputTokens: 1 } },
    },
  )

// V3 + V4: REST API model prefixes and the token's permissions
const rest = { authorization: `Bearer ${token}`, "cf-aig-gateway-id": gateway, "cf-aig-no-wholesale": "true" }
// REST takes only the ids in Cloudflare's model catalog
// (https://developers.cloudflare.com/ai/models/), which can differ from the
// vendor's own list (Anthropic's use dots, as in claude-haiku-4.5) and answers
// any other id 404 "Model not found". PROBE_REST_MODEL_<VENDOR> sets the ids
// to try after the REST prefix, comma-separated; the default is the picked id.
function restIds(vendor) {
  const ids = process.env[`PROBE_REST_MODEL_${vendor.toUpperCase()}`]?.split(",").filter(Boolean)
  return ids?.length ? ids : picked[vendor] ? [picked[vendor]] : []
}
// One key per prefix, as before; with several ids, one key per id.
async function restCall(name, path, headers, body, ids, id) {
  const key = ids.length > 1 ? `${name}.${id}` : name
  await call(key, `${REST}/ai/v1${path}`, { method: "POST", headers, body })
  report[key].model = body.model
}
const openaiIds = restIds("openai")
for (const id of openaiIds)
  await restCall("V3.rest.responses.openai", "/responses", rest, { model: `openai/${id}`, input: PROMPT, max_output_tokens: 16 }, openaiIds, id)
const anthropicIds = restIds("anthropic")
for (const id of anthropicIds)
  await restCall(
    "V3.rest.messages.anthropic",
    "/messages",
    { ...rest, ...anthropicVersion },
    { model: `anthropic/${id}`, max_tokens: 1, messages: MESSAGES },
    anthropicIds,
    id,
  )
const deepseekIds = restIds("deepseek")
for (const id of deepseekIds)
  await restCall("V3.rest.chat.deepseek", "/chat/completions", rest, { model: `deepseek/${id}`, max_tokens: 1, messages: MESSAGES }, deepseekIds, id)
const googleIds = restIds("google")
for (const prefix of ["google-ai-studio", "google"])
  for (const id of googleIds)
    await restCall(`V3.rest.chat.${prefix}`, "/chat/completions", rest, { model: `${prefix}/${id}`, max_tokens: 1, messages: MESSAGES }, googleIds, id)
const xaiIds = restIds("xai")
for (const prefix of ["xai", "grok"])
  for (const id of xaiIds)
    await restCall(`V3.rest.chat.${prefix}`, "/chat/completions", rest, { model: `${prefix}/${id}`, max_tokens: 1, messages: MESSAGES }, xaiIds, id)

// V5: no-wholesale on a gateway without stored keys. If the header were
// ignored, each of these two requests would be billed to Unified Billing
// credits (1 output token), so they only run when PROBE_V5=1. The REST one
// needs a catalog id, or it stops at 404 before billing is decided.
if (process.env.PROBE_V5 === "1" && picked.openai) {
  await call(
    "V5.native.default-gateway",
    `https://gateway.ai.cloudflare.com/v1/${account}/default/openai/chat/completions`,
    { method: "POST", headers: aig, body: { model: picked.openai, max_tokens: 1, messages: MESSAGES } },
  )
  await call("V5.rest.default-gateway", `${REST}/ai/v1/chat/completions`, {
    method: "POST",
    headers: { ...rest, "cf-aig-gateway-id": "default" },
    body: { model: `openai/${openaiIds[0]}`, max_tokens: 1, messages: MESSAGES },
  })
  report["V5.rest.default-gateway"].model = `openai/${openaiIds[0]}`
}

// V9: how Cloudflare refuses a bad token on each surface
const bad = "probe-invalid-token"
await call("V9.native.bad-token", `${GW}/openai/models`, { headers: { "cf-aig-authorization": `Bearer ${bad}` } })
await call("V9.rest.bad-token", `${REST}/ai/v1/chat/completions`, {
  method: "POST",
  headers: { authorization: `Bearer ${bad}`, "cf-aig-gateway-id": gateway },
  body: { model: "openai/probe", max_tokens: 1, messages: MESSAGES },
})
await call("V9.api.bad-token", `${REST}/ai-gateway/gateways/${gateway}/provider_configs`, {
  headers: { authorization: `Bearer ${bad}` },
})

// provider_configs with the real token: keep only slug and alias (the
// listing also carries a preview of each secret)
const configs = await call("V9.api.provider-configs", `${REST}/ai-gateway/gateways/${gateway}/provider_configs?per_page=50`, {
  headers: { authorization: `Bearer ${token}` },
})
try {
  const j = JSON.parse(configs.text)
  report["V9.api.provider-configs"].body = undefined
  report["V9.api.provider-configs"].rows = (j.result ?? []).map((r) => ({ provider_slug: r.provider_slug, alias: r.alias }))
  report["V9.api.provider-configs"].fields = Object.keys(j.result?.[0] ?? {})
} catch {
  report["V9.api.provider-configs"].body = "<unparsed, hidden>"
}

await Bun.write("probe-report.json", JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
