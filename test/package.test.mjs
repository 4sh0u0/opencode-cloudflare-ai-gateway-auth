import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import pkg from "../package.json"

describe("package.json", () => {
  test("describes an OpenCode provider plugin that also runs in magpie, and keeps its keywords", () => {
    expect(pkg.description).toBe(
      "OpenCode provider plugin: Cloudflare AI Gateway with your own provider keys (BYOK). Also runs in magpie.",
    )
    expect(pkg.keywords).toEqual(["opencode", "opencode-plugin", "magpie", "cloudflare", "ai-gateway", "byok"])
  })

  // OpenCode refuses an npm plugin whose engines.opencode its version doesn't satisfy
  test("asks for OpenCode 1.18.35 or a later 1.x", () => {
    expect(pkg.engines).toEqual({ bun: ">=1.1.0", opencode: ">=1.18.35 <2" })
    expect(Bun.semver.satisfies("1.18.35", pkg.engines.opencode)).toBe(true)
    expect(Bun.semver.satisfies("1.19.0", pkg.engines.opencode)).toBe(true)
    expect(Bun.semver.satisfies("1.17.18", pkg.engines.opencode)).toBe(false)
    expect(Bun.semver.satisfies("2.0.24", pkg.engines.opencode)).toBe(false)
  })

  test("ships every module at the root", async () => {
    const modules = (await readdir(new URL("..", import.meta.url))).filter((f) => f.endsWith(".mjs"))
    expect(modules.filter((f) => !pkg.files.includes(f))).toEqual([])
  })
})
