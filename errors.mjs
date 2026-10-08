// Cloudflare's own refusals of the API token, by where the request went
// (design spec 7.1). The live probe (spec 11.3) saw the gateway answer 401
// with error[].code 2009 for a malformed or unknown token, and the REST API
// 401 with errors[].code 10000 for those and for a token without Workers AI
// Read.
export const GATEWAY_AUTH_CODES = new Set([2009])
export const API_AUTH_CODES = new Set([10000])
// The gateway's 400 when it holds no key for the vendor under the alias and
// cf-aig-no-wholesale forbids Unified Billing (spec 11.3).
export const NO_STORED_KEY = 2044

const BODIES = {
  messages: (message) => ({ type: "error", error: { type: "invalid_request_error", message } }),
  responses: (message) => ({ error: { message, type: "invalid_request_error" } }),
  chat: (message) => ({ error: { message, type: "invalid_request_error" } }),
  gemini: (message, status) => ({ error: { code: status, message, status: "INVALID_ARGUMENT" } }),
}

// localError is an answer the plugin gives itself, shaped like the API's
// own errors so the agent shows the message.
export function localError(protocol, status, message) {
  const body = (BODIES[protocol] ?? BODIES.chat)(message, status)
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

// errorCodes is every numeric code in a Cloudflare error body; a vendor's
// own error (string codes, or none) has none.
export function errorCodes(text) {
  let json
  try {
    json = JSON.parse(text)
  } catch {
    return []
  }
  return [json?.errors, json?.error]
    .flatMap((e) => (Array.isArray(e) ? e : e && typeof e === "object" ? [e] : []))
    .map((e) => Number(e?.code))
    .filter(Number.isFinite)
}

// signInOf is what a 401 or 403 means for the account: "expired" when
// Cloudflare refused the token, "kept" when it's about anything else (the
// vendor refusing its stored key, or a permission).
export function signInOf(status, text, mode) {
  if (status !== 401 && status !== 403) return null
  const ours = mode === "rest" ? API_AUTH_CODES : GATEWAY_AUTH_CODES
  return status === 401 && errorCodes(text).some((c) => ours.has(c)) ? "expired" : "kept"
}

// annotate tells magpie what a 401 or 403 means through X-Magpie-Sign-In,
// and passes every other answer on as it came.
export async function annotate(response, mode) {
  if (response.status !== 401 && response.status !== 403) return response
  const text = await response.text()
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  headers.set("x-magpie-sign-in", signInOf(response.status, text, mode))
  return new Response(text, { status: response.status, statusText: response.statusText, headers })
}
