import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CACHE_TTL,
  DEFAULT_LIMIT,
  buildModel,
  isTextModel,
  listModels,
  loadCatalog,
  parseList,
} from "../models.mjs"
import { NPM, vendorByPrefix } from "../vendors.mjs"
import { fakeFetch, json } from "./fetch.mjs"

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
    expect(m.variants).toEqual({})
  })

  test("turns effort options into variants", () => {
    const m = buildModel(google, { id: "gemini-x" }, CATALOG.google.models["gemini-x"], "native")
    expect(m.variants).toEqual({ low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } })
  })

  test("declares the API by mode", () => {
    expect(buildModel(google, { id: "gemini-x" }, undefined, "native").api.npm).toBe(NPM.chat)
    expect(buildModel(google, { id: "gemini-x" }, undefined, "rest").api.npm).toBe(NPM.chat)
  })
})

describe("loadCatalog", () => {
  test("fetches models.dev once and keeps only the vendors' catalogs", async () => {
    const f = fakeFetch([["models.dev", json({ ...CATALOG, mistral: { models: { m: {} } } })]])
    const first = await loadCatalog({ directory: dir, fetchImpl: f, now: () => 1000 })
    expect(Object.keys(first).sort()).toEqual(["anthropic", "deepseek", "google", "openai", "xai"])
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

  test("a gateway with no keys lists nothing", async () => {
    const f = fakeFetch([configs([]), ["models.dev", json(CATALOG)]])
    expect(await listModels({ account: ACCOUNT, directory: dir, fetchImpl: f })).toEqual({})
  })
})
