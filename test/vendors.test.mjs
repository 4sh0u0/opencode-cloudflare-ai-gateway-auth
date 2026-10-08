import { describe, expect, test } from "bun:test"
import { NPM, PROTOCOL_PATHS, PROVIDER, VENDORS, protocolFor, splitModel, vendorByPrefix } from "../vendors.mjs"

describe("VENDORS", () => {
  test("covers the five supported vendors in order", () => {
    expect(VENDORS.map((v) => v.prefix)).toEqual(["openai", "anthropic", "google", "deepseek", "xai"])
  })

  test("every native default protocol has a path and an AI SDK package", () => {
    for (const v of VENDORS) {
      expect(typeof v.native.paths[v.native.protocol]).toBe("string")
      expect(typeof NPM[v.native.protocol]).toBe("string")
    }
  })

  test("every REST protocol is one the REST API serves", () => {
    for (const v of VENDORS) if (v.rest !== null) expect(Object.keys(PROTOCOL_PATHS)).toContain(v.rest)
  })

  test("xAI goes through the gateway slug grok, Google through google-ai-studio", () => {
    expect(vendorByPrefix("xai").slug).toBe("grok")
    expect(vendorByPrefix("google").slug).toBe("google-ai-studio")
  })

  test("the provider id is fixed", () => {
    expect(PROVIDER).toBe("cloudflare-ai-gateway")
  })
})

describe("splitModel", () => {
  test("splits the prefix from the native id", () => {
    const r = splitModel("anthropic/claude-sonnet-5.5")
    expect(r.prefix).toBe("anthropic")
    expect(r.nativeId).toBe("claude-sonnet-5.5")
    expect(r.vendor.slug).toBe("anthropic")
  })

  test("keeps slashes and colons inside the native id", () => {
    expect(splitModel("openai/ft:gpt-5/acme").nativeId).toBe("ft:gpt-5/acme")
  })

  test("leaves vendor undefined for an unknown prefix", () => {
    const r = splitModel("mistral/mistral-large")
    expect(r.prefix).toBe("mistral")
    expect(r.vendor).toBeUndefined()
  })

  test("rejects keys that aren't <prefix>/<id>", () => {
    for (const key of ["", "gpt-5", "/gpt-5", "openai/", undefined, null, 42]) expect(splitModel(key)).toBeNull()
  })
})

describe("protocolFor", () => {
  test("Google speaks chat completions in both modes", () => {
    const google = vendorByPrefix("google")
    expect(protocolFor(google, "native")).toBe("chat")
    expect(protocolFor(google, "rest")).toBe("chat")
  })

  test("Anthropic speaks Messages in both modes", () => {
    const anthropic = vendorByPrefix("anthropic")
    expect(protocolFor(anthropic, "native")).toBe("messages")
    expect(protocolFor(anthropic, "rest")).toBe("messages")
  })
})
