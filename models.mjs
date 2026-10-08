import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { byokSlugs, tokenRefused } from "./cf.mjs"
import { GATEWAY, PLACEHOLDER } from "./route.mjs"
import { NPM, PROVIDER, VENDORS, protocolFor } from "./vendors.mjs"

export const MODELS_DEV = "https://models.dev/api.json"
export const CACHE_TTL = 6 * 60 * 60 * 1000
export const DEFAULT_LIMIT = { context: 128000, output: 16384 }

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

// loadCatalog is the vendors' models.dev catalogs, kept for CACHE_TTL in
// magpie's config folder; a stale copy serves while models.dev is down.
export async function loadCatalog({ directory, fetchImpl = fetch, now = Date.now } = {}) {
  const folder = directory ? join(directory, "cloudflare-ai-gateway-auth") : null
  const file = folder ? join(folder, "models-dev.json") : null
  let cached = null
  if (file) {
    try {
      cached = JSON.parse(await readFile(file, "utf8"))
    } catch {}
  }
  if (cached && now() - cached.fetchedAt < CACHE_TTL) return cached.data
  try {
    const res = await fetchImpl(MODELS_DEV, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(`models.dev answered ${res.status}`)
    const all = await res.json()
    const data = Object.fromEntries(VENDORS.map((v) => [v.catalog, { models: all?.[v.catalog]?.models ?? {} }]))
    if (file) {
      try {
        await mkdir(folder, { recursive: true })
        await writeFile(file, JSON.stringify({ fetchedAt: now(), data }))
      } catch {}
    }
    return data
  } catch (e) {
    if (cached) return cached.data
    throw e
  }
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

// buildModel is the OpenCode Model magpie lists for one vendor model: each
// field from models.dev first, then the vendor's live list, then defaults.
export function buildModel(vendor, entry, meta, mode) {
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
      temperature: meta?.temperature ?? true,
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
    variants: variantsOf(meta),
    options: {},
    headers: {},
    status: meta?.status ?? "active",
    release_date: meta?.release_date ?? "",
  }
}

// liveList asks the vendor for its models through the gateway, with the
// stored key. null when the vendor's list doesn't pass through (probe V2).
export async function liveList(vendor, account, fetchImpl = fetch) {
  if (!vendor.list) return null
  const headers = { ...vendor.list.headers, "cf-aig-authorization": `Bearer ${account.token}`, accept: "application/json" }
  if (account.alias) headers["cf-aig-byok-alias"] = account.alias
  const res = await fetchImpl(`${GATEWAY}/${account.account}/${account.gateway}/${vendor.slug}${vendor.list.path}`, {
    headers,
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) {
    await res.body?.cancel()
    throw new Error(`${vendor.prefix}'s model list answered ${res.status}`)
  }
  return parseList(vendor.list.format, await res.json())
}

// listModels is the account's models: the vendors its gateway holds keys
// for, each listed live or else from models.dev.
export async function listModels({ account, directory, fetchImpl = fetch, log = () => {} }) {
  let slugs = null
  try {
    slugs = await byokSlugs(account, { fetchImpl })
  } catch (e) {
    if (tokenRefused(e))
      throw Object.assign(new Error(`Cloudflare refused the API token (${e.message}); sign in again`), {
        signIn: "expired",
      })
    log("warn", `Couldn't read the gateway's stored keys, so every vendor is listed: ${e.message}`)
  }
  // a vendor the account's mode can't reach (rest: null after the probe) is left out
  const vendors = VENDORS.filter((v) => (!slugs || slugs.has(v.slug)) && protocolFor(v, account.mode))
  const [catalog, ...lives] = await Promise.all([
    loadCatalog({ directory, fetchImpl }).catch((e) => {
      log("warn", `models.dev is unavailable: ${e.message}`)
      return null
    }),
    ...vendors.map((v) =>
      liveList(v, account, fetchImpl).catch((e) => {
        log("warn", `${e.message}; using models.dev for ${v.prefix}`)
        return null
      }),
    ),
  ])
  const models = {}
  vendors.forEach((vendor, i) => {
    const metas = catalog?.[vendor.catalog]?.models ?? {}
    const entries = lives[i] ?? Object.values(metas).map((m) => ({ id: m.id, name: m.name }))
    for (const entry of entries) {
      const meta = metas[entry.id]
      if (!isTextModel(entry.id, meta, vendor)) continue
      const model = buildModel(vendor, entry, meta, account.mode)
      models[model.id] = model
    }
  })
  return models
}
