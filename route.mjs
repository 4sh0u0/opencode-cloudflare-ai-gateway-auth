import { PROTOCOL_PATHS, splitModel } from "./vendors.mjs"

// The host's AI SDK appends each API's path to this base; route() replaces
// it, so nothing is ever sent to it.
export const PLACEHOLDER = "https://cloudflare-ai-gateway.invalid"
export const GATEWAY = "https://gateway.ai.cloudflare.com/v1"
export const API = "https://api.cloudflare.com/client/v4"

// A request the plugin can't send. index.mjs answers it locally, in the
// request's own API shape.
export class RouteError extends Error {
  constructor(message, protocol) {
    super(message)
    this.name = "RouteError"
    this.protocol = protocol
  }
}

const GEMINI = /^\/models\/(.+):(streamGenerateContent|generateContent)$/

// What the host adds for the saved key. The gateway forwards a request that
// carries any of these as it is, without using the stored BYOK key.
const VENDOR_AUTH = ["authorization", "x-api-key", "x-goog-api-key"]

function text(body) {
  if (body == null) return ""
  return typeof body === "string" ? body : new TextDecoder().decode(body)
}

// underProtocol is the API whose path a sub-path such as
// /messages/count_tokens is under, if any.
function underProtocol(pathname) {
  return Object.keys(PROTOCOL_PATHS).find((p) => pathname.startsWith(`${PROTOCOL_PATHS[p]}/`))
}

// parseRequest reads which API, vendor and model a request the host built is for.
export function parseRequest(url, body) {
  const u = new URL(url)
  let protocol = Object.keys(PROTOCOL_PATHS).find((p) => PROTOCOL_PATHS[p] === u.pathname)
  let key
  let method
  let json
  if (protocol) {
    try {
      json = JSON.parse(text(body))
    } catch {
      throw new RouteError("The request body is not JSON", protocol)
    }
    key = json?.model
  } else {
    const m = GEMINI.exec(u.pathname)
    // magpie's check for an unsupported endpoint (as for count_tokens) reads
    // "Unsupported endpoint: <path>", in the shape of the API the path is
    // under: /messages/count_tokens answers in Anthropic's
    if (!m) throw new RouteError(`Unsupported endpoint: ${u.pathname}`, underProtocol(u.pathname) ?? "chat")
    protocol = "gemini"
    method = m[2]
    try {
      key = decodeURIComponent(m[1])
    } catch {
      throw new RouteError(`Malformed model id in ${u.pathname}`, protocol)
    }
  }
  const parsed = splitModel(key)
  if (!parsed) throw new RouteError(`Model "${key}" should look like <vendor>/<model>`, protocol)
  if (!parsed.vendor) throw new RouteError(`Unknown vendor "${parsed.prefix}" in model "${key}"`, protocol)
  return { protocol, method, search: u.search, json, vendor: parsed.vendor, nativeId: parsed.nativeId }
}

// route turns a request the host built for PLACEHOLDER into the one sent to
// Cloudflare. account is {token, account, gateway, mode, alias}.
export function route(url, init, account, options = {}) {
  const req = parseRequest(url, init?.body)
  const { protocol, vendor, nativeId } = req
  const headers = new Headers(init?.headers)
  headers.delete("content-length")
  headers.delete("host")
  if (!options.allowUnifiedBilling) headers.set("cf-aig-no-wholesale", "true")

  let target
  let body = init?.body
  if (account.mode === "rest") {
    const path = PROTOCOL_PATHS[protocol]
    // vendor.rest is null when the probe found no REST route for the vendor
    if (!path || vendor.rest === null)
      throw new RouteError(`The REST API can't serve this ${protocol} request; sign in with the native mode`, protocol)
    target = `${API}/accounts/${account.account}/ai/v1${path}${req.search}`
    body = JSON.stringify({ ...req.json, model: `${vendor.restPrefix}/${nativeId}` })
    headers.delete("x-api-key")
    headers.delete("x-goog-api-key")
    headers.set("authorization", `Bearer ${account.token}`)
    headers.set("cf-aig-gateway-id", account.gateway)
  } else {
    const base = vendor.native.paths[protocol]
    if (base === undefined)
      throw new RouteError(`${vendor.prefix} models don't take the ${protocol} API through the gateway`, protocol)
    const path = protocol === "gemini" ? `${base}/models/${nativeId}:${req.method}` : base
    target = `${GATEWAY}/${account.account}/${account.gateway}/${vendor.slug}${path}${req.search}`
    if (protocol !== "gemini") body = JSON.stringify({ ...req.json, model: nativeId })
    for (const name of VENDOR_AUTH) headers.delete(name)
    headers.set("cf-aig-authorization", `Bearer ${account.token}`)
    if (account.alias) headers.set("cf-aig-byok-alias", account.alias)
  }
  return { url: target, init: { ...init, method: init?.method ?? "POST", headers, body }, vendor, protocol }
}
