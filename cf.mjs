import { API } from "./route.mjs"

// A Cloudflare API call that failed: status is the HTTP status, codes the
// codes of its errors. The message never holds the token.
export class CfError extends Error {
  constructor(message, status, codes = []) {
    super(message)
    this.name = "CfError"
    this.status = status
    this.codes = codes
  }
}

// cfGet calls a Cloudflare API endpoint with the token and returns its JSON
// envelope, or throws CfError.
export async function cfGet(path, token, { fetchImpl = fetch, signal } = {}) {
  const res = await fetchImpl(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: signal ?? AbortSignal.timeout(8000),
  })
  let body = null
  try {
    body = await res.json()
  } catch {}
  if (!res.ok || !body || body.success === false) {
    const errors = Array.isArray(body?.errors) ? body.errors : []
    const said = errors.map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${res.status}`
    throw new CfError(`Cloudflare API ${res.status}: ${said}`, res.status, errors.map((e) => Number(e.code)))
  }
  return body
}

const PER_PAGE = 50

// byokSlugs is the provider slugs the gateway holds a key for under the
// account's alias ("" is "default").
export async function byokSlugs({ account, gateway, alias, token }, { fetchImpl = fetch } = {}) {
  const want = alias || "default"
  const slugs = new Set()
  for (let page = 1; page <= 20; page++) {
    const body = await cfGet(
      `/accounts/${account}/ai-gateway/gateways/${encodeURIComponent(gateway)}/provider_configs?page=${page}&per_page=${PER_PAGE}`,
      token,
      { fetchImpl },
    )
    const rows = Array.isArray(body.result) ? body.result : []
    for (const r of rows) if (r?.provider_slug && (r.alias || "default") === want) slugs.add(r.provider_slug)
    if (rows.length < PER_PAGE) break
  }
  return slugs
}
