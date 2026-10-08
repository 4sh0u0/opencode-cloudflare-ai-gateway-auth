import { describe, expect, test } from "bun:test"
import { NO_STORED_KEY, annotate, errorCodes, localError, signInOf } from "../errors.mjs"

// Bodies as the live probe (design spec 11.3) saw them.
const gatewayError = (status, code, message) =>
  JSON.stringify({
    success: false,
    result: [],
    messages: [],
    error: [{ code, message }],
    name: "AiGatewayError",
    httpCode: status,
    internalCode: code,
    message,
    description: message,
  })
const gatewayRefusal = gatewayError(401, 2009, "Unauthorized")
const noStoredKey = gatewayError(400, 2044, "Customer-provided provider credentials are required for this request")
const apiError = (code, message) => JSON.stringify({ result: null, success: false, errors: [{ code, message }], messages: [] })
const apiRefusal = apiError(10000, "Authentication error")
const anthropicRefusal = JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })
const openaiRefusal = JSON.stringify({ error: { message: "Incorrect API key", code: "invalid_api_key" } })

describe("signInOf", () => {
  test("Cloudflare refusing the token on the gateway expires the sign-in", () => {
    expect(signInOf(401, gatewayRefusal, "native")).toBe("expired")
  })

  test("Cloudflare refusing the token on the REST API expires the sign-in", () => {
    expect(signInOf(401, apiRefusal, "rest")).toBe("expired")
  })

  test("a vendor refusing its stored key keeps the sign-in", () => {
    expect(signInOf(401, anthropicRefusal, "native")).toBe("kept")
    expect(signInOf(401, openaiRefusal, "rest")).toBe("kept")
    expect(signInOf(403, gatewayRefusal, "native")).toBe("kept")
  })

  test("an HTML refusal keeps the sign-in", () => {
    expect(signInOf(401, "<html>denied</html>", "native")).toBe("kept")
  })

  test("only the code Cloudflare uses for the token expires a REST sign-in", () => {
    expect(signInOf(401, apiError(9109, "Invalid access token"), "rest")).toBe("kept")
  })

  test("other statuses say nothing", () => {
    for (const status of [200, 400, 429, 500]) expect(signInOf(status, gatewayRefusal, "native")).toBeNull()
    expect(signInOf(400, noStoredKey, "native")).toBeNull()
  })
})

describe("errorCodes", () => {
  test("reads the gateway's error[] and the API's errors[] codes", () => {
    expect(errorCodes(noStoredKey)).toEqual([NO_STORED_KEY])
    expect(errorCodes(apiRefusal)).toEqual([10000])
  })

  test("finds none in a vendor's own error or a non-JSON body", () => {
    expect(errorCodes(openaiRefusal)).toEqual([])
    expect(errorCodes("<html>")).toEqual([])
  })
})

describe("annotate", () => {
  test("passes a success through untouched", async () => {
    const res = new Response("ok", { status: 200 })
    expect(await annotate(res, "native")).toBe(res)
  })

  test("passes a 400 and a 429 through untouched", async () => {
    for (const status of [400, 429, 503]) {
      const res = new Response("x", { status })
      expect(await annotate(res, "native")).toBe(res)
    }
  })

  test("marks a gateway 401 expired and keeps the body", async () => {
    const res = new Response(gatewayRefusal, {
      status: 401,
      headers: { "content-type": "application/json", "content-length": "5", "content-encoding": "gzip" },
    })
    const out = await annotate(res, "native")
    expect(out.status).toBe(401)
    expect(out.headers.get("x-magpie-sign-in")).toBe("expired")
    expect(out.headers.get("content-length")).toBeNull()
    expect(out.headers.get("content-encoding")).toBeNull()
    expect(await out.text()).toBe(gatewayRefusal)
  })

  test("marks an HTML 403 kept without throwing", async () => {
    const out = await annotate(new Response("<html></html>", { status: 403 }), "rest")
    expect(out.headers.get("x-magpie-sign-in")).toBe("kept")
  })
})

describe("localError", () => {
  test("answers in the Anthropic error shape", async () => {
    const res = localError("messages", 400, "nope")
    expect(res.status).toBe(400)
    expect(res.headers.get("content-type")).toBe("application/json")
    expect(await res.json()).toEqual({ type: "error", error: { type: "invalid_request_error", message: "nope" } })
  })

  test("answers in the OpenAI error shape for chat and responses", async () => {
    for (const protocol of ["chat", "responses"])
      expect(await localError(protocol, 400, "nope").json()).toEqual({
        error: { message: "nope", type: "invalid_request_error" },
      })
  })

  test("answers in the Gemini error shape", async () => {
    expect(await localError("gemini", 400, "nope").json()).toEqual({
      error: { code: 400, message: "nope", status: "INVALID_ARGUMENT" },
    })
  })
})
