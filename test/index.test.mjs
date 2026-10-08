import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin, { _internal } from "../index.mjs"
import { resetModelCache } from "../models.mjs"
import { GATEWAY, PLACEHOLDER } from "../route.mjs"
import { fakeFetch, json } from "./fetch.mjs"

const ACCT = "0123456789abcdef0123456789abcdef"
const AUTH = { type: "api", key: "tok", metadata: { account: ACCT, gateway: "my-gateway", mode: "native", alias: "" } }
const realFetch = globalThis.fetch

beforeEach(() => {
  resetModelCache()
})
afterEach(() => {
  globalThis.fetch = realFetch
})

describe("signIn", () => {
  test("normalizes the answers and names the account", () => {
    const r = _internal.signIn({ account: ` ${ACCT.toUpperCase()} `, gateway: " my-gateway ", mode: "native", alias: " default " })
    expect(r).toEqual({
      type: "success",
      metadata: { account: ACCT, gateway: "my-gateway", mode: "native", alias: "", email: `my-gateway · ${ACCT.slice(0, 8)}` },
    })
  })

  // magpie's host replaces an account whose name (metadata.email) equals a
  // new sign-in's, so the name tells every gateway, alias and mode apart
  test("names each gateway, key alias and mode apart, and the same sign-in alike", () => {
    const at = ACCT.slice(0, 8)
    const email = (inputs) => _internal.signIn({ account: ACCT, gateway: "g", ...inputs }).metadata.email
    expect(email({ mode: "native", alias: "" })).toBe(`g · ${at}`)
    expect(email({ mode: "native", alias: "default" })).toBe(`g · ${at}`)
    expect(email({ mode: "native", alias: "team-a" })).toBe(`g/team-a · ${at}`)
    expect(email({ mode: "native", alias: "team-b" })).toBe(`g/team-b · ${at}`)
    expect(email({ mode: "rest" })).toBe(`g · ${at} · REST`)
    expect(email({ mode: "rest", alias: "team-a" })).toBe(`g · ${at} · REST`)
    expect(email({ mode: "native", alias: "team-a" })).toBe(email({ mode: "native", alias: " team-a " }))
  })

  test("keeps a real alias in native mode and drops it in REST mode", () => {
    expect(_internal.signIn({ account: ACCT, gateway: "g", mode: "native", alias: "team" }).metadata.alias).toBe("team")
    expect(_internal.signIn({ account: ACCT, gateway: "g", mode: "rest", alias: "team" }).metadata.alias).toBe("")
  })

  test("treats a missing mode as native", () => {
    expect(_internal.signIn({ account: ACCT, gateway: "g" }).metadata.mode).toBe("native")
  })

  test("refuses a malformed account or gateway id", () => {
    expect(_internal.signIn({ account: "abc", gateway: "g" }).type).toBe("failed")
    expect(_internal.signIn({ account: ACCT, gateway: "My Gateway" }).type).toBe("failed")
    expect(_internal.signIn({ account: ACCT, gateway: "x".repeat(65) }).type).toBe("failed")
  })
})

describe("PROMPTS", () => {
  test("asks account, gateway, mode, then alias only in native mode", () => {
    expect(_internal.PROMPTS.map((p) => p.key)).toEqual(["account", "gateway", "mode", "alias"])
    expect(_internal.PROMPTS[3].when).toEqual({ key: "mode", op: "eq", value: "native" })
  })

  test("validates the account and gateway as they are typed", () => {
    const [account, gateway] = _internal.PROMPTS
    expect(account.validate(ACCT)).toBeUndefined()
    expect(typeof account.validate("nope")).toBe("string")
    expect(gateway.validate("my-gateway")).toBeUndefined()
    expect(typeof gateway.validate("bad gateway")).toBe("string")
  })
})

describe("accountOf", () => {
  test("reads a saved sign-in", () => {
    expect(_internal.accountOf(AUTH)).toEqual({ token: "tok", account: ACCT, gateway: "my-gateway", mode: "native", alias: "" })
  })

  test("asks for a new sign-in when the metadata is gone", () => {
    expect(() => _internal.accountOf({ type: "api", key: "tok" })).toThrow()
    try {
      _internal.accountOf({ type: "api", key: "tok" })
    } catch (e) {
      expect(e.signIn).toBe("expired")
    }
  })
})

