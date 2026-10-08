import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CACHE_TTL,
  CATALOG_RETRY,
  DEFAULT_LIMIT,
  LIST_TTL,
  buildModel,
  isTextModel,
  listKey,
  listModels,
  loadCatalog,
  metaFor,
  parseList,
  resetModelCache,
  restMetaFor,
} from "../models.mjs"
import { CF_CATALOG } from "../cfcatalog.mjs"
import { GATEWAY, PLACEHOLDER } from "../route.mjs"
import { NPM, vendorByPrefix } from "../vendors.mjs"
import { fakeFetch, json } from "./fetch.mjs"

// A hand-written page in the shape of Cloudflare's model catalog: OpenAI
// gpt-4.1-nano and gpt-5.5, Anthropic claude-haiku-4.5, claude-sonnet-5.5 and
// claude-sonnet-5, Google gemini-x, and entries that aren't Text Generation.
const CF_PAGE = await readFile(new URL("./cf-catalog.md", import.meta.url), "utf8")
const cfPage = (text = CF_PAGE, status = 200) => [CF_CATALOG, new Response(text, { status })]
// one catalog entry, in the page's shape
const cfEntry = (author, id, task = "Text Generation") =>
  `[![Logo](https://developers.cloudflare.com/_astro/x.svg)<h3>${id}</h3>\n\n${author}${task} A model.](https://developers.cloudflare.com/ai/models/${author}/${id}/)\n\nCompare\n\n`

const ACCOUNT = {
  token: "tok",
  account: "0123456789abcdef0123456789abcdef",
  gateway: "my-gateway",
  mode: "native",
  alias: "",
}

const CATALOG = {
  openai: { models: {} },
  anthropic: {
    models: {
      "claude-x": {
        id: "claude-x",
        name: "Claude X (models.dev)",
        limit: { context: 200000, output: 64000 },
        reasoning: true,
        reasoning_options: [{ type: "budget_tokens", min: 1024 }],
        tool_call: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      },
    },
  },
  google: {
    models: {
      "gemini-x": {
        id: "gemini-x",
        name: "Gemini X",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high"] }],
      },
    },
  },
  deepseek: { models: {} },
  xai: {
    models: {
      "grok-9": { id: "grok-9", name: "Grok 9", limit: { context: 256000, output: 32000 } },
      "grok-old": { id: "grok-old", name: "Grok Old", status: "deprecated" },
      "grok-imagine": { id: "grok-imagine", modalities: { input: ["text"], output: ["image"] } },
    },
  },
}

