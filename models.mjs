import { createHash } from "node:crypto"
import { cached, resetCacheFailures } from "./cache.mjs"
import { byokSlugs, tokenRefused } from "./cf.mjs"
import { loadCfCatalog } from "./cfcatalog.mjs"
import { NO_STORED_KEY, errorCodes } from "./errors.mjs"
import { GATEWAY, PLACEHOLDER } from "./route.mjs"
import { NPM, PROVIDER, VENDORS, protocolFor, splitModel } from "./vendors.mjs"

export { CACHE_TTL, CATALOG_RETRY } from "./cache.mjs"
export const MODELS_DEV = "https://models.dev/api.json"
// how long an account's model list is kept in memory
export const LIST_TTL = 10 * 60 * 1000
export const DEFAULT_LIMIT = { context: 128000, output: 16384 }

// Kept in this process only, never on disk: the lists by listKey, each
// {promise, expires} (expires is 0 while the list is being made).
const lists = new Map()

// resetModelCache forgets the kept lists and the catalogs' last failures.
export function resetModelCache() {
  lists.clear()
  resetCacheFailures()
}

// Words in the ids of models that don't chat, after magpie's own textModel.
// A substring heuristic shared by every vendor: it can miss a model, or catch
// one whose id merely holds a word. Each vendor's list.skip (vendors.mjs)
// names its own exceptions.
const NOT_TEXT = [
  "embed",
  "tts",
  "image",
  "audio",
  "-live",
  "realtime",
  "moderation",
  "whisper",
  "dall-e",
  "sora",
  "transcribe",
  "computer-use",
  "deep-research",
]
const MODALITIES = ["text", "image", "audio", "video", "pdf"]

