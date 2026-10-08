import { describe, expect, test } from "bun:test"
import { summarize } from "../scripts/listing.mjs"

// Shaped like `magpie plugin --json` (magpie 0.1.1110); the account fields
// hold made-up values that must not reach the summary.
const LISTING = {
  providers: [
    { id: "other", models: [{ id: "x/y", npm: "z" }] },
    {
      id: "cloudflare-ai-gateway",
      signedIn: true,
      accountId: "my-gateway · 01234567",
      accounts: [{ accountId: "my-gateway · 01234567", key: "my-gateway · 01234567", hint: "WXYZ", type: "api" }],
      models: [
        { id: "anthropic/claude-x", npm: "@ai-sdk/anthropic", url: "https://cloudflare-ai-gateway.invalid" },
        { id: "openai/gpt-x", npm: "@ai-sdk/openai" },
        { id: "openai/gpt-y", npm: "@ai-sdk/openai" },
        { id: "google/gemini-x", npm: "@ai-sdk/openai-compatible" },
      ],
    },
  ],
}

describe("summarize", () => {
  test("counts each vendor's models and AI SDK packages, and names its models", () => {
    expect(summarize(LISTING)).toEqual([
      "cloudflare-ai-gateway: signed in true, 4 models",
      "  anthropic: 1 models, npm @ai-sdk/anthropic",
      "    claude-x",
      "  google: 1 models, npm @ai-sdk/openai-compatible",
      "    gemini-x",
      "  openai: 2 models, npm @ai-sdk/openai",
      "    gpt-x gpt-y",
    ])
  })

  test("leaves out everything about the account", () => {
    const text = summarize(LISTING).join("\n")
    for (const secret of ["my-gateway", "01234567", "WXYZ"]) expect(text).not.toContain(secret)
  })

  test("says when the plugin isn't listed", () => {
    expect(summarize({ providers: [] })).toEqual(["cloudflare-ai-gateway: not listed"])
    expect(summarize(null)).toEqual(["cloudflare-ai-gateway: not listed"])
  })
})
