import { annotate, localError } from "./errors.mjs"
import { listModels } from "./models.mjs"
import { PLACEHOLDER, RouteError, route } from "./route.mjs"
import { NPM, PROVIDER } from "./vendors.mjs"

const ACCOUNT_RE = /^[0-9a-f]{32}$/
// Cloudflare's own pattern for a gateway id
const GATEWAY_RE = /^[a-z0-9_]+(?:-[a-z0-9_]+)*$/
const ALIAS_RE = /^[A-Za-z0-9_-]{1,64}$/
const ACCOUNT_HINT = "The account ID is 32 hexadecimal characters (Cloudflare dashboard → Account home)."
const GATEWAY_HINT = "The gateway ID is the gateway's name in AI Gateway, such as my-gateway."
const ALIAS_HINT = "The key alias is up to 64 letters, digits, - or _; leave it empty for default."

const accountOk = (v) => ACCOUNT_RE.test(String(v ?? "").trim().toLowerCase())
const gatewayOk = (v) => {
  const s = String(v ?? "").trim()
  return s.length <= 64 && GATEWAY_RE.test(s)
}
// empty is the default key; the alias goes out as a header
const aliasOk = (v) => {
  const s = String(v ?? "").trim()
  return s === "" || ALIAS_RE.test(s)
}

const PROMPTS = [
  {
    type: "text",
    key: "account",
    message: "Cloudflare account ID",
    placeholder: "32 hexadecimal characters",
    validate: (v) => (accountOk(v) ? undefined : ACCOUNT_HINT),
  },
  {
    type: "text",
    key: "gateway",
    message: "AI Gateway ID",
    placeholder: "my-gateway",
    validate: (v) => (gatewayOk(v) ? undefined : GATEWAY_HINT),
  },
  {
    type: "select",
    key: "mode",
    message: "Upstream endpoint",
    options: [
      { label: "Native provider endpoints (recommended)", value: "native", hint: "gateway.ai.cloudflare.com, each vendor's own API" },
      { label: "Cloudflare REST API", value: "rest", hint: "api.cloudflare.com/…/ai/v1" },
    ],
  },
  {
    type: "text",
    key: "alias",
    message: "BYOK key alias (empty for default)",
    placeholder: "default",
    when: { key: "mode", op: "eq", value: "native" },
    validate: (v) => (aliasOk(v) ? undefined : ALIAS_HINT),
  },
]

function normalize(inputs = {}) {
  const mode = inputs?.mode === "rest" ? "rest" : "native"
  let alias = mode === "native" ? String(inputs?.alias ?? "").trim() : ""
  if (alias === "default") alias = ""
  return {
    account: String(inputs?.account ?? "").trim().toLowerCase(),
    gateway: String(inputs?.gateway ?? "").trim(),
    mode,
    alias,
  }
}

// signIn checks the answers. magpie keeps the key the user typed itself
// (authorize isn't given it), so the token is first tried by the model list.
function signIn(inputs) {
  const md = normalize(inputs)
  if (!accountOk(md.account)) return { type: "failed", error: ACCOUNT_HINT }
  if (!gatewayOk(md.gateway)) return { type: "failed", error: GATEWAY_HINT }
  if (!aliasOk(md.alias)) return { type: "failed", error: ALIAS_HINT }
  return { type: "success", metadata: { ...md, email: labelOf(md) } }
}

// labelOf names the account. magpie names an API-key account by
// metadata.email and replaces an account of the same name on sign-in, so it
// holds everything that tells two sign-ins apart: gateway, alias and mode.
function labelOf({ gateway, account, alias, mode }) {
  return `${gateway}${alias ? `/${alias}` : ""} · ${account.slice(0, 8)}${mode === "rest" ? " · REST" : ""}`
}

const expired = (message) => Object.assign(new Error(message), { signIn: "expired" })

function accountOf(auth) {
  if (auth?.type !== "api" || !auth.key) throw expired("Sign in with a Cloudflare API token")
  const md = normalize(auth.metadata)
  if (!accountOk(md.account) || !gatewayOk(md.gateway) || !aliasOk(md.alias))
    throw expired("This sign-in has no valid account, gateway or key alias; sign in again")
  return { token: auth.key, ...md }
}

async function send(input, init, account, settings, fetchImpl = fetch) {
  let routed
  try {
    routed = route(String(input), init ?? {}, account, settings)
  } catch (e) {
    if (e instanceof RouteError) return localError(e.protocol, 400, e.message)
    throw e
  }
  return annotate(await fetchImpl(routed.url, routed.init), account.mode)
}

async function server(input = {}, options = {}) {
  const settings = { allowUnifiedBilling: options?.allowUnifiedBilling === true }
  const log = (level, message) => {
    try {
      input?.client?.app?.log?.({ body: { service: PROVIDER, level, message } })?.catch?.(() => {})
    } catch {}
  }
  return {
    async config(cfg) {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= { name: "Cloudflare AI Gateway (BYOK)", npm: NPM.chat, api: PLACEHOLDER, models: {} }
    },
    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: "api",
          label: "Cloudflare API token",
          placeholder: "Token with AI Gateway Run and Read",
          prompts: PROMPTS,
          async authorize(inputs) {
            return signIn(inputs)
          },
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api") return {}
        return {
          baseURL: PLACEHOLDER,
          async fetch(request, init) {
            return send(request, init, accountOf(await getAuth()), settings)
          },
        }
      },
    },
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (auth?.type !== "api") return provider.models
        const models = await listModels({ account: accountOf(auth), directory: input?.directory, log, settings })
        if (Object.keys(models).length) return models
        const kept = { ...provider.models }
        kept[Symbol.for("magpie.fellBack")] = true
        return kept
      },
    },
  }
}

export default { id: PROVIDER, server }

// For the tests; magpie calls only the default export's server.
export const _internal = { PROMPTS, normalize, signIn, accountOf, send }