let dir
beforeEach(async () => {
  resetModelCache()
  dir = await mkdtemp(join(tmpdir(), "cf-aig-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("parseList", () => {
  test("reads OpenAI-style lists", () => {
    expect(parseList("openai", { data: [{ id: "gpt-x" }, { id: "" }, {}] })).toEqual([{ id: "gpt-x", name: undefined }])
  })

  test("reads Anthropic's display names", () => {
    expect(parseList("anthropic", { data: [{ id: "claude-x", display_name: "Claude X" }] })).toEqual([
      { id: "claude-x", name: "Claude X" },
    ])
  })

  test("reads Gemini's generateContent models with their limits", () => {
    const out = parseList("gemini", {
      models: [
        {
          name: "models/gemini-x",
          displayName: "Gemini X",
          inputTokenLimit: 1000000,
          outputTokenLimit: 65536,
          supportedGenerationMethods: ["generateContent"],
        },
        { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
      ],
    })
    expect(out).toEqual([{ id: "gemini-x", name: "Gemini X", limit: { context: 1000000, output: 65536 } }])
  })

  test("returns nothing for a malformed answer", () => {
    expect(parseList("openai", null)).toEqual([])
    expect(parseList("gemini", { models: "x" })).toEqual([])
  })
})

describe("isTextModel", () => {
  test("keeps chat models and drops the rest", () => {
    expect(isTextModel("gpt-5.5")).toBe(true)
    for (const id of ["text-embedding-3", "gpt-4o-mini-tts", "tts-1", "gpt-image-1", "whisper-1", "gpt-realtime"])
      expect(isTextModel(id)).toBe(false)
  })

  test("drops deprecated models and ones that don't answer in text", () => {
    expect(isTextModel("grok-old", { status: "deprecated" })).toBe(false)
    expect(isTextModel("grok-imagine", { modalities: { output: ["image"] } })).toBe(false)
  })

  // ids seen in the real sandbox listing (spec 11.5) that don't chat over the
  // API the plugin declares for their vendor
  const NOT_CHAT = {
    openai: [
      "davinci-002",
      "babbage-002",
      "gpt-3.5-turbo-instruct",
      "gpt-3.5-turbo-instruct-0914",
      "gpt-4o-search-preview",
      "gpt-4o-search-preview-2025-03-11",
      "gpt-4o-mini-search-preview",
      "gpt-4o-mini-search-preview-2025-03-11",
      "gpt-5-search-api",
      "gpt-5-search-api-2025-10-14",
    ],
    google: ["lyria-3-clip-preview", "lyria-3-pro-preview", "lyria-3.5", "nano-banana-pro-preview", "gemini-nano-banana-2.1"],
    xai: ["grok-imagine-image", "grok-imagine-video", "grok-imagine-video-1.0-lite"],
  }

  test("drops each vendor's non-chat ids by id alone, without models.dev", () => {
    for (const [prefix, ids] of Object.entries(NOT_CHAT))
      for (const id of ids) expect([prefix, id, isTextModel(id, undefined, vendorByPrefix(prefix))]).toEqual([prefix, id, false])
  })

  test("keeps the chat models beside them, and a vendor's patterns apply to it alone", () => {
    const keep = [
      ["openai", "gpt-4o"],
      ["openai", "gpt-4o-2024-08-06"],
      ["openai", "gpt-3.5-turbo-0125"],
      ["openai", "gpt-5-chat-latest"],
      ["google", "gemini-2.5-flash"],
      ["google", "gemma-4-31b-it"],
      ["xai", "grok-4.3"],
      ["openai", "lyria-3.5"],
      ["anthropic", "grok-imagine-video"],
    ]
    for (const [prefix, id] of keep) expect([prefix, id, isTextModel(id, undefined, vendorByPrefix(prefix))]).toEqual([prefix, id, true])
  })
})

describe("buildModel", () => {
  const anthropic = vendorByPrefix("anthropic")
  const google = vendorByPrefix("google")

  test("prefers models.dev metadata, then the live entry, then defaults", () => {
    const m = buildModel(
      anthropic,
      { id: "claude-x", name: "Claude X (live)", limit: { context: 100 } },
      CATALOG.anthropic.models["claude-x"],
      "native",
    )
    expect(m.id).toBe("anthropic/claude-x")
    expect(m.providerID).toBe("cloudflare-ai-gateway")
    expect(m.name).toBe("Claude X (models.dev)")
    expect(m.limit).toEqual({ context: 200000, output: 64000 })
    expect(m.api).toEqual({
      id: "anthropic/claude-x",
      url: "https://cloudflare-ai-gateway.invalid",
      npm: NPM.messages,
    })
    expect(m.capabilities.reasoning).toBe(true)
    expect(m.capabilities.input.image).toBe(true)
    expect(m.cost).toEqual({ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } })
    expect(Object.keys(m.variants)).toEqual(["low", "medium", "high"])
  })

  test("uses the live entry and defaults without metadata", () => {
    const m = buildModel(google, { id: "gemini-y", name: "Gemini Y", limit: { context: 1000000 } }, undefined, "native")
    expect(m.name).toBe("Gemini Y")
    expect(m.limit).toEqual({ context: 1000000, output: DEFAULT_LIMIT.output })
    expect(m.capabilities.toolcall).toBe(true)
    expect(m.capabilities.reasoning).toBe(false)
    expect(m.capabilities.temperature).toBe(false)
    expect(m.variants).toEqual({})
  })

  test("takes temperature from models.dev, and leaves it off without", () => {
    expect(buildModel(anthropic, { id: "claude-x" }, { temperature: true }, "native").capabilities.temperature).toBe(true)
    expect(buildModel(anthropic, { id: "claude-x" }, { temperature: false }, "native").capabilities.temperature).toBe(false)
    expect(buildModel(anthropic, { id: "claude-x" }, { name: "Claude X" }, "native").capabilities.temperature).toBe(false)
  })

  test("turns effort options into variants", () => {
    const m = buildModel(google, { id: "gemini-x" }, CATALOG.google.models["gemini-x"], "native")
    expect(m.variants).toEqual({ low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } })
  })

  test("declares the API by mode", () => {
    expect(buildModel(google, { id: "gemini-x" }, undefined, "native").api.npm).toBe(NPM.chat)
    expect(buildModel(anthropic, { id: "claude-x" }, undefined, "rest").api.npm).toBe(NPM.messages)
  })
})

describe("metaFor", () => {
  const base = { id: "gpt-x", name: "GPT X", limit: { context: 400000, output: 128000 }, reasoning: true }
  const dated = { id: "gpt-x-2025-08-07", name: "GPT X (2025-08-07)" }

  test("takes the exact id first", () => {
    expect(metaFor({ "gpt-x": base, "gpt-x-2025-08-07": dated }, "gpt-x-2025-08-07")).toBe(dated)
    expect(metaFor({ "gpt-x": base }, "gpt-x")).toBe(base)
  })

  test("falls back to the id without a -YYYY-MM-DD or -YYYYMMDD suffix, keeping the snapshot's own name", () => {
    for (const id of ["gpt-x-2025-08-07", "gpt-x-20250807"]) {
      const meta = metaFor({ "gpt-x": base }, id)
      expect(meta.limit).toEqual(base.limit)
      expect(meta.reasoning).toBe(true)
      expect(meta.name).toBeUndefined()
    }
  })

  test("finds nothing for other suffixes or unknown models", () => {
    const metas = { "gpt-4": base, "grok-4.20": base }
    expect(metaFor(metas, "gpt-4-0613")).toBeUndefined()
    expect(metaFor(metas, "grok-4.20-0309-reasoning")).toBeUndefined()
    expect(metaFor(metas, "gpt-y-2025-08-07")).toBeUndefined()
    expect(metaFor({}, "gpt-x")).toBeUndefined()
    expect(metaFor({}, "constructor")).toBeUndefined()
    expect(metaFor({}, "constructor-2025-08-07")).toBeUndefined()
  })
})

describe("restMetaFor", () => {
  const anthropic = vendorByPrefix("anthropic")
  const id = "claude-x.1-20260101"
  const gateway = { name: "AI Gateway's" }
  const exact = { name: "exact" }
  const dashed = { name: "dashed" }
  const base = { name: "base", limit: { context: 200000, output: 64000 } }
  const catalog = (gw, native) => ({ "cloudflare-ai-gateway": { models: gw }, anthropic: { models: native } })

  test("takes models.dev's cloudflare-ai-gateway entry, then the vendor's by id, with dots as dashes, then the dated base", () => {
    const native = { [id]: exact, "claude-x-1-20260101": dashed, "claude-x-1": base }
    expect(restMetaFor(catalog({ [`anthropic/${id}`]: gateway }, native), anthropic, id)).toBe(gateway)
    expect(restMetaFor(catalog({}, native), anthropic, id)).toBe(exact)
    const { [id]: _, ...withoutExact } = native
    expect(restMetaFor(catalog({}, withoutExact), anthropic, id)).toBe(dashed)
    const meta = restMetaFor(catalog({}, { "claude-x-1": base }), anthropic, id)
    expect(meta.limit).toEqual(base.limit)
    expect(meta.name).toBeUndefined()
  })

  test("finds the dated base of an id with dots, as OpenAI writes them", () => {
    const openai = vendorByPrefix("openai")
    const meta = restMetaFor({ openai: { models: { "gpt-4.1": base } } }, openai, "gpt-4.1-2025-04-14")
    expect(meta.limit).toEqual(base.limit)
  })

  test("finds nothing without a catalog", () => {
    expect(restMetaFor(null, anthropic, "claude-x")).toBeUndefined()
    expect(restMetaFor({}, anthropic, "constructor")).toBeUndefined()
  })
})

describe("loadCatalog", () => {
  test("fetches models.dev once and keeps only the vendors' catalogs and cloudflare-ai-gateway", async () => {
    const gateway = { models: { "anthropic/claude-sonnet-5.5": { name: "Claude Sonnet 5.5" } } }
    const f = fakeFetch([["models.dev", json({ ...CATALOG, mistral: { models: { m: {} } }, "cloudflare-ai-gateway": gateway })]])
    const first = await loadCatalog({ directory: dir, fetchImpl: f, now: () => 1000 })
    expect(Object.keys(first).sort()).toEqual(["anthropic", "cloudflare-ai-gateway", "deepseek", "google", "openai", "xai"])
    expect(first["cloudflare-ai-gateway"]).toEqual(gateway)
    const second = await loadCatalog({ directory: dir, fetchImpl: f, now: () => 1000 + CACHE_TTL - 1 })
    expect(second).toEqual(first)
    expect(f.calls.length).toBe(1)
    const saved = JSON.parse(await readFile(join(dir, "cloudflare-ai-gateway-auth", "models-dev.json"), "utf8"))
    expect(saved.fetchedAt).toBe(1000)
  })

  test("falls back to a stale cache when models.dev is down", async () => {
    await loadCatalog({ directory: dir, fetchImpl: fakeFetch([["models.dev", json(CATALOG)]]), now: () => 0 })
    const down = fakeFetch([["models.dev", new Response("", { status: 503 })]])
    const out = await loadCatalog({ directory: dir, fetchImpl: down, now: () => CACHE_TTL * 2 })
    expect(out.xai.models["grok-9"].name).toBe("Grok 9")
  })

  test("throws with neither models.dev nor a cache", async () => {
    const down = fakeFetch([["models.dev", new Response("", { status: 503 })]])
    await expect(loadCatalog({ directory: dir, fetchImpl: down, now: () => 0 })).rejects.toThrow()
  })

  test("ignores a corrupt or misshapen cache file and asks models.dev", async () => {
    const file = join(dir, "cloudflare-ai-gateway-auth", "models-dev.json")
    await mkdir(join(dir, "cloudflare-ai-gateway-auth"), { recursive: true })
    const corrupt = [
      "not json",
      JSON.stringify(null),
      JSON.stringify({ fetchedAt: 0, data: "oops" }),
      JSON.stringify({ fetchedAt: 0, data: null }),
      JSON.stringify({ fetchedAt: 0, data: [] }),
      JSON.stringify({ fetchedAt: 0, data: { ...CATALOG, openai: { models: "x" } } }),
      // an older copy, kept before cloudflare-ai-gateway was
      JSON.stringify({ fetchedAt: 0, data: CATALOG }),
    ]
    for (const text of corrupt) {
      resetModelCache()
      await writeFile(file, text)
      const f = fakeFetch([["models.dev", json(CATALOG)]])
      const out = await loadCatalog({ directory: dir, fetchImpl: f, now: () => 1 })
      expect([text, f.calls.length]).toEqual([text, 1])
      expect(out.xai.models["grok-9"].name).toBe("Grok 9")
    }
  })

  test("doesn't serve a corrupt cache file while models.dev is down", async () => {
    await mkdir(join(dir, "cloudflare-ai-gateway-auth"), { recursive: true })
    await writeFile(join(dir, "cloudflare-ai-gateway-auth", "models-dev.json"), JSON.stringify({ fetchedAt: 0, data: "oops" }))
    const down = fakeFetch([["models.dev", new Response("", { status: 503 })]])
    await expect(loadCatalog({ directory: dir, fetchImpl: down, now: () => CACHE_TTL * 2 })).rejects.toThrow("503")
  })

  test("keeps a vendor's catalog only when its models are an object", async () => {
    const f = fakeFetch([["models.dev", json({ ...CATALOG, openai: { models: ["gpt-x"] } })]])
    const out = await loadCatalog({ directory: dir, fetchImpl: f, now: () => 0 })
    expect(out.openai.models).toEqual({})
  })

  test("after a failure, doesn't ask models.dev again for CATALOG_RETRY", async () => {
    expect(CATALOG_RETRY).toBe(10 * 60 * 1000)
    const down = fakeFetch([["models.dev", new Response("", { status: 503 })]])
    await expect(loadCatalog({ directory: dir, fetchImpl: down, now: () => 0 })).rejects.toThrow("503")
    await expect(loadCatalog({ directory: dir, fetchImpl: down, now: () => CATALOG_RETRY - 1 })).rejects.toThrow("503")
    expect(down.calls.length).toBe(1)
    const up = fakeFetch([["models.dev", json(CATALOG)]])
    const out = await loadCatalog({ directory: dir, fetchImpl: up, now: () => CATALOG_RETRY })
    expect(out.xai.models["grok-9"].name).toBe("Grok 9")
    expect(up.calls.length).toBe(1)
  })

  test("after a failed refresh, serves the stale cache without asking again for CATALOG_RETRY", async () => {
    await loadCatalog({ directory: dir, fetchImpl: fakeFetch([["models.dev", json(CATALOG)]]), now: () => 0 })
    const stale = CACHE_TTL * 2
    const down = fakeFetch([["models.dev", new Response("", { status: 503 })]])
    expect((await loadCatalog({ directory: dir, fetchImpl: down, now: () => stale })).xai).toBeDefined()
    const up = fakeFetch([["models.dev", json({ ...CATALOG, xai: { models: {} } })]])
    const held = await loadCatalog({ directory: dir, fetchImpl: up, now: () => stale + CATALOG_RETRY - 1 })
    expect(held.xai.models["grok-9"]).toBeDefined()
    expect(up.calls.length).toBe(0)
    const fresh = await loadCatalog({ directory: dir, fetchImpl: up, now: () => stale + CATALOG_RETRY })
    expect(fresh.xai.models).toEqual({})
    expect(up.calls.length).toBe(1)
  })
})

describe("listModels", () => {
  const configs = (rows) => ["/provider_configs", json({ success: true, result: rows })]
  const row = (provider_slug, alias = "default") => ({ provider_slug, alias })

  test("lists the vendors with keys, live first and models.dev when live fails", async () => {
    const f = fakeFetch([
      configs([row("anthropic"), row("grok"), row("openai", "team")]),
      ["/anthropic/v1/models", json({ data: [{ id: "claude-x" }, { id: "claude-embed-1" }] })],
      ["/grok/v1/models", new Response("", { status: 500 })],
      ["models.dev", json(CATALOG)],
    ])
    const logs = []
    const models = await listModels({
      account: ACCOUNT,
      directory: dir,
      fetchImpl: f,
      log: (level, message) => logs.push([level, message]),
    })
    expect(Object.keys(models).sort()).toEqual(["anthropic/claude-x", "xai/grok-9"])
    expect(models["anthropic/claude-x"].name).toBe("Claude X (models.dev)")
    expect(models["xai/grok-9"].api.npm).toBe(NPM.chat)
    expect(logs.some(([level]) => level === "warn")).toBe(true)
    const list = f.calls.find((c) => c.url.includes("/anthropic/v1/models"))
    const headers = new Headers(list.init.headers)
    expect(headers.get("cf-aig-authorization")).toBe("Bearer tok")
    expect(headers.get("anthropic-version")).toBe("2023-06-01")
    expect(JSON.stringify(logs)).not.toContain("tok")
  })

  test("a refused token expires the sign-in", async () => {
    const f = fakeFetch([["/provider_configs", json({ success: false, errors: [{ code: 10000 }] }, 401)]])
    await expect(listModels({ account: ACCOUNT, directory: dir, fetchImpl: f })).rejects.toMatchObject({
      signIn: "expired",
    })
  })

  test("the expired sign-in says which token permissions to check, never the token", async () => {
    const f = fakeFetch([["/provider_configs", json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 401)]])
    const e = await listModels({ account: { ...ACCOUNT, token: "secret-token-value" }, directory: dir, fetchImpl: f }).catch((e) => e)
    expect(e.signIn).toBe("expired")
    expect(e.message).toContain("exists")
    expect(e.message).toContain("AI Gateway Run and Read")
    expect(e.message).not.toContain("secret-token-value")
  })

  test("a malformed token expires the sign-in, though Cloudflare answers 400", async () => {
    const f = fakeFetch([
      [
        "/provider_configs",
        json(
          {
            success: false,
            errors: [{ code: 9106, message: "Authentication failed (status: 400)" }],
            messages: [],
            result: null,
          },
          400,
        ),
      ],
    ])
    await expect(listModels({ account: ACCOUNT, directory: dir, fetchImpl: f })).rejects.toMatchObject({
      signIn: "expired",
    })
  })

  test("without permission to read keys, every vendor is tried", async () => {
    const f = fakeFetch([
      ["/provider_configs", json({ success: false, errors: [{ code: 10000 }] }, 403)],
      ["/openai/models", json({ data: [{ id: "gpt-x" }] })],
      ["models.dev", json(CATALOG)],
    ])
    const models = await listModels({ account: ACCOUNT, directory: dir, fetchImpl: f })
    expect(models["openai/gpt-x"]).toBeDefined()
    expect(models["google/gemini-x"]).toBeDefined()
    expect(models["xai/grok-9"]).toBeDefined()
  })

  test("list requests carry cf-aig-no-wholesale unless allowUnifiedBilling is on", async () => {
    const routes = () => [
      configs([row("anthropic")]),
      ["/anthropic/v1/models", json({ data: [{ id: "claude-x" }] })],
      ["models.dev", json(CATALOG)],
    ]
    const wholesale = (f) => new Headers(f.calls.find((c) => c.url.includes("/anthropic/v1/models")).init.headers).get("cf-aig-no-wholesale")
    const safe = fakeFetch(routes())
    await listModels({ account: ACCOUNT, directory: dir, fetchImpl: safe })
    expect(wholesale(safe)).toBe("true")
    const unified = fakeFetch(routes())
    await listModels({ account: { ...ACCOUNT, token: "tok2" }, directory: dir, fetchImpl: unified, settings: { allowUnifiedBilling: true } })
    expect(wholesale(unified)).toBeNull()
  })

  test("a vendor the gateway holds no key for (400, code 2044) is left out, not filled from models.dev", async () => {
    const gatewayError = (code) =>
      json({ success: false, result: [], messages: [], error: [{ code, message: "x" }], name: "AiGatewayError" }, 400)
    const f = fakeFetch([
      ["/provider_configs", json({ success: false, errors: [{ code: 10000 }] }, 403)],
      ["/grok/v1/models", gatewayError(2044)],
      ["/google-ai-studio/", gatewayError(2005)],
      ["models.dev", json(CATALOG)],
    ])
    const logs = []
    const models = await listModels({ account: ACCOUNT, directory: dir, fetchImpl: f, log: (level, message) => logs.push(message) })
    expect(models["xai/grok-9"]).toBeUndefined()
    expect(models["google/gemini-x"]).toBeDefined()
    expect(logs.some((m) => m.includes("xai"))).toBe(true)
  })

  test("models.dev fallback entries take their ids from the catalog's keys", async () => {
    const catalog = { ...CATALOG, xai: { models: { "grok-9": { name: "Grok 9" }, "grok-10": { id: "other", name: "Grok 10" } } } }
    const f = fakeFetch([configs([row("grok")]), ["/grok/v1/models", new Response("", { status: 500 })], ["models.dev", json(catalog)]])
    const models = await listModels({ account: ACCOUNT, directory: dir, fetchImpl: f })
    expect(Object.keys(models).sort()).toEqual(["xai/grok-10", "xai/grok-9"])
    expect(models["xai/grok-10"].name).toBe("Grok 10")
  })

  test("a dated snapshot takes its base model's models.dev metadata", async () => {
    const f = fakeFetch([
      configs([row("anthropic")]),
      ["/anthropic/v1/models", json({ data: [{ id: "claude-x-20250929", display_name: "Claude X 0929" }] })],
      ["models.dev", json(CATALOG)],
    ])
    const m = (await listModels({ account: ACCOUNT, directory: dir, fetchImpl: f }))["anthropic/claude-x-20250929"]
    expect(m.name).toBe("Claude X 0929")
    expect(m.limit).toEqual({ context: 200000, output: 64000 })
    expect(m.capabilities.reasoning).toBe(true)
    expect(m.cost.input).toBe(3)
  })

  test("a dated snapshot of a deprecated model is left out with it", async () => {
    const catalog = { ...CATALOG, openai: { models: { "o-old": { id: "o-old", name: "O Old", status: "deprecated" } } } }
    const f = fakeFetch([
      configs([row("openai")]),
      ["/openai/models", json({ data: [{ id: "o-old" }, { id: "o-old-2025-01-31" }, { id: "gpt-x-2025-01-31" }] })],
      ["models.dev", json(catalog)],
    ])
    const models = await listModels({ account: ACCOUNT, directory: dir, fetchImpl: f })
    expect(Object.keys(models)).toEqual(["openai/gpt-x-2025-01-31"])
  })

  test("xAI's grok-imagine models stay out though models.dev is down", async () => {
    const f = fakeFetch([
      configs([row("grok")]),
      ["/grok/v1/models", json({ data: [{ id: "grok-9" }, { id: "grok-imagine-video" }, { id: "grok-imagine-image" }] })],
      ["models.dev", new Response("", { status: 503 })],
    ])
    const models = await listModels({ account: ACCOUNT, directory: dir, fetchImpl: f })
    expect(Object.keys(models)).toEqual(["xai/grok-9"])
  })

  // REST takes only Cloudflare's catalog ids (spec 11.6), so they are its list
  describe("in REST mode", () => {
    const REST = { ...ACCOUNT, mode: "rest" }
    const everyKey = () => configs([row("openai"), row("anthropic"), row("google-ai-studio"), row("deepseek"), row("grok")])
    const CATALOG_IDS = [
      "anthropic/claude-haiku-4.5",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-sonnet-5.5",
      "openai/gpt-4.1-nano",
      "openai/gpt-5.5",
    ]

    test("lists the catalog's OpenAI and Anthropic ids, and asks no vendor for its list", async () => {
      const f = fakeFetch([everyKey(), cfPage(), ["models.dev", json(CATALOG)]])
      const models = await listModels({ account: REST, directory: dir, fetchImpl: f })
      expect(Object.keys(models).sort()).toEqual(CATALOG_IDS)
      expect(models["anthropic/claude-sonnet-5.5"].api).toEqual({ id: "anthropic/claude-sonnet-5.5", url: PLACEHOLDER, npm: NPM.messages })
      expect(models["openai/gpt-5.5"].api).toEqual({ id: "openai/gpt-5.5", url: PLACEHOLDER, npm: NPM.responses })
      expect(f.calls.some((c) => c.url.startsWith(GATEWAY))).toBe(false)
      expect(f.calls.map((c) => new URL(c.url).host).sort()).toEqual(["api.cloudflare.com", "developers.cloudflare.com", "models.dev"])
    })

    test("lists only the vendors whose default key the gateway holds", async () => {
      const f = fakeFetch([configs([row("anthropic"), row("openai", "team")]), cfPage(), ["models.dev", json(CATALOG)]])
      const models = await listModels({ account: REST, directory: dir, fetchImpl: f })
      expect(Object.keys(models).sort()).toEqual(CATALOG_IDS.filter((k) => k.startsWith("anthropic/")))
    })

    test("still leaves out what isTextModel and the vendor's list.skip drop", async () => {
      const catalog = { ...CATALOG, openai: { models: { "o-old": { name: "O Old", status: "deprecated" } } } }
      const page = ["gpt-x", "gpt-x-search-preview", "gpt-x-realtime", "o-old"].map((id) => cfEntry("openai", id)).join("")
      const f = fakeFetch([everyKey(), cfPage(page), ["models.dev", json(catalog)]])
      expect(Object.keys(await listModels({ account: REST, directory: dir, fetchImpl: f }))).toEqual(["openai/gpt-x"])
    })

    test("takes models.dev's cloudflare-ai-gateway entry first, then the vendor's by id, then with dots as dashes", async () => {
      const catalog = {
        ...CATALOG,
        "cloudflare-ai-gateway": {
          models: { "anthropic/claude-sonnet-5.5": { name: "Claude Sonnet 5.5 (gateway)", limit: { context: 1000000, output: 128000 } } },
        },
        anthropic: {
          models: {
            "claude-sonnet-5-5": { name: "Claude Sonnet 5.5 (anthropic)" },
            "claude-haiku-4-5": { name: "Claude Haiku 4.5", limit: { context: 200000, output: 64000 }, cost: { input: 1, output: 5 } },
          },
        },
        openai: { models: { "gpt-4.1-nano": { name: "GPT-4.1 nano" }, "gpt-4-1-nano": { name: "not this one" } } },
      }
      const f = fakeFetch([everyKey(), cfPage(), ["models.dev", json(catalog)]])
      const models = await listModels({ account: REST, directory: dir, fetchImpl: f })
      expect(models["anthropic/claude-sonnet-5.5"].name).toBe("Claude Sonnet 5.5 (gateway)")
      expect(models["anthropic/claude-sonnet-5.5"].limit).toEqual({ context: 1000000, output: 128000 })
      expect(models["openai/gpt-4.1-nano"].name).toBe("GPT-4.1 nano")
      expect(models["anthropic/claude-haiku-4.5"].name).toBe("Claude Haiku 4.5")
      expect(models["anthropic/claude-haiku-4.5"].limit).toEqual({ context: 200000, output: 64000 })
      expect(models["anthropic/claude-haiku-4.5"].cost.input).toBe(1)
      // found nowhere: the defaults
      expect(models["anthropic/claude-sonnet-5"].name).toBe("claude-sonnet-5")
      expect(models["anthropic/claude-sonnet-5"].limit).toEqual(DEFAULT_LIMIT)
    })

    test("falls back to models.dev's cloudflare-ai-gateway models, with a warn, when the catalog page fails or lists none", async () => {
      const catalog = {
        ...CATALOG,
        "cloudflare-ai-gateway": {
          models: {
            "anthropic/claude-sonnet-5.5": { name: "Claude Sonnet 5.5" },
            "openai/gpt-5.5": { name: "GPT-5.5" },
            "google/gemini-x": { name: "Gemini X" },
            "workers-ai/@cf/meta/llama-x": { name: "Llama X" },
          },
        },
      }
      for (const page of [cfPage("", 503), cfPage("# Models\n\nNo models found"), cfPage(cfEntry("openai", "tts-1", "Text-to-Speech"))]) {
        resetModelCache()
        const logs = []
        const f = fakeFetch([everyKey(), page, ["models.dev", json(catalog)]])
        const models = await listModels({ account: REST, directory: dir, fetchImpl: f, log: (level, message) => logs.push([level, message]) })
        expect(Object.keys(models).sort()).toEqual(["anthropic/claude-sonnet-5.5", "openai/gpt-5.5"])
        expect(models["openai/gpt-5.5"].name).toBe("GPT-5.5")
        expect(logs.some(([level, message]) => level === "warn" && message.includes("cloudflare-ai-gateway"))).toBe(true)
      }
    })

    test("doesn't warn of a fallback while the catalog page answers", async () => {
      const logs = []
      const f = fakeFetch([everyKey(), cfPage(), ["models.dev", json(CATALOG)]])
      await listModels({ account: REST, directory: dir, fetchImpl: f, log: (level, message) => logs.push([level, message]) })
      expect(logs).toEqual([])
    })
  })

  test("a gateway with no keys lists nothing", async () => {
    const f = fakeFetch([configs([]), ["models.dev", json(CATALOG)]])
    expect(await listModels({ account: ACCOUNT, directory: dir, fetchImpl: f })).toEqual({})
  })
})

