import { cached } from "./cache.mjs"

// Cloudflare's model catalog: the only model ids the REST API takes (spec
// 11.6). Its page, as Markdown, is the source; nothing machine-readable
// publishes it.
export const CF_CATALOG = "https://developers.cloudflare.com/ai/models/index.md"

// An entry's link: /ai/models/<author>/<model>/. Workers AI models link to
// /ai/models/@cf/<author>/<model>/ and are left out, since no author starts
// with @.
const ENTRY_LINK = /\]\(https:\/\/developers\.cloudflare\.com\/ai\/models\/([^@/\s()][^/\s()]*)\/([^/\s()]+)\/?\)/

// parseCfCatalog reads the catalog page's Text Generation models as
// [{author, id}]. Each entry is one link:
//   [![<logo>](…)<h3><id></h3> <Author><Task> <description>](<model page>)
// Some entries have no logo image (a letter, or "Pinned", is in its place),
// so the page is split at each entry's <h3> heading, the author and id read
// from the link after it, and the task from the text between them.
export function parseCfCatalog(markdown) {
  if (typeof markdown !== "string") return []
  const entries = []
  for (const chunk of markdown.split("<h3>").slice(1)) {
    const link = ENTRY_LINK.exec(chunk)
    if (!link) continue
    if (!chunk.slice(0, link.index).replace(/\s+/g, " ").includes("Text Generation")) continue
    entries.push({ author: link[1], id: link[2] })
  }
  return entries
}

const entriesOk = (data) =>
  Array.isArray(data) &&
  data.length > 0 &&
  data.every((e) => typeof e?.author === "string" && e.author && typeof e.id === "string" && e.id)

// loadCfCatalog is the catalog's Text Generation models, kept for CACHE_TTL
// next to models.dev's catalog, with the same stale copy and CATALOG_RETRY
// hold-off (cache.mjs). A page without them, as after a change of format,
// fails like a page that is down.
export async function loadCfCatalog({ directory, fetchImpl = fetch, now = Date.now } = {}) {
  return cached("cf-catalog.json", {
    directory,
    now,
    ok: entriesOk,
    async refresh() {
      const res = await fetchImpl(CF_CATALOG, { signal: AbortSignal.timeout(15000) })
      if (!res.ok) throw new Error(`Cloudflare's model catalog answered ${res.status}`)
      const entries = parseCfCatalog(await res.text())
      if (!entries.length) throw new Error("Cloudflare's model catalog lists no text generation models")
      return entries
    },
  })
}
