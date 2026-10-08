// Vendors this plugin reaches through Cloudflare AI Gateway, and how.
// Everything Cloudflare-specific about a vendor lives in this one table.

export const PROVIDER = "cloudflare-ai-gateway"

// The AI SDK package that makes magpie speak each API to the plugin.
export const NPM = {
  chat: "@ai-sdk/openai-compatible",
  responses: "@ai-sdk/openai",
  messages: "@ai-sdk/anthropic",
  gemini: "@ai-sdk/google",
}

// The path magpie appends to the base URL for each API. Gemini's carries
// the model id, so route.mjs matches it on its own.
export const PROTOCOL_PATHS = {
  chat: "/chat/completions",
  responses: "/responses",
  messages: "/messages",
}

const ANTHROPIC_VERSION = { "anthropic-version": "2023-06-01" }

export const VENDORS = [
  {
    prefix: "openai", // the model key's prefix in magpie
    slug: "openai", // the gateway's provider slug, for BYOK and native URLs
    restPrefix: "openai", // the model prefix the REST API takes
    catalog: "openai", // the models.dev provider holding its metadata
    native: { protocol: "responses", paths: { responses: "/responses", chat: "/chat/completions" } },
    rest: "responses",
    list: { path: "/models", format: "openai", headers: {} },
  },
  {
    prefix: "anthropic",
    slug: "anthropic",
    restPrefix: "anthropic",
    catalog: "anthropic",
    native: { protocol: "messages", paths: { messages: "/v1/messages", chat: "/v1/chat/completions" } },
    rest: "messages",
    list: { path: "/v1/models?limit=1000", format: "anthropic", headers: ANTHROPIC_VERSION },
  },
  {
    prefix: "google",
    slug: "google-ai-studio",
    // from Cloudflare's REST API docs (model naming); the live probe couldn't
    // reach model routing, its token lacking Workers AI Read (spec 11.2, V3)
    restPrefix: "google",
    catalog: "google",
    // gemini's path is what comes before /models/<id>:<method>
    native: { protocol: "gemini", paths: { gemini: "/v1beta", chat: "/v1beta/openai/chat/completions" } },
    rest: "chat",
    list: { path: "/v1beta/models?pageSize=1000", format: "gemini", headers: {} },
  },
  {
    prefix: "deepseek",
    slug: "deepseek",
    restPrefix: "deepseek",
    catalog: "deepseek",
    native: { protocol: "chat", paths: { chat: "/chat/completions" } },
    rest: "chat",
    list: { path: "/models", format: "openai", headers: {} },
  },
  {
    prefix: "xai",
    slug: "grok",
    restPrefix: "xai",
    catalog: "xai",
    native: { protocol: "chat", paths: { chat: "/v1/chat/completions", responses: "/v1/responses" } },
    rest: "chat",
    list: { path: "/v1/models", format: "openai", headers: {} },
  },
]

export function vendorByPrefix(prefix) {
  return VENDORS.find((v) => v.prefix === prefix)
}

// splitModel parses a model key, "<prefix>/<native id>". The native id keeps
// any slash after the first; vendor is undefined for an unknown prefix.
export function splitModel(key) {
  if (typeof key !== "string") return null
  const at = key.indexOf("/")
  if (at <= 0 || at === key.length - 1) return null
  const prefix = key.slice(0, at)
  return { prefix, nativeId: key.slice(at + 1), vendor: vendorByPrefix(prefix) }
}

// protocolFor is the API a vendor's models speak to the plugin in a mode.
export function protocolFor(vendor, mode) {
  return mode === "rest" ? vendor.rest : vendor.native.protocol
}
