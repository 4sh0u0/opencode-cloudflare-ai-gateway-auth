// fakeFetch answers each request with the first route whose pattern is in
// (string) or matches (RegExp) its URL, and records every call.
export function fakeFetch(routes) {
  const calls = []
  const fn = async (url, init = {}) => {
    const href = String(url)
    calls.push({ url: href, init })
    for (const [pattern, answer] of routes) {
      const hit = typeof pattern === "string" ? href.includes(pattern) : pattern.test(href)
      if (hit) return typeof answer === "function" ? answer(href, init) : answer.clone()
    }
    return new Response("not found", { status: 404 })
  }
  fn.calls = calls
  return fn
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}
