import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CACHE_TTL, cached, resetCacheFailures } from "../cache.mjs"

let dir
beforeEach(async () => {
  resetCacheFailures()
  dir = await mkdtemp(join(tmpdir(), "cfaig-cache-"))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const isNumbers = (data) => Array.isArray(data) && data.length > 0
const read = (name) => readFile(join(dir, "cloudflare-ai-gateway-auth", name), "utf8")

describe("cached", () => {
  test("writes what refresh gives once it passes ok", async () => {
    const out = await cached("a.json", { directory: dir, now: () => 5, ok: isNumbers, refresh: async () => [1] })
    expect(out).toEqual([1])
    expect(JSON.parse(await read("a.json"))).toEqual({ fetchedAt: 5, data: [1] })
  })

  test("a refresh result that fails ok is a failure: not written, and the stale copy serves", async () => {
    await cached("a.json", { directory: dir, now: () => 0, ok: isNumbers, refresh: async () => [1] })
    const out = await cached("a.json", { directory: dir, now: () => CACHE_TTL * 2, ok: isNumbers, refresh: async () => [] })
    expect(out).toEqual([1])
    expect(JSON.parse(await read("a.json")).fetchedAt).toBe(0)
  })

  test("a refresh result that fails ok throws without a stale copy, and nothing is written", async () => {
    await expect(cached("b.json", { directory: dir, ok: isNumbers, refresh: async () => [] })).rejects.toThrow()
    await expect(read("b.json")).rejects.toThrow()
  })
})