describe("send", () => {
  const account = _internal.accountOf(AUTH)

  test("answers an unroutable request locally without calling out", async () => {
    const f = fakeFetch([])
    const res = await _internal.send(
      `${PLACEHOLDER}/messages`,
      { method: "POST", body: JSON.stringify({ model: "mistral/large" }) },
      account,
      {},
      f,
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error.type).toBe("invalid_request_error")
    expect(f.calls.length).toBe(0)
  })

  test("answers count_tokens locally as an Anthropic error magpie reads as an unsupported endpoint", async () => {
    const f = fakeFetch([])
    const res = await _internal.send(
      `${PLACEHOLDER}/messages/count_tokens`,
      { method: "POST", body: JSON.stringify({ model: "anthropic/claude-x", messages: [] }) },
      account,
      {},
      f,
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.type).toBe("error")
    expect(body.error.type).toBe("invalid_request_error")
    // the part of magpie 0.1.1110's "not supported" pattern an endpoint message meets
    expect(body.error.message).toMatch(/^(this |the )?(unsupported|unimplemented) (endpoint|api|method|operation)(:|$)/i)
    expect(f.calls.length).toBe(0)
  })

  test("routes and marks Cloudflare's refusal", async () => {
    const f = fakeFetch([["/anthropic/v1/messages", json({ success: false, error: [{ code: 2009 }] }, 401)]])
    const res = await _internal.send(
      `${PLACEHOLDER}/messages`,
      { method: "POST", headers: { "x-api-key": "tok" }, body: JSON.stringify({ model: "anthropic/claude-x" }) },
      account,
      {},
      f,
    )
    expect(f.calls[0].url).toBe(`${GATEWAY}/${ACCT}/my-gateway/anthropic/v1/messages`)
    expect(res.headers.get("x-magpie-sign-in")).toBe("expired")
  })
})

describe("server hooks", () => {
  test("config declares the provider without overwriting the user's", async () => {
    const hooks = await plugin.server({}, undefined)
    const cfg = {}
    await hooks.config(cfg)
    expect(cfg.provider["cloudflare-ai-gateway"].api).toBe(PLACEHOLDER)
    const mine = { provider: { "cloudflare-ai-gateway": { name: "mine" } } }
    await hooks.config(mine)
    expect(mine.provider["cloudflare-ai-gateway"]).toEqual({ name: "mine" })
  })

  test("the loader sends through Cloudflare with the account's token", async () => {
    const f = fakeFetch([["/anthropic/v1/messages", json({ ok: true })]])
    globalThis.fetch = f
    const hooks = await plugin.server({}, {})
    const loaded = await hooks.auth.loader(async () => AUTH)
    expect(loaded.baseURL).toBe(PLACEHOLDER)
    const res = await loaded.fetch(`${PLACEHOLDER}/messages`, {
      method: "POST",
      headers: { "x-api-key": "tok" },
      body: JSON.stringify({ model: "anthropic/claude-x", max_tokens: 1 }),
    })
    expect(res.status).toBe(200)
    const headers = new Headers(f.calls[0].init.headers)
    expect(headers.get("cf-aig-authorization")).toBe("Bearer tok")
    expect(headers.get("cf-aig-no-wholesale")).toBe("true")
  })

  test("allowUnifiedBilling in the plugin's options drops cf-aig-no-wholesale", async () => {
    const f = fakeFetch([["/anthropic/v1/messages", json({ ok: true })]])
    globalThis.fetch = f
    const hooks = await plugin.server({}, { allowUnifiedBilling: true })
    const loaded = await hooks.auth.loader(async () => AUTH)
    await loaded.fetch(`${PLACEHOLDER}/messages`, { method: "POST", body: JSON.stringify({ model: "anthropic/claude-x" }) })
    expect(new Headers(f.calls[0].init.headers).get("cf-aig-no-wholesale")).toBeNull()
  })

  test("the loader gives nothing without an API sign-in", async () => {
    const hooks = await plugin.server({}, {})
    expect(await hooks.auth.loader(async () => undefined)).toEqual({})
  })

  test("models keeps magpie's list, marked, when nothing is listed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cf-aig-"))
    try {
      globalThis.fetch = fakeFetch([["/provider_configs", json({ success: true, result: [] })]])
      const hooks = await plugin.server({ directory: dir }, {})
      const given = { models: { "anthropic/claude-x": { id: "anthropic/claude-x" } } }
      const out = await hooks.provider.models(given, { auth: AUTH })
      expect(Object.keys(out)).toEqual(["anthropic/claude-x"])
      expect(out[Symbol.for("magpie.fellBack")]).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("models passes allowUnifiedBilling on to the list requests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cf-aig-"))
    try {
      const wholesale = async (options, auth) => {
        const f = fakeFetch([
          ["/provider_configs", json({ success: true, result: [{ provider_slug: "anthropic", alias: "default" }] })],
          ["/anthropic/v1/models", json({ data: [{ id: "claude-x" }] })],
          ["models.dev", json({})],
        ])
        globalThis.fetch = f
        const hooks = await plugin.server({ directory: dir }, options)
        await hooks.provider.models({ models: {} }, { auth })
        return new Headers(f.calls.find((c) => c.url.includes("/anthropic/v1/models")).init.headers).get("cf-aig-no-wholesale")
      }
      expect(await wholesale({}, AUTH)).toBe("true")
      expect(await wholesale({ allowUnifiedBilling: true }, { ...AUTH, key: "tok2" })).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("models returns the given list without an API sign-in", async () => {
    const hooks = await plugin.server({}, {})
    const given = { models: { a: {} } }
    expect(await hooks.provider.models(given, {})).toBe(given.models)
  })
})
