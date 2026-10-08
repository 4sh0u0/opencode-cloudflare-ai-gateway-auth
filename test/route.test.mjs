import { describe, expect, test } from "bun:test"
import { API, GATEWAY, PLACEHOLDER, RouteError, route } from "../route.mjs"

const ACCT = "0123456789abcdef0123456789abcdef"
const NATIVE = { token: "tok", account: ACCT, gateway: "my-gateway", mode: "native", alias: "" }
const REST = { ...NATIVE, mode: "rest" }
const GW = `${GATEWAY}/${ACCT}/my-gateway`

function request(path, body, headers = {}) {
  return [
    `${PLACEHOLDER}${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "999", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  ]
}

describe("native mode", () => {
  test("Anthropic Messages goes to /anthropic/v1/messages with the gateway token only", () => {
    const [url, init] = request(
      "/messages",
      { model: "anthropic/claude-x", max_tokens: 8 },
      { "x-api-key": "tok", "anthropic-version": "2023-06-01", "anthropic-beta": "b1" },
    )
    const r = route(url, init, NATIVE)
    expect(r.url).toBe(`${GW}/anthropic/v1/messages`)
    expect(r.init.method).toBe("POST")
    expect(JSON.parse(r.init.body)).toEqual({ model: "claude-x", max_tokens: 8 })
    const h = r.init.headers
    expect(h.get("x-api-key")).toBeNull()
    expect(h.get("authorization")).toBeNull()
    expect(h.get("content-length")).toBeNull()
    expect(h.get("cf-aig-authorization")).toBe("Bearer tok")
    expect(h.get("cf-aig-no-wholesale")).toBe("true")
    expect(h.get("anthropic-version")).toBe("2023-06-01")
    expect(h.get("anthropic-beta")).toBe("b1")
    expect(h.get("cf-aig-byok-alias")).toBeNull()
  })

  test("OpenAI Responses and chat completions go to /openai", () => {
    const [u1, i1] = request("/responses", { model: "openai/gpt-x", input: "hi" }, { authorization: "Bearer tok" })
    expect(route(u1, i1, NATIVE).url).toBe(`${GW}/openai/responses`)
    const [u2, i2] = request("/chat/completions", { model: "openai/gpt-x", messages: [] })
    expect(route(u2, i2, NATIVE).url).toBe(`${GW}/openai/chat/completions`)
  })

  test("a native chat request for a Google model goes to the OpenAI-compatible endpoint", () => {
    const [url, init] = request("/chat/completions", { model: "google/gemini-x", messages: [] })
    expect(route(url, init, NATIVE).url).toBe(`${GW}/google-ai-studio/v1beta/openai/chat/completions`)
  })

  test("Gemini streaming keeps its query and body", () => {
    const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] }
    const [url, init] = request("/models/google/gemini-x:streamGenerateContent?alt=sse", body, {
      "x-goog-api-key": "tok",
    })
    const r = route(url, init, NATIVE)
    expect(r.url).toBe(`${GW}/google-ai-studio/v1beta/models/gemini-x:streamGenerateContent?alt=sse`)
    expect(r.init.body).toBe(init.body)
    expect(r.init.headers.get("x-goog-api-key")).toBeNull()
  })

  test("a Gemini model id encoded in the path routes the same way", () => {
    const [url, init] = request("/models/google%2Fgemini-x:generateContent", { contents: [] })
    expect(route(url, init, NATIVE).url).toBe(`${GW}/google-ai-studio/v1beta/models/gemini-x:generateContent`)
  })

  test("DeepSeek and xAI use their chat paths and gateway slugs", () => {
    const [u1, i1] = request("/chat/completions", { model: "deepseek/deepseek-chat", messages: [] })
    expect(route(u1, i1, NATIVE).url).toBe(`${GW}/deepseek/chat/completions`)
    const [u2, i2] = request("/chat/completions", { model: "xai/grok-9", messages: [] })
    const r2 = route(u2, i2, NATIVE)
    expect(r2.url).toBe(`${GW}/grok/v1/chat/completions`)
    expect(JSON.parse(r2.init.body).model).toBe("grok-9")
  })

  test("a native id with slashes is passed on whole", () => {
    const [url, init] = request("/responses", { model: "openai/ft:gpt-5/acme", input: "hi" })
    expect(JSON.parse(route(url, init, NATIVE).init.body).model).toBe("ft:gpt-5/acme")
  })

  test("a byte body is read like a string one", () => {
    const [url, init] = request("/messages")
    init.body = new TextEncoder().encode(JSON.stringify({ model: "anthropic/claude-x" }))
    expect(JSON.parse(route(url, init, NATIVE).init.body).model).toBe("claude-x")
  })

  test("a non-default alias is sent as cf-aig-byok-alias", () => {
    const [url, init] = request("/messages", { model: "anthropic/claude-x" })
    expect(route(url, init, { ...NATIVE, alias: "team" }).init.headers.get("cf-aig-byok-alias")).toBe("team")
  })

  test("allowUnifiedBilling leaves cf-aig-no-wholesale out", () => {
    const [url, init] = request("/messages", { model: "anthropic/claude-x" })
    expect(route(url, init, NATIVE, { allowUnifiedBilling: true }).init.headers.get("cf-aig-no-wholesale")).toBeNull()
  })

  test("an API the vendor doesn't take through the gateway is refused", () => {
    const [url, init] = request("/responses", { model: "deepseek/deepseek-chat", input: "hi" })
    expect(() => route(url, init, NATIVE)).toThrow(RouteError)
  })
})

describe("REST mode", () => {
  test("Anthropic Messages goes to /ai/v1/messages with the prefixed model", () => {
    const [url, init] = request("/messages", { model: "anthropic/claude-x" }, { "x-api-key": "tok" })
    const r = route(url, init, REST)
    expect(r.url).toBe(`${API}/accounts/${ACCT}/ai/v1/messages`)
    expect(JSON.parse(r.init.body).model).toBe("anthropic/claude-x")
    const h = r.init.headers
    expect(h.get("authorization")).toBe("Bearer tok")
    expect(h.get("x-api-key")).toBeNull()
    expect(h.get("cf-aig-gateway-id")).toBe("my-gateway")
    expect(h.get("cf-aig-no-wholesale")).toBe("true")
    expect(h.get("cf-aig-authorization")).toBeNull()
  })

  test("OpenAI Responses goes to /ai/v1/responses with the prefixed model", () => {
    const [url, init] = request("/responses", { model: "openai/gpt-x", input: "hi" }, { authorization: "Bearer sk-vendor" })
    const r = route(url, init, REST)
    expect(r.url).toBe(`${API}/accounts/${ACCT}/ai/v1/responses`)
    expect(JSON.parse(r.init.body).model).toBe("openai/gpt-x")
    expect(r.init.headers.get("authorization")).toBe("Bearer tok")
  })

  test("a catalog id with a dot, as REST mode lists it, goes out as it is", () => {
    const [url, init] = request("/messages", { model: "anthropic/claude-sonnet-5.5", max_tokens: 8 })
    const r = route(url, init, REST)
    expect(r.url).toBe(`${API}/accounts/${ACCT}/ai/v1/messages`)
    expect(JSON.parse(r.init.body)).toEqual({ model: "anthropic/claude-sonnet-5.5", max_tokens: 8 })
  })

  test("Google, DeepSeek and xAI are refused in the chat shape, pointing to the native mode", () => {
    for (const model of ["google/gemini-x", "deepseek/deepseek-x", "xai/grok-9"]) {
      const [url, init] = request("/chat/completions", { model, messages: [] })
      const e = (() => {
        try {
          route(url, init, REST)
        } catch (e) {
          return e
        }
      })()
      expect(e).toBeInstanceOf(RouteError)
      expect(e.protocol).toBe("chat")
      expect(e.message).toContain("native mode")
    }
  })

  test("Gemini's API has no REST endpoint", () => {
    const [url, init] = request("/models/google/gemini-x:generateContent", { contents: [] })
    expect(() => route(url, init, REST)).toThrow(RouteError)
  })
})

describe("refusals", () => {
  test("an unknown vendor is refused in the request's protocol", () => {
    const [url, init] = request("/messages", { model: "mistral/large" })
    try {
      route(url, init, NATIVE)
      throw new Error("expected a RouteError")
    } catch (e) {
      expect(e).toBeInstanceOf(RouteError)
      expect(e.protocol).toBe("messages")
      expect(e.message).toContain("mistral")
    }
  })

  test("a model without a vendor prefix is refused", () => {
    const [url, init] = request("/chat/completions", { model: "gpt-5", messages: [] })
    expect(() => route(url, init, NATIVE)).toThrow(RouteError)
  })

  const refusal = (url, init) => {
    try {
      route(url, init, NATIVE)
    } catch (e) {
      return e
    }
    throw new Error("expected a RouteError")
  }

  test("an unknown path is refused as an unsupported endpoint, in the chat shape", () => {
    const e = refusal(...request("/embeddings", { model: "openai/text-embedding-3" }))
    expect(e).toBeInstanceOf(RouteError)
    expect(e.message).toBe("Unsupported endpoint: /embeddings")
    expect(e.protocol).toBe("chat")
  })

  test("a path under /messages/, such as count_tokens, is refused in the Anthropic shape", () => {
    const e = refusal(...request("/messages/count_tokens", { model: "anthropic/claude-x", messages: [] }))
    expect(e).toBeInstanceOf(RouteError)
    expect(e.message).toBe("Unsupported endpoint: /messages/count_tokens")
    expect(e.protocol).toBe("messages")
  })

  test("a path under /responses/ is refused in the Responses shape", () => {
    const e = refusal(...request("/responses/resp_1/cancel", {}))
    expect(e.message).toBe("Unsupported endpoint: /responses/resp_1/cancel")
    expect(e.protocol).toBe("responses")
  })

  test("a body that isn't JSON is refused", () => {
    const [url, init] = request("/messages")
    init.body = "not json"
    expect(() => route(url, init, NATIVE)).toThrow(RouteError)
  })
})
