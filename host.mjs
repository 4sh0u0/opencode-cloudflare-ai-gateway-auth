import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

// What the plugin does differently in each app that loads it. magpie names
// its project "magpie" (its plugin host's loadPlugins); anything else is
// taken for OpenCode, whose rules are also safe in magpie: there they only
// lose magpie's "sign in again" prompt and its reasoning levels.

export const MAGPIE = "magpie"
export const OPENCODE = "opencode"

const FELL_BACK = Symbol.for("magpie.fellBack")

const said = (e) => (e instanceof Error ? e.message : String(e))

// cacheHome is the folder for caches by the XDG rules OpenCode follows:
// XDG_CACHE_HOME when it is an absolute path, else ~/.cache.
function cacheHome(env, home) {
  const xdg = env?.XDG_CACHE_HOME
  return typeof xdg === "string" && isAbsolute(xdg) ? xdg : join(home, ".cache")
}

// hostOf is how the plugin behaves in the app that gave server() its input:
// - cacheDir: the folder cache.mjs keeps the catalogs under
// - variants: whether models carry reasoning variants. magpie reads only
//   their names; OpenCode makes its own for each AI SDK package when a
//   model has none
// - signedOut(provider): the models listed without an API sign-in
// - empty(provider, log): the models listed when the gateway serves none
// - failed(error, log): the models listed when listing threw. magpie reads a
//   thrown signIn: "expired" as "ask for a new sign-in"; OpenCode fails every
//   provider when this hook throws, so there the failure is logged instead.
export function hostOf(input, { env = process.env, home = homedir() } = {}) {
  if (input?.project?.id === MAGPIE)
    return {
      name: MAGPIE,
      cacheDir: input.directory,
      variants: true,
      signedOut: (provider) => provider?.models,
      empty(provider) {
        const kept = { ...provider?.models }
        kept[FELL_BACK] = true
        return kept
      },
      failed(error) {
        throw error
      },
    }
  return {
    name: OPENCODE,
    cacheDir: join(cacheHome(env, home), "opencode"),
    variants: false,
    signedOut: () => ({}),
    empty(_provider, log) {
      log("warn", "Nothing to list: the gateway holds no key this sign-in can use for a vendor the plugin serves")
      return {}
    },
    failed(error, log) {
      log("error", `Couldn't list the models: ${said(error)}`)
      return {}
    },
  }
}