// magpie's host asks provider.models before every request it sends (spec
// 11.4), so the list is kept in memory for LIST_TTL.
describe("listModels memo", () => {
  const routes = () =>
    fakeFetch([
      [
        "/provider_configs",
        json({ success: true, result: [{ provider_slug: "anthropic", alias: "default" }, { provider_slug: "anthropic", alias: "team" }] }),
      ],
      ["/anthropic/v1/models", json({ data: [{ id: "claude-x" }] })],
      ["models.dev", json(CATALOG)],
    ])
  const rounds = (f) => f.calls.filter((c) => c.url.includes("/provider_configs")).length

  test("two calls in a row send one round of requests", async () => {
    expect(LIST_TTL).toBe(10 * 60 * 1000)
    const f = routes()
    const first = await listModels({ account: ACCOUNT, directory: dir, fetchImpl: f })
    const sent = f.calls.length
    const second = await listModels({ account: ACCOUNT, directory: dir, fetchImpl: f })
    expect(second).toEqual(first)
    expect(f.calls.length).toBe(sent)
    expect(rounds(f)).toBe(1)
  })

  test("callers don't share the objects they're given", async () => {
    const f = routes()
    const first = await listModels({ account: ACCOUNT, directory: dir, fetchImpl: f })
    first["anthropic/claude-x"].name = "changed"
    const second = await listModels({ account: ACCOUNT, directory: dir, fetchImpl: f })
    expect(second["anthropic/claude-x"].name).toBe("Claude X (models.dev)")
  })

  test("concurrent calls share one request in flight", async () => {
    const f = routes()
    const [a, b] = await Promise.all([
      listModels({ account: ACCOUNT, directory: dir, fetchImpl: f }),
      listModels({ account: ACCOUNT, directory: dir, fetchImpl: f }),
    ])
    expect(a).toEqual(b)
    expect(rounds(f)).toBe(1)
    expect(f.calls.filter((c) => c.url.includes("/anthropic/v1/models")).length).toBe(1)
  })

  test("a different token, alias, mode or billing setting lists again", async () => {
    const f = routes()
    await listModels({ account: ACCOUNT, directory: dir, fetchImpl: f })
    await listModels({ account: { ...ACCOUNT, token: "tok2" }, directory: dir, fetchImpl: f })
    await listModels({ account: { ...ACCOUNT, alias: "team" }, directory: dir, fetchImpl: f })
    await listModels({ account: { ...ACCOUNT, mode: "rest" }, directory: dir, fetchImpl: f })
    await listModels({ account: ACCOUNT, directory: dir, fetchImpl: f, settings: { allowUnifiedBilling: true } })
    expect(rounds(f)).toBe(5)
  })

  test("a REST and a native listing of the same gateway are kept apart", async () => {
    const f = fakeFetch([
      ["/provider_configs", json({ success: true, result: [{ provider_slug: "anthropic", alias: "default" }] })],
      ["/anthropic/v1/models", json({ data: [{ id: "claude-x" }] })],
      cfPage(),
      ["models.dev", json(CATALOG)],
    ])
    const rest = { ...ACCOUNT, mode: "rest" }
    const native = await listModels({ account: ACCOUNT, directory: dir, fetchImpl: f })
    const listed = await listModels({ account: rest, directory: dir, fetchImpl: f })
    expect(Object.keys(native)).toEqual(["anthropic/claude-x"])
    expect(Object.keys(listed).sort()).toEqual(["anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-5", "anthropic/claude-sonnet-5.5"])
    expect(await listModels({ account: ACCOUNT, directory: dir, fetchImpl: f })).toEqual(native)
    expect(await listModels({ account: rest, directory: dir, fetchImpl: f })).toEqual(listed)
    expect(rounds(f)).toBe(2)
  })

  test("a failure is not kept", async () => {
    const f = fakeFetch([["/provider_configs", json({ success: false, errors: [{ code: 10000 }] }, 401)]])
    await expect(listModels({ account: ACCOUNT, directory: dir, fetchImpl: f })).rejects.toMatchObject({ signIn: "expired" })
    await expect(listModels({ account: ACCOUNT, directory: dir, fetchImpl: f })).rejects.toMatchObject({ signIn: "expired" })
    expect(rounds(f)).toBe(2)
  })

  test("an empty list is not kept", async () => {
    const f = fakeFetch([["/provider_configs", json({ success: true, result: [] })], ["models.dev", json(CATALOG)]])
    expect(await listModels({ account: ACCOUNT, directory: dir, fetchImpl: f })).toEqual({})
    expect(await listModels({ account: ACCOUNT, directory: dir, fetchImpl: f })).toEqual({})
    expect(rounds(f)).toBe(2)
  })

  test("lists again once LIST_TTL has passed", async () => {
    const f = routes()
    await listModels({ account: ACCOUNT, directory: dir, fetchImpl: f, now: () => 0 })
    await listModels({ account: ACCOUNT, directory: dir, fetchImpl: f, now: () => LIST_TTL - 1 })
    expect(rounds(f)).toBe(1)
    await listModels({ account: ACCOUNT, directory: dir, fetchImpl: f, now: () => LIST_TTL })
    expect(rounds(f)).toBe(2)
  })

  test("the memo key holds a hash of the token, never the token", () => {
    const account = { ...ACCOUNT, token: "secret-token-value" }
    const key = listKey(account, {})
    expect(key).not.toContain("secret-token-value")
    expect(key).not.toBe(listKey({ ...account, token: "other-token-value" }, {}))
    expect(key).toBe(listKey({ ...account }, {}))
  })
})
