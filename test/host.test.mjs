import { describe, expect, test } from "bun:test"
import { MAGPIE, OPENCODE, hostOf } from "../host.mjs"

const HOME = "/home/u"
const at = (env = {}) => ({ env, home: HOME })
const FELL_BACK = Symbol.for("magpie.fellBack")

describe("hostOf", () => {
  test("magpie is the app whose project is named magpie", () => {
    const host = hostOf({ project: { id: "magpie" }, directory: "/cfg/magpie" }, at())
    expect(host.name).toBe(MAGPIE)
    expect(host.cacheDir).toBe("/cfg/magpie")
    expect(host.variants).toBe(true)
  })

  test("anything else is OpenCode", () => {
    const inputs = [
      undefined,
      null,
      {},
      { project: {} },
      { project: { id: "global" } },
      { project: { id: "Magpie" } },
      { project: { id: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" }, directory: "/work/repo" },
    ]
    for (const input of inputs) expect([input, hostOf(input, at()).name]).toEqual([input, OPENCODE])
  })

  test("OpenCode caches under XDG_CACHE_HOME/opencode, never the project", () => {
    const host = hostOf({ project: { id: "abc" }, directory: "/work/repo" }, at({ XDG_CACHE_HOME: "/xdg/cache" }))
    expect(host.cacheDir).toBe("/xdg/cache/opencode")
    expect(host.variants).toBe(false)
  })

  test("OpenCode falls back to ~/.cache when XDG_CACHE_HOME is unset, empty or relative", () => {
    for (const XDG_CACHE_HOME of [undefined, "", "rel/cache"])
      expect([XDG_CACHE_HOME, hostOf({}, at({ XDG_CACHE_HOME })).cacheDir]).toEqual([XDG_CACHE_HOME, "/home/u/.cache/opencode"])
  })

  test("by default reads the process's environment and home folder", () => {
    expect(hostOf({}).cacheDir.endsWith("/opencode")).toBe(true)
  })
})

describe("what each host lists", () => {
  const given = { models: { "anthropic/claude-x": { id: "anthropic/claude-x" } } }
  const magpie = hostOf({ project: { id: "magpie" } }, at())
  const opencode = hostOf({}, at())
  const recorder = () => {
    const logs = []
    return { logs, log: (level, message) => logs.push([level, message]) }
  }

  test("magpie keeps its own list when signed out", () => {
    expect(magpie.signedOut(given)).toBe(given.models)
  })

  test("magpie keeps its list, marked as a fallback, when nothing is listed", () => {
    const out = magpie.empty(given, () => {})
    expect(Object.keys(out)).toEqual(["anthropic/claude-x"])
    expect(out[FELL_BACK]).toBe(true)
    expect(given.models[FELL_BACK]).toBeUndefined()
  })

  test("magpie passes a failure on, so a refused token asks for a new sign-in", () => {
    const { logs, log } = recorder()
    const error = Object.assign(new Error("refused"), { signIn: "expired" })
    expect(() => magpie.failed(error, log)).toThrow(error)
    expect(logs).toEqual([])
  })

  test("OpenCode lists nothing when signed out", () => {
    expect(opencode.signedOut(given)).toEqual({})
  })

  test("OpenCode lists nothing when nothing is listed, and says so", () => {
    const { logs, log } = recorder()
    expect(opencode.empty(given, log)).toEqual({})
    expect(logs).toHaveLength(1)
    expect(logs[0][0]).toBe("warn")
    expect(logs[0][1]).toStartWith("Nothing to list")
  })

  test("OpenCode logs a failure and lists nothing instead of throwing", () => {
    const { logs, log } = recorder()
    expect(opencode.failed(new Error("Cloudflare refused the API token"), log)).toEqual({})
    expect(opencode.failed("plain words", log)).toEqual({})
    expect(logs).toEqual([
      ["error", "Couldn't list the models: Cloudflare refused the API token"],
      ["error", "Couldn't list the models: plain words"],
    ])
  })
})
