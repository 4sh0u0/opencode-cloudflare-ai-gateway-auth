import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin, { _internal } from "../index.mjs"
import { resetModelCache } from "../models.mjs"
import { GATEWAY, PLACEHOLDER } from "../route.mjs"
import { fakeFetch, json } from "./fetch.mjs"

const ACCT = "0123456789abcdef0123456789abcdef"
const AUTH = { type: "api", key: "tok", metadata: { account: ACCT, gateway: "my-gateway", mode: "native", alias: "" } }
const realFetch = globalThis.fetch

// magpie hands server() a project named magpie and its config folder
const MAGPIE = (directory) => ({ project: { id: "magpie" }, directory })

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

  test("refuses a malformed key alias in native mode", () => {
    for (const alias of ["bad alias", "team/a", "tëam", "a".repeat(65), "x\ny"])
      expect([alias, _internal.signIn({ account: ACCT, gateway: "g", mode: "native", alias }).type]).toEqual([alias, "failed"])
    expect(_internal.signIn({ account: ACCT, gateway: "g", mode: "native", alias: "Team_1-a" }).type).toBe("success")
    expect(_internal.signIn({ account: ACCT, gateway: "g", mode: "native", alias: "a".repeat(64) }).type).toBe("success")
    expect(_internal.signIn({ account: ACCT, gateway: "g", mode: "rest", alias: "bad alias" }).type).toBe("success")
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

  test("the REST option says what it needs and that it serves only Cloudflare-catalog models", () => {
    const mode = _internal.PROMPTS.find((p) => p.key === "mode")
    expect(mode.options.find((o) => o.value === "rest").hint).toBe(
      "needs Workers AI Read · only OpenAI/Anthropic models in Cloudflare's catalog",
    )
  })

  test("validates the account and gateway as they are typed", () => {
    const [account, gateway] = _internal.PROMPTS
    expect(account.validate(ACCT)).toBeUndefined()
    expect(typeof account.validate("nope")).toBe("string")
    expect(gateway.validate("my-gateway")).toBeUndefined()
    expect(typeof gateway.validate("bad gateway")).toBe("string")
  })

  test("validates the key alias as it is typed: empty, or up to 64 letters, digits, - and _", () => {
    const alias = _internal.PROMPTS.find((p) => p.key === "alias")
    for (const ok of ["", undefined, " ", "default", "team-a", "Team_1", "a".repeat(64)]) expect(alias.validate(ok)).toBeUndefined()
    for (const bad of ["bad alias", "team/a", "tëam", "a".repeat(65)]) expect(typeof alias.validate(bad)).toBe("string")
  })
})