// parseList reads a vendor's own model list, as the gateway passes it on.
export function parseList(format, body) {
  if (format === "gemini") {
    const models = Array.isArray(body?.models) ? body.models : []
    return models
      .filter((m) => Array.isArray(m?.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent"))
      .map((m) => ({
        id: String(m.name ?? "").replace(/^models\//, ""),
        name: m.displayName,
        limit: { context: m.inputTokenLimit, output: m.outputTokenLimit },
      }))
      .filter((m) => m.id)
  }
  const data = Array.isArray(body?.data) ? body.data : []
  return data.filter((m) => typeof m?.id === "string" && m.id).map((m) => ({ id: m.id, name: m.display_name }))
}

// isTextModel is whether a vendor's model chats: not deprecated, answering
// in text, and not matched by NOT_TEXT or the vendor's list.skip.
export function isTextModel(id, meta, vendor) {
  if (vendor?.list?.skip?.test(id)) return false
  if (meta?.status === "deprecated") return false
  const output = meta?.modalities?.output
  if (Array.isArray(output) && !output.includes("text")) return false
  const lower = id.toLowerCase()
  return !NOT_TEXT.some((word) => lower.includes(word))
}

const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x)

// models.dev's provider for AI Gateway: Cloudflare's catalog, keyed by REST
// id ("anthropic/claude-sonnet-5.5")
const AI_GATEWAY = "cloudflare-ai-gateway"
// the models.dev providers loadCatalog keeps
const KEPT = [...VENDORS.map((v) => v.catalog), AI_GATEWAY]

// catalogOk is whether data has the shape loadCatalog keeps: every kept
// catalog with an object of models.
const catalogOk = (data) => isObject(data) && KEPT.every((c) => isObject(data[c]?.models))

// loadCatalog is the vendors' models.dev catalogs and AI Gateway's, kept for
// CACHE_TTL in the host's cache folder (host.mjs); a stale copy serves while
// models.dev is down. After a failed refresh it doesn't ask models.dev again
// for CATALOG_RETRY.
export async function loadCatalog({ directory, fetchImpl = fetch, now = Date.now } = {}) {
  return cached("models-dev.json", {
    directory,
    now,
    ok: catalogOk,
    async refresh() {
      const res = await fetchImpl(MODELS_DEV, { signal: AbortSignal.timeout(15000) })
      if (!res.ok) throw new Error(`models.dev answered ${res.status}`)
      const all = await res.json()
      const kept = Object.fromEntries(
        KEPT.map((c) => {
          const models = all?.[c]?.models
          return [c, { models: isObject(models) ? models : {} }]
        }),
      )
      // as after a change of shape: zero models everywhere is a failure, so
      // it never replaces a good stale copy
      if (Object.values(kept).every((c) => Object.keys(c.models).length === 0)) throw new Error("models.dev lists no models")
      return kept
    },
  })
}

function flags(list) {
  return Object.fromEntries(MODALITIES.map((k) => [k, list.includes(k)]))
}

function variantsOf(meta) {
  if (!meta?.reasoning) return {}
  const effort = (meta.reasoning_options ?? []).find((o) => o?.type === "effort")
  if (effort?.values?.length) return Object.fromEntries(effort.values.map((v) => [v, { reasoningEffort: v }]))
  return { low: {}, medium: {}, high: {} }
}

// A snapshot's date at the end of its id: -YYYY-MM-DD or -YYYYMMDD.
const DATED = /-(?:\d{4}-\d{2}-\d{2}|\d{8})$/

// metaFor is a model's models.dev metadata: its own, or else its base
// model's for a dated snapshot, without the base's name so the snapshot
// keeps a name of its own.
export function metaFor(metas, id) {
  if (Object.hasOwn(metas, id)) return metas[id]
  const base = id.replace(DATED, "")
  return base !== id && Object.hasOwn(metas, base) ? { ...metas[base], name: undefined } : undefined
}

// restMetaFor is the models.dev metadata of a catalog id REST mode lists:
// AI Gateway's entry for it, or else the vendor's own by the id, by the id
// with dots as dashes (Anthropic's claude-sonnet-5.5 is claude-sonnet-5-5),
// or by a dated snapshot's base (metaFor).
export function restMetaFor(catalog, vendor, id) {
  const gateway = catalog?.[AI_GATEWAY]?.models ?? {}
  const rest = `${vendor.restPrefix}/${id}`
  if (Object.hasOwn(gateway, rest)) return gateway[rest]
  const metas = catalog?.[vendor.catalog]?.models ?? {}
  const dashed = id.replaceAll(".", "-")
  for (const own of [id, dashed]) if (Object.hasOwn(metas, own)) return metas[own]
  return metaFor(metas, id) ?? metaFor(metas, dashed)
}

// buildModel is the OpenCode Model listed for one vendor model: each field
// from models.dev first, then the vendor's live list, then defaults. With
// variants false it has no variants field, and OpenCode makes its own.
export function buildModel(vendor, entry, meta, mode, { variants = true } = {}) {
  const key = `${vendor.prefix}/${entry.id}`
  const input = meta?.modalities?.input ?? ["text"]
  const output = meta?.modalities?.output ?? ["text"]
  const limit = { ...DEFAULT_LIMIT }
  for (const source of [entry.limit, meta?.limit])
    for (const k of ["context", "output"]) if (Number(source?.[k]) > 0) limit[k] = Number(source[k])
  return {
    id: key,
    providerID: PROVIDER,
    name: meta?.name ?? entry.name ?? entry.id,
    api: { id: key, url: PLACEHOLDER, npm: NPM[protocolFor(vendor, mode)] },
    limit,
    capabilities: {
      // magpie's own default; reasoning models refuse temperature
      temperature: meta?.temperature ?? false,
      reasoning: meta?.reasoning ?? false,
      attachment: meta?.attachment ?? input.some((k) => k !== "text"),
      toolcall: meta?.tool_call ?? true,
      input: flags(input),
      output: flags(output),
      interleaved: meta?.interleaved ?? false,
    },
    cost: {
      input: meta?.cost?.input ?? 0,
      output: meta?.cost?.output ?? 0,
      cache: { read: meta?.cost?.cache_read ?? 0, write: meta?.cost?.cache_write ?? 0 },
    },
    ...(variants ? { variants: variantsOf(meta) } : {}),
    options: {},
    headers: {},
    status: meta?.status ?? "active",
    release_date: meta?.release_date ?? "",
  }
}

// liveList asks the vendor for its models through the gateway, with the
// stored key and the headers an inference request carries. null when the
// vendor's list doesn't pass through (probe V2). It throws an error with
// noKey set when the gateway holds no key for the vendor under the alias.
export async function liveList(vendor, account, { fetchImpl = fetch, settings = {} } = {}) {
  if (!vendor.list) return null
  const headers = { ...vendor.list.headers, "cf-aig-authorization": `Bearer ${account.token}`, accept: "application/json" }
  if (account.alias) headers["cf-aig-byok-alias"] = account.alias
  if (settings.allowUnifiedBilling !== true) headers["cf-aig-no-wholesale"] = "true"
  const res = await fetchImpl(`${GATEWAY}/${account.account}/${account.gateway}/${vendor.slug}${vendor.list.path}`, {
    headers,
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) {
    let codes = []
    if (res.status === 400) codes = errorCodes(await res.text().catch(() => ""))
    else await res.body?.cancel()
    if (codes.includes(NO_STORED_KEY))
      throw Object.assign(new Error(`The gateway holds no ${vendor.prefix} key for this alias`), { noKey: true })
    throw new Error(`${vendor.prefix}'s model list answered ${res.status}`)
  }
  return parseList(vendor.list.format, await res.json())
}

// listKey is what an account's list is kept under: everything the list
// depends on, with the token hashed so the key never holds it.
export function listKey(account, settings = {}, variants = true) {
  const token = createHash("sha256").update(String(account.token)).digest("hex")
  return JSON.stringify([
    token,
    account.account,
    account.gateway,
    account.mode,
    account.alias,
    settings.allowUnifiedBilling === true,
    variants !== false,
  ])
}

// listModels is the account's models, kept for LIST_TTL: magpie's host asks
// for them before every request it sends, OpenCode once per instance. Calls
// that come while a list is being made share it. A failure or an empty list
// isn't kept, so the next call tries again. Each caller gets its own copy.
export async function listModels(options) {
  const { account, settings = {}, now = Date.now, variants = true } = options
  const key = listKey(account, settings, variants)
  const kept = lists.get(key)
  if (kept && (kept.expires === 0 || now() < kept.expires)) return structuredClone(await kept.promise)
  for (const [k, e] of lists) if (e.expires && now() >= e.expires) lists.delete(k)
  const entry = { promise: collectModels({ ...options, settings, variants }), expires: 0 }
  lists.set(key, entry)
  const forget = () => lists.get(key) === entry && lists.delete(key)
  let models
  try {
    models = await entry.promise
  } catch (e) {
    forget()
    throw e
  }
  if (Object.keys(models).length) entry.expires = now() + LIST_TTL
  else forget()
  return structuredClone(models)
}

// restModels is a REST account's list. REST takes only the ids in
// Cloudflare's model catalog (spec 11.6), so each vendor's catalog models are
// its list, and no vendor is asked for its own. models.dev's
// cloudflare-ai-gateway models stand in while the catalog can't be read.
async function restModels(vendors, catalogLoad, { directory, fetchImpl, log, variants }) {
  const [catalog, read] = await Promise.all([
    catalogLoad,
    loadCfCatalog({ directory, fetchImpl }).catch((e) => {
      log("warn", `Cloudflare's model catalog is unavailable (${e.message}); using models.dev's ${AI_GATEWAY} models`)
      return null
    }),
  ])
  const entries =
    read ??
    Object.keys(catalog?.[AI_GATEWAY]?.models ?? {})
      .map(splitModel)
      .filter(Boolean)
      .map((k) => ({ author: k.prefix, id: k.nativeId }))
  const models = {}
  for (const vendor of vendors)
    for (const { author, id } of entries) {
      if (author !== vendor.restPrefix) continue
      const meta = restMetaFor(catalog, vendor, id)
      if (!isTextModel(id, meta, vendor)) continue
      const model = buildModel(vendor, { id }, meta, "rest", { variants })
      models[model.id] = model
    }
  return models
}

// collectModels makes the account's list: the vendors its gateway holds keys
// for, each listed live or else from models.dev, or in REST mode from
// Cloudflare's catalog (restModels). settings are the plugin's options
// ({allowUnifiedBilling}); without them lists never fall back to Unified
// Billing.
async function collectModels({ account, directory, fetchImpl = fetch, log = () => {}, settings = {}, variants = true }) {
  let slugs = null
  try {
    slugs = await byokSlugs(account, { fetchImpl })
  } catch (e) {
    if (tokenRefused(e))
      throw Object.assign(
        new Error(
          `Cloudflare refused the API token (${e.message}). Check that the token exists and has AI Gateway Run and Read, then sign in again`,
        ),
        { signIn: "expired" },
      )
    log("warn", `Couldn't read the gateway's stored keys, so every vendor is listed: ${e.message}`)
  }
  // a vendor the account's mode can't reach (rest: null after the probe) is left out
  const vendors = VENDORS.filter((v) => (!slugs || slugs.has(v.slug)) && protocolFor(v, account.mode))
  const catalogLoad = loadCatalog({ directory, fetchImpl }).catch((e) => {
    log("warn", `models.dev is unavailable: ${e.message}`)
    return null
  })
  if (account.mode === "rest") return restModels(vendors, catalogLoad, { directory, fetchImpl, log, variants })
  const [catalog, ...lives] = await Promise.all([
    catalogLoad,
    ...vendors.map((v) =>
      liveList(v, account, { fetchImpl, settings }).catch((e) => {
        // no key, nothing to call: an empty list leaves the vendor out
        if (e.noKey) {
          log("info", `${e.message}, so ${v.prefix} is left out`)
          return []
        }
        log("warn", `${e.message}; using models.dev for ${v.prefix}`)
        return null
      }),
    ),
  ])
  const models = {}
  vendors.forEach((vendor, i) => {
    const metas = catalog?.[vendor.catalog]?.models ?? {}
    // models.dev's ids are its keys; an entry's own id field may be missing
    const entries = lives[i] ?? Object.entries(metas).map(([id, m]) => ({ id, name: m?.name }))
    for (const entry of entries) {
      const meta = metaFor(metas, entry.id)
      if (!isTextModel(entry.id, meta, vendor)) continue
      const model = buildModel(vendor, entry, meta, account.mode, { variants })
      models[model.id] = model
    }
  })
  return models
}
