import { describe, expect, test } from "bun:test"
import pkg from "../package.json"

describe("package.json", () => {
  test("describes a magpie provider plugin and keeps its keywords", () => {
    expect(pkg.description).toBe("magpie provider plugin: Cloudflare AI Gateway with your own provider keys (BYOK)")
    expect(pkg.keywords).toEqual(["opencode", "opencode-plugin", "magpie", "cloudflare", "ai-gateway", "byok"])
  })
})