describe("accountOf", () => {
  test("reads a saved sign-in", () => {
    expect(_internal.accountOf(AUTH)).toEqual({ token: "tok", account: ACCT, gateway: "my-gateway", mode: "native", alias: "" })
  })

  test("asks for a new sign-in when the saved alias is malformed", () => {
    const bad = { ...AUTH, metadata: { ...AUTH.metadata, alias: "bad\nalias" } }
    expect(() => _internal.accountOf(bad)).toThrow()
    try {
      _internal.accountOf(bad)
    } catch (e) {
      expect(e.signIn).toBe("expired")
    }
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
  test("config declares the provider, keeps the user's, and points its baseURL at the placeholder", async () => {
    const hooks = await plugin.server({}, undefined)
    const cfg = {}
    await hooks.config(cfg)
    expect(cfg.provider["cloudflare-ai-gateway"].api).toBe(PLACEHOLDER)
    expect(cfg.provider["cloudflare-ai-gateway"].options).toEqual({ baseURL: PLACEHOLDER })
    // e.g. options written for OpenCode's own provider, with a baseURL of the user's
    const mine = { provider: { "cloudflare-ai-gateway": { name: "mine", options: { baseURL: "https://elsewhere.example", timeout: 5000 } } } }
    await hooks.config(mine)
    expect(mine.provider["cloudflare-ai-gateway"]).toEqual({ name: "mine", options: { baseURL: PLACEHOLDER, timeout: 5000 } })
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
      const hooks = await plugin.server(MAGPIE(dir), {})
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
        const hooks = await plugin.server(MAGPIE(dir), options)
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
    const hooks = await plugin.server(MAGPIE(), {})
    const given = { models: { a: {} } }
    expect(await hooks.provider.models(given, {})).toBe(given.models)
  })

  test("in magpie, a refused token still asks for a new sign-in", async () => {
    globalThis.fetch = fakeFetch([["/provider_configs", json({ success: false, errors: [{ code: 10000 }] }, 401)]])
    const hooks = await plugin.server(MAGPIE(), {})
    await expect(hooks.provider.models({ models: {} }, { auth: AUTH })).rejects.toMatchObject({ signIn: "expired" })
  })

  test("in magpie, models keep their reasoning variants", async () => {
    globalThis.fetch = fakeFetch([
      ["/provider_configs", json({ success: true, result: [{ provider_slug: "anthropic", alias: "default" }] })],
      ["/anthropic/v1/models", json({ data: [{ id: "claude-x" }] })],
      ["models.dev", json({ anthropic: { models: { "claude-x": { id: "claude-x", name: "Claude X", reasoning: true } } } })],
    ])
    const hooks = await plugin.server(MAGPIE(), {})
    const models = await hooks.provider.models({ models: {} }, { auth: AUTH })
    expect(Object.keys(models["anthropic/claude-x"].variants)).toEqual(["low", "medium", "high"])
  })
})

describe("in OpenCode", () => {
  let cache
  let xdg
  beforeEach(async () => {
    cache = await mkdtemp(join(tmpdir(), "cf-aig-cache-"))
    xdg = process.env.XDG_CACHE_HOME
    process.env.XDG_CACHE_HOME = cache
  })
  afterEach(async () => {
    if (xdg === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = xdg
    await rm(cache, { recursive: true, force: true })
  })

  // OpenCode hands server() its project, the project's folder, and a client
  // whose app.log the plugin writes to
  const opencode = (logs, directory = "/work/project") => ({
    project: { id: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" },
    directory,
    client: {
      app: {
        log: async ({ body }) => {
          logs.push(body)
        },
      },
    },
  })
  const keys = (...slugs) => ["/provider_configs", json({ success: true, result: slugs.map((s) => ({ provider_slug: s, alias: "default" })) })]
  const CATALOG = { anthropic: { models: { "claude-x": { id: "claude-x", name: "Claude X", reasoning: true } } } }
  const anthropicRoutes = () => [keys("anthropic"), ["/anthropic/v1/models", json({ data: [{ id: "claude-x" }] })], ["models.dev", json(CATALOG)]]

  test("lists nothing without an API sign-in, whatever the context", async () => {
    const hooks = await plugin.server(opencode([]), {})
    const given = { models: { "anthropic/claude-sonnet-4.5": {} } }
    expect(await hooks.provider.models(given, {})).toEqual({})
    expect(await hooks.provider.models(given)).toEqual({})
    expect(await hooks.provider.models(given, null)).toEqual({})
    expect(await hooks.provider.models(given, { auth: { type: "oauth", refresh: "r", access: "a", expires: 0 } })).toEqual({})
    expect(await hooks.provider.models(given, { auth: { type: "wellknown", key: "k", token: "t" } })).toEqual({})
  })

  test("logs a refused token and lists nothing, without throwing or logging the token", async () => {
    globalThis.fetch = fakeFetch([["/provider_configs", json({ success: false, errors: [{ code: 10000 }] }, 401)]])
    const logs = []
    const hooks = await plugin.server(opencode(logs), {})
    const auth = { ...AUTH, key: "secret-token-value" }
    expect(await hooks.provider.models({ models: {} }, { auth })).toEqual({})
    const error = logs.find((l) => l.level === "error")
    expect(error).toMatchObject({ service: "cloudflare-ai-gateway" })
    expect(error.message).toStartWith("Couldn't list the models: Cloudflare refused the API token")
    expect(JSON.stringify(logs)).not.toContain("secret-token-value")
  })

  test("logs a sign-in it can't read and lists nothing", async () => {
    const logs = []
    const hooks = await plugin.server(opencode(logs), {})
    const auth = { type: "api", key: "tok", metadata: { account: "not-an-account", gateway: "my-gateway", mode: "native" } }
    expect(await hooks.provider.models({ models: {} }, { auth })).toEqual({})
    expect(logs.find((l) => l.level === "error").message).toContain("sign in again")
  })

  test("lists nothing, and says why, when the gateway serves no vendor", async () => {
    globalThis.fetch = fakeFetch([keys(), ["models.dev", json(CATALOG)]])
    const logs = []
    const hooks = await plugin.server(opencode(logs), {})
    expect(await hooks.provider.models({ models: {} }, { auth: AUTH })).toEqual({})
    expect(logs.find((l) => l.level === "warn").message).toStartWith("Nothing to list")
  })

  test("lists models without variants, and caches under XDG_CACHE_HOME rather than the project", async () => {
    const project = await mkdtemp(join(tmpdir(), "cf-aig-project-"))
    try {
      globalThis.fetch = fakeFetch(anthropicRoutes())
      const hooks = await plugin.server(opencode([], project), {})
      const models = await hooks.provider.models({ models: {} }, { auth: AUTH })
      expect(Object.keys(models)).toEqual(["anthropic/claude-x"])
      expect(models["anthropic/claude-x"].capabilities.reasoning).toBe(true)
      expect("variants" in models["anthropic/claude-x"]).toBe(false)
      expect(await readdir(join(cache, "opencode", "cloudflare-ai-gateway-auth"))).toContain("models-dev.json")
      expect(await readdir(project)).toEqual([])
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })

  test("reads a sign-in saved by the TUI's /connect: the answers as typed, without a name", async () => {
    globalThis.fetch = fakeFetch(anthropicRoutes())
    const hooks = await plugin.server(opencode([]), {})
    const typed = { account: ` ${ACCT.toUpperCase()} `, gateway: " my-gateway ", mode: "native", alias: "default" }
    const auth = { type: "api", key: "tok", metadata: typed }
    expect(Object.keys(await hooks.provider.models({ models: {} }, { auth }))).toEqual(["anthropic/claude-x"])
    expect(_internal.accountOf(auth)).toEqual({ token: "tok", account: ACCT, gateway: "my-gateway", mode: "native", alias: "" })
    // an alias typed before switching to REST stays in the answers
    expect(_internal.accountOf({ ...auth, metadata: { ...typed, mode: "rest", alias: "team" } }).alias).toBe("")
  })
})
