import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CACHE_TTL, CATALOG_RETRY, resetCacheFailures } from "../cache.mjs"
import { CF_CATALOG, loadCfCatalog, parseCfCatalog } from "../cfcatalog.mjs"
import { loadCatalog } from "../models.mjs"
import { fakeFetch } from "./fetch.mjs"

// A hand-written page in the catalog's Markdown shape
const PAGE = await readFile(new URL("./cf-catalog.md", import.meta.url), "utf8")
const TEXT_MODELS = [
  { author: "openai", id: "gpt-4.1-nano" },
  { author: "openai", id: "gpt-5.5" },
  { author: "anthropic", id: "claude-haiku-4.5" },
  { author: "anthropic", id: "claude-sonnet-5.5" },
  { author: "anthropic", id: "claude-sonnet-5" },
  { author: "deepseek", id: "deepseek-x" },
  { author: "google", id: "gemini-x" },
]

const page = (text = PAGE, status = 200) => [CF_CATALOG, new Response(text, { status })]
const down = () => fakeFetch([page("", 503)])

let dir
beforeEach(async () => {
  resetCacheFailures()
  dir = await mkdtemp(join(tmpdir(), "cf-aig-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("parseCfCatalog", () => {
  test("picks the Text Generation entries, with author and model from each link", () => {
    expect(parseCfCatalog(PAGE)).toEqual(TEXT_MODELS)
  })

  test("leaves out speech, image and transcription entries, and Workers AI's @cf models", () => {
    const ids = parseCfCatalog(PAGE).map((e) => e.id)
    for (const id of ["tts-1", "gpt-image-2", "gpt-4o-transcribe", "gpt-oss-120b", "openai"]) expect(ids).not.toContain(id)
  })

  test("returns [] for a page without Text Generation entries", () => {
    const tts = PAGE.slice(PAGE.indexOf("[![OpenAI logo](https://developers.cloudflare.com/_astro/openai.svg)<h3>tts-1"))
    for (const text of ["", "# Models\n\nNo models found", tts.slice(0, tts.indexOf("Compare")), null, undefined, 42])
      expect(parseCfCatalog(text)).toEqual([])
  })

  // the real page starts some entries with a logo cut down to a letter, or
  // with "Pinned" before it
  test("reads entries without a logo image", () => {
    const text = [
      "[a<h3>claude-x.1</h3>\n\nanthropicText Generation A model.](https://developers.cloudflare.com/ai/models/anthropic/claude-x.1/)\n\nCompare\n",
      "[Pinned![OpenAI logo](https://developers.cloudflare.com/_astro/openai.svg)<h3>gpt-x</h3>\n\nOpenAIText Generation A model.](https://developers.cloudflare.com/ai/models/openai/gpt-x/)\n\nCompare\n",
      "[o<h3>tts-x</h3>\n\nopenaiText-to-Speech A voice.](https://developers.cloudflare.com/ai/models/openai/tts-x/)\n",
    ].join("\n")
    expect(parseCfCatalog(text)).toEqual([
      { author: "anthropic", id: "claude-x.1" },
      { author: "openai", id: "gpt-x" },
    ])
  })

  test("tolerates extra whitespace and line breaks inside an entry", () => {
    const text = [
      "[![Anthropic logo](https://developers.cloudflare.com/_astro/anthropic.svg)",
      "  <h3>claude-sonnet-5.5</h3>",
      "",
      "",
      "Anthropic  Text",
      "   Generation  A model for",
      "coding.",
      "](https://developers.cloudflare.com/ai/models/anthropic/claude-sonnet-5.5)",
    ].join("\n")
    expect(parseCfCatalog(text)).toEqual([{ author: "anthropic", id: "claude-sonnet-5.5" }])
  })
})

describe("loadCfCatalog", () => {
  const file = () => join(dir, "cloudflare-ai-gateway-auth", "cf-catalog.json")

  test("fetches the catalog page once and keeps its text models for CACHE_TTL", async () => {
    const f = fakeFetch([page()])
    const first = await loadCfCatalog({ directory: dir, fetchImpl: f, now: () => 1000 })
    expect(first).toEqual(TEXT_MODELS)
    const second = await loadCfCatalog({ directory: dir, fetchImpl: f, now: () => 1000 + CACHE_TTL - 1 })
    expect(second).toEqual(first)
    expect(f.calls.map((c) => c.url)).toEqual(["https://developers.cloudflare.com/ai/models/index.md"])
    const saved = JSON.parse(await readFile(file(), "utf8"))
    expect(saved).toEqual({ fetchedAt: 1000, data: TEXT_MODELS })
  })

  test("asks again once CACHE_TTL has passed", async () => {
    const f = fakeFetch([page()])
    await loadCfCatalog({ directory: dir, fetchImpl: f, now: () => 0 })
    await loadCfCatalog({ directory: dir, fetchImpl: f, now: () => CACHE_TTL })
    expect(f.calls.length).toBe(2)
  })

  test("falls back to a stale cache when the page is down", async () => {
    await loadCfCatalog({ directory: dir, fetchImpl: fakeFetch([page()]), now: () => 0 })
    expect(await loadCfCatalog({ directory: dir, fetchImpl: down(), now: () => CACHE_TTL * 2 })).toEqual(TEXT_MODELS)
  })

  test("throws with neither the page nor a cache", async () => {
    await expect(loadCfCatalog({ directory: dir, fetchImpl: down(), now: () => 0 })).rejects.toThrow("503")
  })

  test("a page without Text Generation entries fails like a page that is down", async () => {
    const empty = () => fakeFetch([page("# Models\n\nNo models found")])
    await expect(loadCfCatalog({ directory: dir, fetchImpl: empty(), now: () => 0 })).rejects.toThrow("no text generation")
    resetCacheFailures()
    await loadCfCatalog({ directory: dir, fetchImpl: fakeFetch([page()]), now: () => 0 })
    expect(await loadCfCatalog({ directory: dir, fetchImpl: empty(), now: () => CACHE_TTL * 2 })).toEqual(TEXT_MODELS)
    expect(JSON.parse(await readFile(file(), "utf8")).data).toEqual(TEXT_MODELS)
  })

  test("ignores a corrupt or misshapen cache file and asks for the page", async () => {
    await mkdir(join(dir, "cloudflare-ai-gateway-auth"), { recursive: true })
    const corrupt = [
      "not json",
      JSON.stringify(null),
      JSON.stringify({ fetchedAt: 0, data: "oops" }),
      JSON.stringify({ fetchedAt: 0, data: {} }),
      JSON.stringify({ fetchedAt: 0, data: [] }),
      JSON.stringify({ fetchedAt: 0, data: [null] }),
      JSON.stringify({ fetchedAt: 0, data: [{ author: "openai" }] }),
      JSON.stringify({ fetchedAt: 0, data: [{ author: "openai", id: 5 }] }),
      JSON.stringify({ fetchedAt: 0, data: [{ author: "", id: "gpt-5.5" }] }),
    ]
    for (const text of corrupt) {
      resetCacheFailures()
      await writeFile(file(), text)
      const f = fakeFetch([page()])
      const out = await loadCfCatalog({ directory: dir, fetchImpl: f, now: () => 1 })
      expect([text, f.calls.length]).toEqual([text, 1])
      expect(out).toEqual(TEXT_MODELS)
    }
  })

  test("doesn't serve a corrupt cache file while the page is down", async () => {
    await mkdir(join(dir, "cloudflare-ai-gateway-auth"), { recursive: true })
    await writeFile(file(), JSON.stringify({ fetchedAt: 0, data: "oops" }))
    await expect(loadCfCatalog({ directory: dir, fetchImpl: down(), now: () => CACHE_TTL * 2 })).rejects.toThrow("503")
  })

  test("after a failure, doesn't ask for the page again for CATALOG_RETRY", async () => {
    const f = down()
    await expect(loadCfCatalog({ directory: dir, fetchImpl: f, now: () => 0 })).rejects.toThrow("503")
    await expect(loadCfCatalog({ directory: dir, fetchImpl: f, now: () => CATALOG_RETRY - 1 })).rejects.toThrow("503")
    expect(f.calls.length).toBe(1)
    const up = fakeFetch([page()])
    expect(await loadCfCatalog({ directory: dir, fetchImpl: up, now: () => CATALOG_RETRY })).toEqual(TEXT_MODELS)
    expect(up.calls.length).toBe(1)
  })

  test("after a failed refresh, serves the stale cache without asking again for CATALOG_RETRY", async () => {
    await loadCfCatalog({ directory: dir, fetchImpl: fakeFetch([page()]), now: () => 0 })
    const stale = CACHE_TTL * 2
    expect(await loadCfCatalog({ directory: dir, fetchImpl: down(), now: () => stale })).toEqual(TEXT_MODELS)
    const one = PAGE.slice(PAGE.indexOf("[![OpenAI logo](https://developers.cloudflare.com/_astro/openai.svg)<h3>gpt-5.5"))
    const up = fakeFetch([page(one)])
    expect(await loadCfCatalog({ directory: dir, fetchImpl: up, now: () => stale + CATALOG_RETRY - 1 })).toEqual(TEXT_MODELS)
    expect(up.calls.length).toBe(0)
    const fresh = await loadCfCatalog({ directory: dir, fetchImpl: up, now: () => stale + CATALOG_RETRY })
    expect(fresh).toEqual(TEXT_MODELS.slice(1))
    expect(up.calls.length).toBe(1)
  })

  test("a models.dev failure doesn't hold off the catalog page, nor the other way round", async () => {
    const f = fakeFetch([page("", 503), ["models.dev", new Response("", { status: 503 })]])
    await expect(loadCatalog({ directory: dir, fetchImpl: f, now: () => 0 })).rejects.toThrow("503")
    await expect(loadCfCatalog({ directory: dir, fetchImpl: f, now: () => 1 })).rejects.toThrow("503")
    expect(f.calls.length).toBe(2)
  })
})
