import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

// The disk cache shared by the catalogs the plugin reads: models.dev's
// (models.mjs) and Cloudflare's model catalog (cfcatalog.mjs).

export const CACHE_TTL = 6 * 60 * 60 * 1000
// how long a failed refresh holds off the next one
export const CATALOG_RETRY = 10 * 60 * 1000

// Kept in this process only, never on disk: when each file's source last
// failed, by file name, as {until, message}.
const failures = new Map()

// resetCacheFailures forgets every source's last failure.
export function resetCacheFailures() {
  failures.clear()
}

// cached is what refresh() gives, kept for CACHE_TTL as
// <directory>/cloudflare-ai-gateway-auth/<name>; a stale copy serves while
// refresh fails. After a failure refresh isn't tried again for
// CATALOG_RETRY. ok(data) is whether a copy read back is usable; a corrupt or
// foreign file is as good as none. Without a directory nothing is kept on
// disk.
export async function cached(name, { directory, now = Date.now, ok, refresh }) {
  const folder = directory ? join(directory, "cloudflare-ai-gateway-auth") : null
  const file = folder ? join(folder, name) : null
  let kept = null
  if (file) {
    try {
      kept = JSON.parse(await readFile(file, "utf8"))
    } catch {}
    if (!ok(kept?.data)) kept = null
  }
  if (kept && now() - kept.fetchedAt < CACHE_TTL) return kept.data
  const failure = failures.get(name)
  if (failure && now() < failure.until) {
    if (kept) return kept.data
    throw new Error(failure.message)
  }
  try {
    const data = await refresh()
    if (!ok(data)) throw new Error(`${name} came back in a shape that is not usable`)
    if (file) {
      try {
        await mkdir(folder, { recursive: true })
        await writeFile(file, JSON.stringify({ fetchedAt: now(), data }))
      } catch {}
    }
    failures.delete(name)
    return data
  } catch (e) {
    failures.set(name, { until: now() + CATALOG_RETRY, message: e.message })
    if (kept) return kept.data
    throw e
  }
}
