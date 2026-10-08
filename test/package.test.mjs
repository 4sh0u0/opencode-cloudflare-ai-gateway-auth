import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import pkg from "../package.json"

describe("package.json", () => {
  test("describes a magpie provider plugin and keeps its keywords", () => {
    expect(pkg.description).toBe("magpie provider plugin: Cloudflare AI Gateway with your own provider keys (BYOK)")
    expect(pkg.keywords).toEqual(["opencode", "opencode-plugin", "magpie", "cloudflare", "ai-gateway", "byok"])
  })

  test("ships every module at the root", async () => {
    const modules = (await readdir(new URL("..", import.meta.url))).filter((f) => f.endsWith(".mjs"))
    expect(modules.filter((f) => !pkg.files.includes(f))).toEqual([])
  })
})
