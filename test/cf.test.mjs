import { describe, expect, test } from "bun:test"
import { CfError, byokSlugs, cfGet } from "../cf.mjs"
import { fakeFetch, json } from "./fetch.mjs"

const ACCOUNT = { account: "0123456789abcdef0123456789abcdef", gateway: "my-gateway", alias: "", token: "tok" }
const row = (provider_slug, alias = "default") => ({ provider_slug, alias })

describe("cfGet", () => {
  test("sends the token and returns the envelope", async () => {
    const f = fakeFetch([["/x", json({ success: true, result: [1] })]])
    const out = await cfGet("/x", "tok", { fetchImpl: f })
    expect(out.result).toEqual([1])
    expect(f.calls[0].url).toBe("https://api.cloudflare.com/client/v4/x")
    expect(new Headers(f.calls[0].init.headers).get("authorization")).toBe("Bearer tok")
  })

  test("throws CfError with the status and codes", async () => {
    const f = fakeFetch([["/x", json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 403)]])
    try {
      await cfGet("/x", "tok", { fetchImpl: f })
      throw new Error("expected CfError")
    } catch (e) {
      expect(e).toBeInstanceOf(CfError)
      expect(e.status).toBe(403)
      expect(e.codes).toEqual([10000])
      expect(e.message).not.toContain("tok")
    }
  })

  test("throws CfError on a non-JSON answer", async () => {
    const f = fakeFetch([["/x", new Response("<html>", { status: 502 })]])
    await expect(cfGet("/x", "tok", { fetchImpl: f })).rejects.toBeInstanceOf(CfError)
  })

  test("throws CfError when a 200 says success: false", async () => {
    const f = fakeFetch([["/x", json({ success: false, errors: [] })]])
    await expect(cfGet("/x", "tok", { fetchImpl: f })).rejects.toBeInstanceOf(CfError)
  })
})

describe("byokSlugs", () => {
  test("keeps slugs whose alias matches the account's (empty = default)", async () => {
    const f = fakeFetch([
      ["/provider_configs", json({ success: true, result: [row("openai"), row("anthropic", "team"), row("grok")] })],
    ])
    expect([...(await byokSlugs(ACCOUNT, { fetchImpl: f }))].sort()).toEqual(["grok", "openai"])
    expect([...(await byokSlugs({ ...ACCOUNT, alias: "team" }, { fetchImpl: f }))]).toEqual(["anthropic"])
  })

  test("reads every page", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => row(`p${i}`))
    const f = fakeFetch([
      ["page=1&", json({ success: true, result: page1 })],
      ["page=2&", json({ success: true, result: [row("openai")] })],
    ])
    const slugs = await byokSlugs(ACCOUNT, { fetchImpl: f })
    expect(slugs.size).toBe(51)
    expect(f.calls.length).toBe(2)
  })

  test("passes a 401 on as CfError", async () => {
    const f = fakeFetch([["/provider_configs", json({ success: false, errors: [{ code: 10000 }] }, 401)]])
    await expect(byokSlugs(ACCOUNT, { fetchImpl: f })).rejects.toMatchObject({ status: 401 })
  })
})
