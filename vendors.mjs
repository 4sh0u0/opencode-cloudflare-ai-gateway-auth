// Vendors this plugin reaches through Cloudflare AI Gateway, and how.
// Everything Cloudflare-specific about a vendor lives in this one table.

export const PROVIDER = "cloudflare-ai-gateway"

// The AI SDK package that makes the host speak each API to the plugin.
export const NPM = {
  chat: "@ai-sdk/openai-compatible",
  responses: "@ai-sdk/openai",
  messages: "@ai-sdk/anthropic",
  gemini: "@ai-sdk/google",
}

// The path the host appends to the base URL for each API. Gemini's carries
// the model id, so route.mjs matches it on its own.
export const PROTOCOL_PATHS = {
  chat: "/chat/completions",
  responses: "/responses",
  messages: "/messages",
}

const ANTHROPIC_VERSION = { "anthropic-version": "2023-06-01" }

// list.skip matches the ids in a vendor's own list that don't chat over the
// API the plugin declares for it. It is the vendor's alone and works without
// models.dev; models.mjs also drops the ids its NOT_TEXT words match.
export const VENDORS = [
  {
    prefix: "openai", // the model key's prefix
    slug: "openai", // the gateway's provider slug, for BYOK and native URLs
    restPrefix: "openai", // the model prefix the REST API takes
    catalog: "openai", // the models.dev provider holding its metadata
    native: { protocol: "responses", paths: { responses: "/responses", chat: "/chat/completions" } },
    rest: "responses",
    list: {
      path: "/models",
      format: "openai",
      headers: {},
      // legacy Completions-only models, and search models that take only
      // Chat Completions (Responses answers them 400)
      skip: /^(?:babbage|davinci)-|-instruct(?:-|$)|-search-(?:api|preview)(?:-|$)/,
    },
  },
  {
    prefix: "anthropic",
    slug: "anthropic",
    restPrefix: "anthropic",
    catalog: "anthropic",
    native: { protocol: "messages", paths: { messages: "/v1/messages", chat: "/v1/chat/completions" } },
    rest: "messages",
    list: { path: "/v1/models?limit=1000", format: "anthropic", headers: ANTHROPIC_VERSION, skip: null },
  },
  {
    prefix: "google",
    slug: "google-ai-studio",
    restPrefix: "google",
    catalog: "google",
    // chat is the default because magpie sends @ai-sdk/google plugin models as
    // Code Assist, which neither route.mjs nor the gateway speaks (spec 11, V8).
    // gemini's path is what comes before /models/<id>:<method>
    native: { protocol: "chat", paths: { gemini: "/v1beta", chat: "/v1beta/openai/chat/completions" } },
    // REST takes google/ but serves it through Vertex AI, so the stored
    // google-ai-studio key never applies (spec 11.6)
    rest: null,
    list: {
      path: "/v1beta/models?pageSize=1000",
      format: "gemini",
      headers: {},
      // Lyria makes music, nano-banana images, though both take generateContent
      skip: /^lyria-|nano-banana/,
    },
  },
  {
    prefix: "deepseek",
    slug: "deepseek",
    restPrefix: "deepseek",
    catalog: "deepseek",
    native: { protocol: "chat", paths: { chat: "/chat/completions" } },
    // REST serves deepseek/ through Fireworks, so the stored deepseek key
    // never applies (spec 11.6)
    rest: null,
    list: { path: "/models", format: "openai", headers: {}, skip: null },
  },
  {
    prefix: "xai",
    slug: "grok",
    restPrefix: "xai",
    catalog: "xai",
    native: { protocol: "chat", paths: { chat: "/v1/chat/completions", responses: "/v1/responses" } },
    // REST takes xai/ but finds no stored key for it, though grok holds one
    // (spec 11.6)
    rest: null,
    // grok-imagine-* make images and video
    list: { path: "/v1/models", format: "openai", headers: {}, skip: /^grok-imagine/ },
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
