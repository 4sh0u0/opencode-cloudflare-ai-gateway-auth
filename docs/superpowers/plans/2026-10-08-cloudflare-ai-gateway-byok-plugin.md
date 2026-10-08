# Cloudflare AI Gateway BYOK 插件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 写一个 magpie 插件，让 magpie 经 Cloudflare AI Gateway、用网关托管的厂商 key（BYOK）调用 OpenAI / Anthropic / Google / DeepSeek / xAI 模型，并自动列出可用模型。

**Architecture:** 插件声明供应商 `cloudflare-ai-gateway`，`loader` 给 magpie 一个占位基础地址，所有请求在插件 `fetch` 里由 `route()` 解析「厂商前缀/原生ID」后改写到 CF 原生入口（模式 A）或 REST API（模式 B），删掉厂商认证头、加 `cf-aig-*` 头；`provider.models` 先查网关上配了 key 的厂商，再经网关透传拉各厂商实时列表，失败时回退 models.dev。

**Tech Stack:** Bun（≥ 1.1，运行与 `bun test`）、原生 ES Module（`.mjs`）、零运行时依赖；magpie ≥ 0.1.1110。

**Spec:** `docs/superpowers/specs/2026-10-08-cloudflare-ai-gateway-byok-plugin-design.md`

## Global Constraints

- npm 包名 `opencode-cloudflare-ai-gateway-auth`；magpie 供应商 ID `cloudflare-ai-gateway`。
- 占位基础地址固定为 `https://cloudflare-ai-gateway.invalid`，永不直连。
- 零运行时依赖；所有源文件为仓库根目录下的 `.mjs`；`index.mjs` 只导出 `export default { id, server }` 和 `export const _internal`，不导出任何函数。
- 代码注释、commit message、README 一律英文；每个 commit 结尾带 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- commit 必须 GPG 签名（仓库已配置 `user.email=4sh0u0@linux.com`、`user.signingkey=5FC3DEB250BA9FB9`、`commit.gpgsign=true`）；禁用 `--no-gpg-sign`。
- 任何日志、输出、测试快照中不得出现 token、厂商 key、请求体或响应体内容。
- 默认每个上游请求带 `cf-aig-no-wholesale: true`；仅当插件选项 `allowUnifiedBilling === true` 时不带。
- 建 GitHub 仓库、`git push`、`npm publish` 每一步执行前必须先得到用户在对话里的明确同意；推送前所有待推 commit 的 `%G?` 必须为 `G`。
- `.env.local`（真实 token）永不提交。

## Review Focus

1. 原生 ID 自身含 `/` 或 `:`（如微调模型 `ft:gpt-5/acme`）：只按第一个 `/` 拆分，原生 ID 原样保留 → Task 1 `splitModel` 测试、Task 2 route 测试。
2. Gemini 模型 ID 在 URL 里被编码成 `google%2Fgemini-…` 或保留原始 `/`：两种写法都应路由到同一上游 URL → Task 2 测试。
3. 请求体是字节（`Uint8Array`）而不是字符串：仍能解析并改写 `model` → Task 2 测试。
4. 用户在别名里填 `default`、带空格，或账号 ID 用大写：别名视为空（不发 `cf-aig-byok-alias`），账号 ID 规范为小写 → Task 6 `signIn` 测试 + Task 2 route 测试。
5. CF 边缘返回非 JSON（HTML）的 401/403：`annotate()` 不抛错，标为 `kept` → Task 3 测试。

---

## 文件结构

| 文件 | 职责 | 创建于 |
|---|---|---|
| `.gitignore` | 忽略 `.env.local`、`node_modules/`、实测与沙箱产物 | Task 0 |
| `scripts/probe.mjs` | 实测 spec 中的 V1–V7、V9 | Task 0 |
| `package.json`、`LICENSE` | 包元数据、MIT 许可 | Task 1 |
| `vendors.mjs` | 厂商映射表与模型键解析 | Task 1 |
| `route.mjs` | 请求改写（URL / 头 / 体） | Task 2 |
| `errors.mjs` | 本地错误响应、上游 401/403 的 `X-Magpie-Sign-In` 判定 | Task 3 |
| `cf.mjs` | Cloudflare API 客户端：`provider_configs` | Task 4 |
| `test/fetch.mjs` | 测试用假 fetch | Task 4 |
| `models.mjs` | 模型发现、models.dev 缓存与合并 | Task 5 |
| `index.mjs` | 组装 magpie 钩子 | Task 6 |
| `scripts/sandbox.sh`、`scripts/logs.mjs` | 沙箱集成测试、网关日志检查 | Task 7 |
| `README.md` | 用户文档 | Task 8 |

---

### Task 0: 实测待定项（Spike）

**目的：** 在写代码前，用用户真实 token 钉死 spec 8.1 的 V1–V7、V9。V8 属于 magpie 侧，在 Task 7 验证。

**Files:**
- Create: `.gitignore`
- Create: `scripts/probe.mjs`
- Modify: `docs/superpowers/specs/2026-10-08-cloudflare-ai-gateway-byok-plugin-design.md`（末尾追加「实测记录」）

**Interfaces:**
- Consumes: 无
- Produces: `probe-report.json`（gitignore）；spec 中的「实测记录」节；对 Task 1 `VENDORS` 表、Task 3 错误码集合的确定值。

- [ ] **Step 1: 写 `.gitignore`**

```gitignore
.env.local
node_modules/
probe-report.json
.sandbox-plugin.json
```

- [ ] **Step 2: 写 `scripts/probe.mjs`**

```js
#!/usr/bin/env bun
// Live probe for the open questions in the design spec (V1–V7, V9).
// Reads CF_API_TOKEN, CF_ACCOUNT_ID and CF_GATEWAY_ID from .env.local
// (run with: bun --env-file=.env.local scripts/probe.mjs).
// Optional: PROBE_MODEL_<VENDOR> picks the model to call per vendor;
// PROBE_V5=1 also runs the no-wholesale checks against the "default" gateway.
// Writes probe-report.json and never prints the token or whole bodies.

const token = process.env.CF_API_TOKEN
const account = process.env.CF_ACCOUNT_ID
const gateway = process.env.CF_GATEWAY_ID
if (!token || !account || !gateway) {
  console.error("Set CF_API_TOKEN, CF_ACCOUNT_ID and CF_GATEWAY_ID in .env.local")
  process.exit(2)
}

const GW = `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}`
const REST = `https://api.cloudflare.com/client/v4/accounts/${account}`
const PROMPT = "Reply with OK."
const MESSAGES = [{ role: "user", content: PROMPT }]
const report = {}

const redact = (text) => text.replaceAll(token, "<token>").slice(0, 300)

async function call(name, url, { method = "GET", headers = {}, body } = {}) {
  const started = Date.now()
  try {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    })
    const text = await res.text()
    report[name] = {
      status: res.status,
      type: res.headers.get("content-type"),
      ms: Date.now() - started,
      body: redact(text),
    }
    return { status: res.status, text }
  } catch (e) {
    report[name] = { error: String(e?.message ?? e) }
    return { status: 0, text: "" }
  }
}

const aig = { "cf-aig-authorization": `Bearer ${token}`, "cf-aig-no-wholesale": "true" }
const anthropicVersion = { "anthropic-version": "2023-06-01" }
const SKIP = /embed|tts|image|audio|-live|realtime|moderation|whisper|dall-e|sora|transcribe|computer-use|deep-research/i
const CHEAP = /mini|flash|haiku|chat|fast|nano|lite/i

function pick(ids) {
  const text = ids.filter((id) => !SKIP.test(id))
  return text.find((id) => CHEAP.test(id)) ?? text[0]
}

// V2: vendor lists through the gateway, with the stored keys
const LISTS = {
  openai: ["/openai/models", (j) => j.data?.map((m) => m.id)],
  anthropic: ["/anthropic/v1/models?limit=1000", (j) => j.data?.map((m) => m.id)],
  google: [
    "/google-ai-studio/v1beta/models?pageSize=1000",
    (j) =>
      j.models
        ?.filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
        .map((m) => m.name.replace(/^models\//, "")),
  ],
  deepseek: ["/deepseek/models", (j) => j.data?.map((m) => m.id)],
  xai: ["/grok/v1/models", (j) => j.data?.map((m) => m.id)],
}
const picked = {}
for (const [vendor, [path, ids]] of Object.entries(LISTS)) {
  const name = `V2.${vendor}.list`
  const r = await call(name, GW + path, { headers: { ...aig, ...anthropicVersion } })
  let found = []
  try {
    found = ids(JSON.parse(r.text)) ?? []
  } catch {}
  report[name].count = found.length
  report[name].sample = found.slice(0, 8)
  if (found.length) delete report[name].body
  picked[vendor] = process.env[`PROBE_MODEL_${vendor.toUpperCase()}`] ?? pick(found)
}
report.picked = picked

// V1: native endpoints, vendor auth headers left out
if (picked.openai)
  await call("V1.openai.responses", `${GW}/openai/responses`, {
    method: "POST",
    headers: aig,
    body: { model: picked.openai, input: PROMPT, max_output_tokens: 16 },
  })
if (picked.anthropic)
  await call("V1.anthropic.messages", `${GW}/anthropic/v1/messages`, {
    method: "POST",
    headers: { ...aig, ...anthropicVersion },
    body: { model: picked.anthropic, max_tokens: 1, messages: MESSAGES },
  })
if (picked.google)
  await call("V1.google.generate", `${GW}/google-ai-studio/v1beta/models/${picked.google}:generateContent`, {
    method: "POST",
    headers: aig,
    body: { contents: [{ role: "user", parts: [{ text: PROMPT }] }], generationConfig: { maxOutputTokens: 1 } },
  })
if (picked.deepseek)
  await call("V1.deepseek.chat", `${GW}/deepseek/chat/completions`, {
    method: "POST",
    headers: aig,
    body: { model: picked.deepseek, max_tokens: 1, messages: MESSAGES },
  })
if (picked.xai)
  await call("V1.xai.chat", `${GW}/grok/v1/chat/completions`, {
    method: "POST",
    headers: aig,
    body: { model: picked.xai, max_tokens: 1, messages: MESSAGES },
  })

// V6: Anthropic streaming, tools and a beta header through the gateway
if (picked.anthropic)
  await call("V6.anthropic.stream-tools", `${GW}/anthropic/v1/messages`, {
    method: "POST",
    headers: { ...aig, ...anthropicVersion, "anthropic-beta": "fine-grained-tool-streaming-2025-05-14" },
    body: {
      model: picked.anthropic,
      max_tokens: 16,
      stream: true,
      tools: [{ name: "noop", description: "Does nothing.", input_schema: { type: "object", properties: {} } }],
      messages: MESSAGES,
    },
  })

// V7: Gemini streaming path
if (picked.google)
  await call(
    "V7.google.stream",
    `${GW}/google-ai-studio/v1beta/models/${picked.google}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: aig,
      body: { contents: [{ role: "user", parts: [{ text: PROMPT }] }], generationConfig: { maxOutputTokens: 1 } },
    },
  )

// V3 + V4: REST API model prefixes and the token's permissions
const rest = { authorization: `Bearer ${token}`, "cf-aig-gateway-id": gateway, "cf-aig-no-wholesale": "true" }
if (picked.openai)
  await call("V3.rest.responses.openai", `${REST}/ai/v1/responses`, {
    method: "POST",
    headers: rest,
    body: { model: `openai/${picked.openai}`, input: PROMPT, max_output_tokens: 16 },
  })
if (picked.anthropic)
  await call("V3.rest.messages.anthropic", `${REST}/ai/v1/messages`, {
    method: "POST",
    headers: { ...rest, ...anthropicVersion },
    body: { model: `anthropic/${picked.anthropic}`, max_tokens: 1, messages: MESSAGES },
  })
if (picked.deepseek)
  await call("V3.rest.chat.deepseek", `${REST}/ai/v1/chat/completions`, {
    method: "POST",
    headers: rest,
    body: { model: `deepseek/${picked.deepseek}`, max_tokens: 1, messages: MESSAGES },
  })
for (const prefix of ["google-ai-studio", "google"])
  if (picked.google)
    await call(`V3.rest.chat.${prefix}`, `${REST}/ai/v1/chat/completions`, {
      method: "POST",
      headers: rest,
      body: { model: `${prefix}/${picked.google}`, max_tokens: 1, messages: MESSAGES },
    })
for (const prefix of ["xai", "grok"])
  if (picked.xai)
    await call(`V3.rest.chat.${prefix}`, `${REST}/ai/v1/chat/completions`, {
      method: "POST",
      headers: rest,
      body: { model: `${prefix}/${picked.xai}`, max_tokens: 1, messages: MESSAGES },
    })

// V5: no-wholesale on a gateway without stored keys. If the header were
// ignored, each of these two requests would be billed to Unified Billing
// credits (1 output token), so they only run when PROBE_V5=1.
if (process.env.PROBE_V5 === "1" && picked.openai) {
  await call(
    "V5.native.default-gateway",
    `https://gateway.ai.cloudflare.com/v1/${account}/default/openai/chat/completions`,
    { method: "POST", headers: aig, body: { model: picked.openai, max_tokens: 1, messages: MESSAGES } },
  )
  await call("V5.rest.default-gateway", `${REST}/ai/v1/chat/completions`, {
    method: "POST",
    headers: { ...rest, "cf-aig-gateway-id": "default" },
    body: { model: `openai/${picked.openai}`, max_tokens: 1, messages: MESSAGES },
  })
}

// V9: how Cloudflare refuses a bad token on each surface
const bad = "probe-invalid-token"
await call("V9.native.bad-token", `${GW}/openai/models`, { headers: { "cf-aig-authorization": `Bearer ${bad}` } })
await call("V9.rest.bad-token", `${REST}/ai/v1/chat/completions`, {
  method: "POST",
  headers: { authorization: `Bearer ${bad}`, "cf-aig-gateway-id": gateway },
  body: { model: "openai/probe", max_tokens: 1, messages: MESSAGES },
})
await call("V9.api.bad-token", `${REST}/ai-gateway/gateways/${gateway}/provider_configs`, {
  headers: { authorization: `Bearer ${bad}` },
})

// provider_configs with the real token: keep only slug and alias (the
// listing also carries a preview of each secret)
const configs = await call("V9.api.provider-configs", `${REST}/ai-gateway/gateways/${gateway}/provider_configs?per_page=50`, {
  headers: { authorization: `Bearer ${token}` },
})
try {
  const j = JSON.parse(configs.text)
  report["V9.api.provider-configs"].body = undefined
  report["V9.api.provider-configs"].rows = (j.result ?? []).map((r) => ({ provider_slug: r.provider_slug, alias: r.alias }))
  report["V9.api.provider-configs"].fields = Object.keys(j.result?.[0] ?? {})
} catch {
  report["V9.api.provider-configs"].body = "<unparsed, hidden>"
}

await Bun.write("probe-report.json", JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
```

- [ ] **Step 3: 请用户准备 token**

在对话里请用户：

1. 在 Cloudflare 控制台 → My Profile → API Tokens → Create Token → Custom，权限勾选 Account → AI Gateway → Run 和 Account → AI Gateway → Read（模式 B 若 V4 证明需要，再加 Account → Workers AI → Read）。
2. 在项目根目录创建 `.env.local`（`chmod 600 .env.local`）：

```dotenv
CF_API_TOKEN=YOUR_API_TOKEN
CF_ACCOUNT_ID=YOUR_ACCOUNT_ID
CF_GATEWAY_ID=my-gateway
```

3. 是否同意运行 `PROBE_V5=1`（若 `cf-aig-no-wholesale` 不生效，会产生两次各 1 个输出 token 的统一计费扣费）。

等用户回复「好了」再继续。不要在对话中索要或回显 token。

- [ ] **Step 4: 运行实测**

Run: `bun --env-file=.env.local scripts/probe.mjs`（用户同意 V5 时前面加 `PROBE_V5=1`）
Expected: 生成 `probe-report.json`，输出中没有 token；每个键有 `status`。

- [ ] **Step 5: 按结论更新设计**

逐项对照 spec 8.1 表的「不成立时的处理」，把确定值写下来，供 Task 1/3 使用：

| 实测项 | 读哪些键 | 写到哪里 |
|---|---|---|
| V1 | `V1.*` 状态 200 | 不是 200 的厂商：在 Task 1 的 `VENDORS` 中把该厂商 `native.paths` 里对应协议删掉，并在 README 记录 |
| V2 | `V2.*.list` 的 `count` | `count` 为 0 的厂商：Task 1 中该厂商 `list: null` |
| V3 | `V3.rest.chat.google*`、`V3.rest.chat.xai/grok` | 返回 200 的那个前缀写入该厂商 `restPrefix`；都不是 200 → 该厂商 `rest: null`（Task 1 的 `protocolFor` 与 Task 2 的 REST 分支需对 `null` 报 RouteError，见 Task 2 Step 3 注释） |
| V4 | `V3.*` 的 401/403 错误码 | README「Token permissions」一节 |
| V5 | `V5.*` 状态 400 | 不是 400：README 写明依赖网关 `byok_only` |
| V6 | `V6.anthropic.stream-tools` 200 且 `type` 为 `text/event-stream` | 不满足：在 spec「实测记录」写明差异，停下来和用户讨论 |
| V7 | `V7.google.stream` 200 | 不满足：Google 的 `native.protocol` 改为 `chat` |
| V9 | `V9.*.bad-token` 的状态码与 `error`/`errors` 中的 `code` | Task 3 的 `GATEWAY_AUTH_CODES` / `API_AUTH_CODES`；Task 4 对 401 的判断 |

- [ ] **Step 6: 在 spec 末尾追加「实测记录」**

在 spec 文件末尾追加一节 `## 11. 实测记录（2026-10-08）`，用表格列出每个 V 项：结论（成立/不成立）、状态码、采用的处理。不得包含 token、账号 ID、模型输出内容。

- [ ] **Step 7: Commit**

```bash
git add .gitignore scripts/probe.mjs docs/superpowers/specs/2026-10-08-cloudflare-ai-gateway-byok-plugin-design.md
git commit -F - <<'EOF'
chore: add live probe and record gateway behavior

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
git log --format='%h %G? %s' -1
```

Expected: 最后一行第二列为 `G`。

---

### Task 1: 包骨架与厂商映射表

**Files:**
- Create: `package.json`
- Create: `LICENSE`
- Create: `vendors.mjs`
- Test: `test/vendors.test.mjs`

**Interfaces:**
- Consumes: Task 0 Step 5 的确定值（`restPrefix`、`list: null`、删减的 `native.paths`）
- Produces（`vendors.mjs`）：
  - `PROVIDER: "cloudflare-ai-gateway"`
  - `NPM: { chat, responses, messages, gemini }`（值为 AI SDK 包名字符串）
  - `PROTOCOL_PATHS: { chat: "/chat/completions", responses: "/responses", messages: "/messages" }`
  - `VENDORS: Array<{ prefix, slug, restPrefix, catalog, native: { protocol, paths }, rest, list: { path, format, headers } | null }>`
  - `vendorByPrefix(prefix: string) → vendor | undefined`
  - `splitModel(key: unknown) → { prefix: string, nativeId: string, vendor: vendor | undefined } | null`
  - `protocolFor(vendor, mode: "native" | "rest") → "chat" | "responses" | "messages" | "gemini"`

- [ ] **Step 1: 写 `package.json` 与 `LICENSE`**

`package.json`：

```json
{
  "name": "opencode-cloudflare-ai-gateway-auth",
  "version": "0.1.0",
  "description": "magpie / OpenCode provider plugin: Cloudflare AI Gateway with your own provider keys (BYOK)",
  "type": "module",
  "main": "./index.mjs",
  "files": ["index.mjs", "vendors.mjs", "route.mjs", "errors.mjs", "cf.mjs", "models.mjs", "README.md", "LICENSE"],
  "keywords": ["opencode", "opencode-plugin", "magpie", "cloudflare", "ai-gateway", "byok"],
  "license": "MIT",
  "engines": { "bun": ">=1.1.0" },
  "scripts": { "test": "bun test" }
}
```

`LICENSE`：

```text
MIT License

Copyright (c) 2026 Haru Hazawa

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: 写失败的测试 `test/vendors.test.mjs`**

```js
import { describe, expect, test } from "bun:test"
import { NPM, PROTOCOL_PATHS, PROVIDER, VENDORS, protocolFor, splitModel, vendorByPrefix } from "../vendors.mjs"

describe("VENDORS", () => {
  test("covers the five supported vendors in order", () => {
    expect(VENDORS.map((v) => v.prefix)).toEqual(["openai", "anthropic", "google", "deepseek", "xai"])
  })

  test("every native default protocol has a path and an AI SDK package", () => {
    for (const v of VENDORS) {
      expect(typeof v.native.paths[v.native.protocol]).toBe("string")
      expect(typeof NPM[v.native.protocol]).toBe("string")
    }
  })

  test("every REST protocol is one the REST API serves", () => {
    for (const v of VENDORS) if (v.rest !== null) expect(Object.keys(PROTOCOL_PATHS)).toContain(v.rest)
  })

  test("xAI goes through the gateway slug grok, Google through google-ai-studio", () => {
    expect(vendorByPrefix("xai").slug).toBe("grok")
    expect(vendorByPrefix("google").slug).toBe("google-ai-studio")
  })

  test("the provider id is fixed", () => {
    expect(PROVIDER).toBe("cloudflare-ai-gateway")
  })
})

describe("splitModel", () => {
  test("splits the prefix from the native id", () => {
    const r = splitModel("anthropic/claude-sonnet-5.5")
    expect(r.prefix).toBe("anthropic")
    expect(r.nativeId).toBe("claude-sonnet-5.5")
    expect(r.vendor.slug).toBe("anthropic")
  })

  test("keeps slashes and colons inside the native id", () => {
    expect(splitModel("openai/ft:gpt-5/acme").nativeId).toBe("ft:gpt-5/acme")
  })

  test("leaves vendor undefined for an unknown prefix", () => {
    const r = splitModel("mistral/mistral-large")
    expect(r.prefix).toBe("mistral")
    expect(r.vendor).toBeUndefined()
  })

  test("rejects keys that aren't <prefix>/<id>", () => {
    for (const key of ["", "gpt-5", "/gpt-5", "openai/", undefined, null, 42]) expect(splitModel(key)).toBeNull()
  })
})

describe("protocolFor", () => {
  test("Google speaks Gemini natively and chat completions over REST", () => {
    const google = vendorByPrefix("google")
    expect(protocolFor(google, "native")).toBe("gemini")
    expect(protocolFor(google, "rest")).toBe("chat")
  })

  test("Anthropic speaks Messages in both modes", () => {
    const anthropic = vendorByPrefix("anthropic")
    expect(protocolFor(anthropic, "native")).toBe("messages")
    expect(protocolFor(anthropic, "rest")).toBe("messages")
  })
})
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `bun test test/vendors.test.mjs`
Expected: FAIL，报错 `Cannot find module '../vendors.mjs'`（或等价的找不到模块）。

- [ ] **Step 4: 写 `vendors.mjs`**

（若 Task 0 Step 5 改变了某个字段，以实测值为准替换下面对应的值。）

```js
// Vendors this plugin reaches through Cloudflare AI Gateway, and how.
// Everything Cloudflare-specific about a vendor lives in this one table.

export const PROVIDER = "cloudflare-ai-gateway"

// The AI SDK package that makes magpie speak each API to the plugin.
export const NPM = {
  chat: "@ai-sdk/openai-compatible",
  responses: "@ai-sdk/openai",
  messages: "@ai-sdk/anthropic",
  gemini: "@ai-sdk/google",
}

// The path magpie appends to the base URL for each API. Gemini's carries
// the model id, so route.mjs matches it on its own.
export const PROTOCOL_PATHS = {
  chat: "/chat/completions",
  responses: "/responses",
  messages: "/messages",
}

const ANTHROPIC_VERSION = { "anthropic-version": "2023-06-01" }

export const VENDORS = [
  {
    prefix: "openai", // the model key's prefix in magpie
    slug: "openai", // the gateway's provider slug, for BYOK and native URLs
    restPrefix: "openai", // the model prefix the REST API takes
    catalog: "openai", // the models.dev provider holding its metadata
    native: { protocol: "responses", paths: { responses: "/responses", chat: "/chat/completions" } },
    rest: "responses",
    list: { path: "/models", format: "openai", headers: {} },
  },
  {
    prefix: "anthropic",
    slug: "anthropic",
    restPrefix: "anthropic",
    catalog: "anthropic",
    native: { protocol: "messages", paths: { messages: "/v1/messages", chat: "/v1/chat/completions" } },
    rest: "messages",
    list: { path: "/v1/models?limit=1000", format: "anthropic", headers: ANTHROPIC_VERSION },
  },
  {
    prefix: "google",
    slug: "google-ai-studio",
    restPrefix: "google-ai-studio",
    catalog: "google",
    // gemini's path is what comes before /models/<id>:<method>
    native: { protocol: "gemini", paths: { gemini: "/v1beta", chat: "/v1beta/openai/chat/completions" } },
    rest: "chat",
    list: { path: "/v1beta/models?pageSize=1000", format: "gemini", headers: {} },
  },
  {
    prefix: "deepseek",
    slug: "deepseek",
    restPrefix: "deepseek",
    catalog: "deepseek",
    native: { protocol: "chat", paths: { chat: "/chat/completions" } },
    rest: "chat",
    list: { path: "/models", format: "openai", headers: {} },
  },
  {
    prefix: "xai",
    slug: "grok",
    restPrefix: "xai",
    catalog: "xai",
    native: { protocol: "chat", paths: { chat: "/v1/chat/completions", responses: "/v1/responses" } },
    rest: "chat",
    list: { path: "/v1/models", format: "openai", headers: {} },
  },
]

export function vendorByPrefix(prefix) {
  return VENDORS.find((v) => v.prefix === prefix)
}

// splitModel parses a model key, "<prefix>/<native id>". The native id keeps
// any slash after the first; vendor is undefined for an unknown prefix.
export function splitModel(key) {
  if (typeof key !== "string") return null
  const at = key.indexOf("/")
  if (at <= 0 || at === key.length - 1) return null
  const prefix = key.slice(0, at)
  return { prefix, nativeId: key.slice(at + 1), vendor: vendorByPrefix(prefix) }
}

// protocolFor is the API a vendor's models speak to the plugin in a mode.
export function protocolFor(vendor, mode) {
  return mode === "rest" ? vendor.rest : vendor.native.protocol
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `bun test test/vendors.test.mjs`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add package.json LICENSE vendors.mjs test/vendors.test.mjs
git commit -F - <<'EOF'
feat: add package skeleton and vendor table

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
git log --format='%h %G? %s' -1
```

---

### Task 2: 请求路由 `route.mjs`

**Files:**
- Create: `route.mjs`
- Test: `test/route.test.mjs`

**Interfaces:**
- Consumes: `PROTOCOL_PATHS`、`splitModel` from `vendors.mjs`
- Produces（`route.mjs`）：
  - `PLACEHOLDER = "https://cloudflare-ai-gateway.invalid"`、`GATEWAY = "https://gateway.ai.cloudflare.com/v1"`、`API = "https://api.cloudflare.com/client/v4"`
  - `class RouteError extends Error { protocol: string }`
  - `parseRequest(url: string, body: string | Uint8Array | undefined) → { protocol, method?, search, json?, vendor, nativeId }`
  - `route(url: string, init: RequestInit, account: { token, account, gateway, mode, alias }, options?: { allowUnifiedBilling?: boolean }) → { url: string, init: RequestInit, vendor, protocol }`

- [ ] **Step 1: 写失败的测试 `test/route.test.mjs`**

```js
import { describe, expect, test } from "bun:test"
import { API, GATEWAY, PLACEHOLDER, RouteError, route } from "../route.mjs"

const ACCT = "0123456789abcdef0123456789abcdef"
const NATIVE = { token: "tok", account: ACCT, gateway: "my-gateway", mode: "native", alias: "" }
const REST = { ...NATIVE, mode: "rest" }
const GW = `${GATEWAY}/${ACCT}/my-gateway`

function request(path, body, headers = {}) {
  return [
    `${PLACEHOLDER}${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "999", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  ]
}

describe("native mode", () => {
  test("Anthropic Messages goes to /anthropic/v1/messages with the gateway token only", () => {
    const [url, init] = request(
      "/messages",
      { model: "anthropic/claude-x", max_tokens: 8 },
      { "x-api-key": "tok", "anthropic-version": "2023-06-01", "anthropic-beta": "b1" },
    )
    const r = route(url, init, NATIVE)
    expect(r.url).toBe(`${GW}/anthropic/v1/messages`)
    expect(r.init.method).toBe("POST")
    expect(JSON.parse(r.init.body)).toEqual({ model: "claude-x", max_tokens: 8 })
    const h = r.init.headers
    expect(h.get("x-api-key")).toBeNull()
    expect(h.get("authorization")).toBeNull()
    expect(h.get("content-length")).toBeNull()
    expect(h.get("cf-aig-authorization")).toBe("Bearer tok")
    expect(h.get("cf-aig-no-wholesale")).toBe("true")
    expect(h.get("anthropic-version")).toBe("2023-06-01")
    expect(h.get("anthropic-beta")).toBe("b1")
    expect(h.get("cf-aig-byok-alias")).toBeNull()
  })

  test("OpenAI Responses and chat completions go to /openai", () => {
    const [u1, i1] = request("/responses", { model: "openai/gpt-x", input: "hi" }, { authorization: "Bearer tok" })
    expect(route(u1, i1, NATIVE).url).toBe(`${GW}/openai/responses`)
    const [u2, i2] = request("/chat/completions", { model: "openai/gpt-x", messages: [] })
    expect(route(u2, i2, NATIVE).url).toBe(`${GW}/openai/chat/completions`)
  })

  test("Gemini streaming keeps its query and body", () => {
    const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] }
    const [url, init] = request("/models/google/gemini-x:streamGenerateContent?alt=sse", body, {
      "x-goog-api-key": "tok",
    })
    const r = route(url, init, NATIVE)
    expect(r.url).toBe(`${GW}/google-ai-studio/v1beta/models/gemini-x:streamGenerateContent?alt=sse`)
    expect(r.init.body).toBe(init.body)
    expect(r.init.headers.get("x-goog-api-key")).toBeNull()
  })

  test("a Gemini model id encoded in the path routes the same way", () => {
    const [url, init] = request("/models/google%2Fgemini-x:generateContent", { contents: [] })
    expect(route(url, init, NATIVE).url).toBe(`${GW}/google-ai-studio/v1beta/models/gemini-x:generateContent`)
  })

  test("DeepSeek and xAI use their chat paths and gateway slugs", () => {
    const [u1, i1] = request("/chat/completions", { model: "deepseek/deepseek-chat", messages: [] })
    expect(route(u1, i1, NATIVE).url).toBe(`${GW}/deepseek/chat/completions`)
    const [u2, i2] = request("/chat/completions", { model: "xai/grok-9", messages: [] })
    const r2 = route(u2, i2, NATIVE)
    expect(r2.url).toBe(`${GW}/grok/v1/chat/completions`)
    expect(JSON.parse(r2.init.body).model).toBe("grok-9")
  })

  test("a native id with slashes is passed on whole", () => {
    const [url, init] = request("/responses", { model: "openai/ft:gpt-5/acme", input: "hi" })
    expect(JSON.parse(route(url, init, NATIVE).init.body).model).toBe("ft:gpt-5/acme")
  })

  test("a byte body is read like a string one", () => {
    const [url, init] = request("/messages")
    init.body = new TextEncoder().encode(JSON.stringify({ model: "anthropic/claude-x" }))
    expect(JSON.parse(route(url, init, NATIVE).init.body).model).toBe("claude-x")
  })

  test("a non-default alias is sent as cf-aig-byok-alias", () => {
    const [url, init] = request("/messages", { model: "anthropic/claude-x" })
    expect(route(url, init, { ...NATIVE, alias: "team" }).init.headers.get("cf-aig-byok-alias")).toBe("team")
  })

  test("allowUnifiedBilling leaves cf-aig-no-wholesale out", () => {
    const [url, init] = request("/messages", { model: "anthropic/claude-x" })
    expect(route(url, init, NATIVE, { allowUnifiedBilling: true }).init.headers.get("cf-aig-no-wholesale")).toBeNull()
  })

  test("an API the vendor doesn't take through the gateway is refused", () => {
    const [url, init] = request("/responses", { model: "deepseek/deepseek-chat", input: "hi" })
    expect(() => route(url, init, NATIVE)).toThrow(RouteError)
  })
})

describe("REST mode", () => {
  test("Anthropic Messages goes to /ai/v1/messages with the prefixed model", () => {
    const [url, init] = request("/messages", { model: "anthropic/claude-x" }, { "x-api-key": "tok" })
    const r = route(url, init, REST)
    expect(r.url).toBe(`${API}/accounts/${ACCT}/ai/v1/messages`)
    expect(JSON.parse(r.init.body).model).toBe("anthropic/claude-x")
    const h = r.init.headers
    expect(h.get("authorization")).toBe("Bearer tok")
    expect(h.get("x-api-key")).toBeNull()
    expect(h.get("cf-aig-gateway-id")).toBe("my-gateway")
    expect(h.get("cf-aig-no-wholesale")).toBe("true")
    expect(h.get("cf-aig-authorization")).toBeNull()
  })

  test("xAI uses its REST prefix", () => {
    const [url, init] = request("/chat/completions", { model: "xai/grok-9", messages: [] })
    expect(JSON.parse(route(url, init, REST).init.body).model).toBe("xai/grok-9")
  })

  test("Gemini's API has no REST endpoint", () => {
    const [url, init] = request("/models/google/gemini-x:generateContent", { contents: [] })
    expect(() => route(url, init, REST)).toThrow(RouteError)
  })
})

describe("refusals", () => {
  test("an unknown vendor is refused in the request's protocol", () => {
    const [url, init] = request("/messages", { model: "mistral/large" })
    try {
      route(url, init, NATIVE)
      throw new Error("expected a RouteError")
    } catch (e) {
      expect(e).toBeInstanceOf(RouteError)
      expect(e.protocol).toBe("messages")
      expect(e.message).toContain("mistral")
    }
  })

  test("a model without a vendor prefix is refused", () => {
    const [url, init] = request("/chat/completions", { model: "gpt-5", messages: [] })
    expect(() => route(url, init, NATIVE)).toThrow(RouteError)
  })

  test("an unknown path is refused", () => {
    const [url, init] = request("/embeddings", { model: "openai/text-embedding-3" })
    expect(() => route(url, init, NATIVE)).toThrow(RouteError)
  })

  test("a body that isn't JSON is refused", () => {
    const [url, init] = request("/messages")
    init.body = "not json"
    expect(() => route(url, init, NATIVE)).toThrow(RouteError)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `bun test test/route.test.mjs`
Expected: FAIL，找不到 `../route.mjs`。

- [ ] **Step 3: 写 `route.mjs`**

```js
import { PROTOCOL_PATHS, splitModel } from "./vendors.mjs"

// magpie appends each API's path to this base; route() replaces it, so
// nothing is ever sent to it.
export const PLACEHOLDER = "https://cloudflare-ai-gateway.invalid"
export const GATEWAY = "https://gateway.ai.cloudflare.com/v1"
export const API = "https://api.cloudflare.com/client/v4"

// A request the plugin can't send. index.mjs answers it locally, in the
// request's own API shape.
export class RouteError extends Error {
  constructor(message, protocol) {
    super(message)
    this.name = "RouteError"
    this.protocol = protocol
  }
}

const GEMINI = /^\/models\/(.+):(streamGenerateContent|generateContent)$/

// What magpie adds for the saved key. The gateway forwards a request that
// carries any of these as it is, without using the stored BYOK key.
const VENDOR_AUTH = ["authorization", "x-api-key", "x-goog-api-key"]

function text(body) {
  if (body == null) return ""
  return typeof body === "string" ? body : new TextDecoder().decode(body)
}

// parseRequest reads which API, vendor and model a request magpie built is for.
export function parseRequest(url, body) {
  const u = new URL(url)
  let protocol = Object.keys(PROTOCOL_PATHS).find((p) => PROTOCOL_PATHS[p] === u.pathname)
  let key
  let method
  let json
  if (protocol) {
    try {
      json = JSON.parse(text(body))
    } catch {
      throw new RouteError("The request body is not JSON", protocol)
    }
    key = json?.model
  } else {
    const m = GEMINI.exec(u.pathname)
    if (!m) throw new RouteError(`Unsupported endpoint ${u.pathname}`, "chat")
    protocol = "gemini"
    method = m[2]
    try {
      key = decodeURIComponent(m[1])
    } catch {
      throw new RouteError(`Malformed model id in ${u.pathname}`, protocol)
    }
  }
  const parsed = splitModel(key)
  if (!parsed) throw new RouteError(`Model "${key}" should look like <vendor>/<model>`, protocol)
  if (!parsed.vendor) throw new RouteError(`Unknown vendor "${parsed.prefix}" in model "${key}"`, protocol)
  return { protocol, method, search: u.search, json, vendor: parsed.vendor, nativeId: parsed.nativeId }
}

// route turns a request magpie built for PLACEHOLDER into the one sent to
// Cloudflare. account is {token, account, gateway, mode, alias}.
export function route(url, init, account, options = {}) {
  const req = parseRequest(url, init?.body)
  const { protocol, vendor, nativeId } = req
  const headers = new Headers(init?.headers)
  headers.delete("content-length")
  headers.delete("host")
  if (!options.allowUnifiedBilling) headers.set("cf-aig-no-wholesale", "true")

  let target
  let body = init?.body
  if (account.mode === "rest") {
    const path = PROTOCOL_PATHS[protocol]
    // vendor.rest is null when the probe found no REST route for the vendor
    if (!path || vendor.rest === null)
      throw new RouteError(`The REST API can't serve this ${protocol} request; sign in with the native mode`, protocol)
    target = `${API}/accounts/${account.account}/ai/v1${path}${req.search}`
    body = JSON.stringify({ ...req.json, model: `${vendor.restPrefix}/${nativeId}` })
    headers.delete("x-api-key")
    headers.delete("x-goog-api-key")
    headers.set("authorization", `Bearer ${account.token}`)
    headers.set("cf-aig-gateway-id", account.gateway)
  } else {
    const base = vendor.native.paths[protocol]
    if (base === undefined)
      throw new RouteError(`${vendor.prefix} models don't take the ${protocol} API through the gateway`, protocol)
    const path = protocol === "gemini" ? `${base}/models/${nativeId}:${req.method}` : base
    target = `${GATEWAY}/${account.account}/${account.gateway}/${vendor.slug}${path}${req.search}`
    if (protocol !== "gemini") body = JSON.stringify({ ...req.json, model: nativeId })
    for (const name of VENDOR_AUTH) headers.delete(name)
    headers.set("cf-aig-authorization", `Bearer ${account.token}`)
    if (account.alias) headers.set("cf-aig-byok-alias", account.alias)
  }
  return { url: target, init: { ...init, method: init?.method ?? "POST", headers, body }, vendor, protocol }
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `bun test test/route.test.mjs`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add route.mjs test/route.test.mjs
git commit -F - <<'EOF'
feat: route requests to native gateway or REST endpoints

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
git log --format='%h %G? %s' -1
```

---

### Task 3: 错误处理 `errors.mjs`

**Files:**
- Create: `errors.mjs`
- Test: `test/errors.test.mjs`

**Interfaces:**
- Consumes: Task 0 V9 的错误码
- Produces（`errors.mjs`）：
  - `GATEWAY_AUTH_CODES: Set<number>`、`API_AUTH_CODES: Set<number>`
  - `localError(protocol: string, status: number, message: string) → Response`
  - `signInOf(status: number, text: string, mode: "native" | "rest") → "expired" | "kept" | null`
  - `annotate(response: Response, mode) → Promise<Response>`

- [ ] **Step 1: 写失败的测试 `test/errors.test.mjs`**

```js
import { describe, expect, test } from "bun:test"
import { annotate, localError, signInOf } from "../errors.mjs"

const gatewayRefusal = JSON.stringify({ success: false, error: [{ code: 2009, message: "Unauthorized" }] })
const apiRefusal = JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] })
const anthropicRefusal = JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })
const openaiRefusal = JSON.stringify({ error: { message: "Incorrect API key", code: "invalid_api_key" } })

describe("signInOf", () => {
  test("Cloudflare refusing the token on the gateway expires the sign-in", () => {
    expect(signInOf(401, gatewayRefusal, "native")).toBe("expired")
  })

  test("Cloudflare refusing the token on the REST API expires the sign-in", () => {
    expect(signInOf(401, apiRefusal, "rest")).toBe("expired")
  })

  test("a vendor refusing its stored key keeps the sign-in", () => {
    expect(signInOf(401, anthropicRefusal, "native")).toBe("kept")
    expect(signInOf(401, openaiRefusal, "rest")).toBe("kept")
    expect(signInOf(403, gatewayRefusal, "native")).toBe("kept")
  })

  test("an HTML refusal keeps the sign-in", () => {
    expect(signInOf(401, "<html>denied</html>", "native")).toBe("kept")
  })

  test("other statuses say nothing", () => {
    for (const status of [200, 400, 429, 500]) expect(signInOf(status, gatewayRefusal, "native")).toBeNull()
  })
})

describe("annotate", () => {
  test("passes a success through untouched", async () => {
    const res = new Response("ok", { status: 200 })
    expect(await annotate(res, "native")).toBe(res)
  })

  test("passes a 400 and a 429 through untouched", async () => {
    for (const status of [400, 429, 503]) {
      const res = new Response("x", { status })
      expect(await annotate(res, "native")).toBe(res)
    }
  })

  test("marks a gateway 401 expired and keeps the body", async () => {
    const res = new Response(gatewayRefusal, {
      status: 401,
      headers: { "content-type": "application/json", "content-length": "5", "content-encoding": "gzip" },
    })
    const out = await annotate(res, "native")
    expect(out.status).toBe(401)
    expect(out.headers.get("x-magpie-sign-in")).toBe("expired")
    expect(out.headers.get("content-length")).toBeNull()
    expect(out.headers.get("content-encoding")).toBeNull()
    expect(await out.text()).toBe(gatewayRefusal)
  })

  test("marks an HTML 403 kept without throwing", async () => {
    const out = await annotate(new Response("<html></html>", { status: 403 }), "rest")
    expect(out.headers.get("x-magpie-sign-in")).toBe("kept")
  })
})

describe("localError", () => {
  test("answers in the Anthropic error shape", async () => {
    const res = localError("messages", 400, "nope")
    expect(res.status).toBe(400)
    expect(res.headers.get("content-type")).toBe("application/json")
    expect(await res.json()).toEqual({ type: "error", error: { type: "invalid_request_error", message: "nope" } })
  })

  test("answers in the OpenAI error shape for chat and responses", async () => {
    for (const protocol of ["chat", "responses"])
      expect(await localError(protocol, 400, "nope").json()).toEqual({
        error: { message: "nope", type: "invalid_request_error" },
      })
  })

  test("answers in the Gemini error shape", async () => {
    expect(await localError("gemini", 400, "nope").json()).toEqual({
      error: { code: 400, message: "nope", status: "INVALID_ARGUMENT" },
    })
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `bun test test/errors.test.mjs`
Expected: FAIL，找不到 `../errors.mjs`。

- [ ] **Step 3: 写 `errors.mjs`**

（`GATEWAY_AUTH_CODES` / `API_AUTH_CODES` 以 Task 0 V9 实测为准，下面是实测前的值。若 V9 显示 Cloudflare 的错误放在别的字段，同步改 `errorCodes` 与第一个测试的样本。）

```js
// Cloudflare's own refusals of the API token, by where the request went
// (design spec 7.1; codes confirmed by the live probe, V9).
export const GATEWAY_AUTH_CODES = new Set([2009])
export const API_AUTH_CODES = new Set([10000, 9109])

const BODIES = {
  messages: (message) => ({ type: "error", error: { type: "invalid_request_error", message } }),
  responses: (message) => ({ error: { message, type: "invalid_request_error" } }),
  chat: (message) => ({ error: { message, type: "invalid_request_error" } }),
  gemini: (message, status) => ({ error: { code: status, message, status: "INVALID_ARGUMENT" } }),
}

// localError is an answer the plugin gives itself, shaped like the API's
// own errors so the agent shows the message.
export function localError(protocol, status, message) {
  const body = (BODIES[protocol] ?? BODIES.chat)(message, status)
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

// errorCodes is every numeric code in a Cloudflare error body; a vendor's
// own error (string codes, or none) has none.
function errorCodes(text) {
  let json
  try {
    json = JSON.parse(text)
  } catch {
    return []
  }
  return [json?.errors, json?.error]
    .flatMap((e) => (Array.isArray(e) ? e : e && typeof e === "object" ? [e] : []))
    .map((e) => Number(e?.code))
    .filter(Number.isFinite)
}

// signInOf is what a 401 or 403 means for the account: "expired" when
// Cloudflare refused the token, "kept" when it's about anything else (the
// vendor refusing its stored key, or a permission).
export function signInOf(status, text, mode) {
  if (status !== 401 && status !== 403) return null
  const ours = mode === "rest" ? API_AUTH_CODES : GATEWAY_AUTH_CODES
  return status === 401 && errorCodes(text).some((c) => ours.has(c)) ? "expired" : "kept"
}

// annotate tells magpie what a 401 or 403 means through X-Magpie-Sign-In,
// and passes every other answer on as it came.
export async function annotate(response, mode) {
  if (response.status !== 401 && response.status !== 403) return response
  const text = await response.text()
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  headers.set("x-magpie-sign-in", signInOf(response.status, text, mode))
  return new Response(text, { status: response.status, statusText: response.statusText, headers })
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `bun test test/errors.test.mjs`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add errors.mjs test/errors.test.mjs
git commit -F - <<'EOF'
feat: classify upstream refusals and answer local errors

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
git log --format='%h %G? %s' -1
```

---

### Task 4: Cloudflare API 客户端 `cf.mjs`

**Files:**
- Create: `test/fetch.mjs`
- Create: `cf.mjs`
- Test: `test/cf.test.mjs`

**Interfaces:**
- Consumes: `API` from `route.mjs`
- Produces：
  - `test/fetch.mjs`：`fakeFetch(routes: Array<[string | RegExp, Response | ((url, init) => Response)]>) → fetch-like fn`，`fn.calls: Array<{ url, init }>`；`json(body, status = 200) → Response`
  - `cf.mjs`：
    - `class CfError extends Error { status: number, codes: number[] }`
    - `cfGet(path: string, token: string, opts?: { fetchImpl?, signal? }) → Promise<object>`（整个 JSON 信封）
    - `byokSlugs(account: { account, gateway, alias, token }, opts?: { fetchImpl? }) → Promise<Set<string>>`

- [ ] **Step 1: 写测试辅助 `test/fetch.mjs`**

```js
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
```

- [ ] **Step 2: 写失败的测试 `test/cf.test.mjs`**

```js
import { describe, expect, test } from "bun:test"
import { CfError, byokSlugs, cfGet } from "../cf.mjs"
import { fakeFetch, json } from "./fetch.mjs"

const ACCOUNT = { account: "0123456789abcdef0123456789abcdef", gateway: "my-gateway", alias: "", token: "tok" }
const row = (provider_slug, alias = "default") => ({ provider_slug, alias })

describe("cfGet", () => {
  test("sends the token and returns the envelope", async () => {
    const f = fakeFetch([["/x", json({ success: true, result: [1] })]])
    const out = await cfGet("/x", "tok", { fetchImpl: f })
    expect(out.result).toEqual([1])
    expect(f.calls[0].url).toBe("https://api.cloudflare.com/client/v4/x")
    expect(new Headers(f.calls[0].init.headers).get("authorization")).toBe("Bearer tok")
  })

  test("throws CfError with the status and codes", async () => {
    const f = fakeFetch([["/x", json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 403)]])
    try {
      await cfGet("/x", "tok", { fetchImpl: f })
      throw new Error("expected CfError")
    } catch (e) {
      expect(e).toBeInstanceOf(CfError)
      expect(e.status).toBe(403)
      expect(e.codes).toEqual([10000])
      expect(e.message).not.toContain("tok")
    }
  })

  test("throws CfError on a non-JSON answer", async () => {
    const f = fakeFetch([["/x", new Response("<html>", { status: 502 })]])
    await expect(cfGet("/x", "tok", { fetchImpl: f })).rejects.toBeInstanceOf(CfError)
  })

  test("throws CfError when a 200 says success: false", async () => {
    const f = fakeFetch([["/x", json({ success: false, errors: [] })]])
    await expect(cfGet("/x", "tok", { fetchImpl: f })).rejects.toBeInstanceOf(CfError)
  })
})

describe("byokSlugs", () => {
  test("keeps slugs whose alias matches the account's (empty = default)", async () => {
    const f = fakeFetch([
      ["/provider_configs", json({ success: true, result: [row("openai"), row("anthropic", "team"), row("grok")] })],
    ])
    expect([...(await byokSlugs(ACCOUNT, { fetchImpl: f }))].sort()).toEqual(["grok", "openai"])
    expect([...(await byokSlugs({ ...ACCOUNT, alias: "team" }, { fetchImpl: f }))]).toEqual(["anthropic"])
  })

  test("reads every page", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => row(`p${i}`))
    const f = fakeFetch([
      ["page=1&", json({ success: true, result: page1 })],
      ["page=2&", json({ success: true, result: [row("openai")] })],
    ])
    const slugs = await byokSlugs(ACCOUNT, { fetchImpl: f })
    expect(slugs.size).toBe(51)
    expect(f.calls.length).toBe(2)
  })

  test("passes a 401 on as CfError", async () => {
    const f = fakeFetch([["/provider_configs", json({ success: false, errors: [{ code: 10000 }] }, 401)]])
    await expect(byokSlugs(ACCOUNT, { fetchImpl: f })).rejects.toMatchObject({ status: 401 })
  })
})
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `bun test test/cf.test.mjs`
Expected: FAIL，找不到 `../cf.mjs`。

- [ ] **Step 4: 写 `cf.mjs`**

```js
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
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `bun test test/cf.test.mjs`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add cf.mjs test/cf.test.mjs test/fetch.mjs
git commit -F - <<'EOF'
feat: read the gateway's stored provider keys

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
git log --format='%h %G? %s' -1
```

---

### Task 5: 模型列表 `models.mjs`

**Files:**
- Create: `models.mjs`
- Test: `test/models.test.mjs`

**Interfaces:**
- Consumes: `PROVIDER`、`NPM`、`VENDORS`、`protocolFor`、`vendorByPrefix`（vendors）；`GATEWAY`、`PLACEHOLDER`（route）；`byokSlugs`、`CfError`（cf）；`fakeFetch`、`json`（test/fetch.mjs）
- Produces（`models.mjs`）：
  - `MODELS_DEV`、`CACHE_TTL`、`DEFAULT_LIMIT = { context: 128000, output: 16384 }`
  - `parseList(format: "openai" | "anthropic" | "gemini", json) → Array<{ id, name?, limit? }>`
  - `isTextModel(id: string, meta?: object) → boolean`
  - `loadCatalog({ directory?, fetchImpl?, now? }) → Promise<{ [catalog]: { models: { [id]: meta } } }>`
  - `buildModel(vendor, entry, meta, mode) → OpenCode Model`（键 `id` = `<prefix>/<native id>`）
  - `liveList(vendor, account, fetchImpl?) → Promise<Array<entry> | null>`
  - `listModels({ account, directory?, fetchImpl?, log? }) → Promise<{ [key]: Model }>`；token 被拒时抛出带 `signIn: "expired"` 的错误

- [ ] **Step 1: 写失败的测试 `test/models.test.mjs`**

```js
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CACHE_TTL,
  DEFAULT_LIMIT,
  buildModel,
  isTextModel,
  listModels,
  loadCatalog,
  parseList,
} from "../models.mjs"
import { NPM, vendorByPrefix } from "../vendors.mjs"
import { fakeFetch, json } from "./fetch.mjs"

const ACCOUNT = {
  token: "tok",
  account: "0123456789abcdef0123456789abcdef",
  gateway: "my-gateway",
  mode: "native",
  alias: "",
}

const CATALOG = {
  openai: { models: {} },
  anthropic: {
    models: {
      "claude-x": {
        id: "claude-x",
        name: "Claude X (models.dev)",
        limit: { context: 200000, output: 64000 },
        reasoning: true,
        reasoning_options: [{ type: "budget_tokens", min: 1024 }],
        tool_call: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      },
    },
  },
  google: {
    models: {
      "gemini-x": {
        id: "gemini-x",
        name: "Gemini X",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high"] }],
      },
    },
  },
  deepseek: { models: {} },
  xai: {
    models: {
      "grok-9": { id: "grok-9", name: "Grok 9", limit: { context: 256000, output: 32000 } },
      "grok-old": { id: "grok-old", name: "Grok Old", status: "deprecated" },
      "grok-imagine": { id: "grok-imagine", modalities: { input: ["text"], output: ["image"] } },
    },
  },
}

let dir
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cf-aig-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("parseList", () => {
  test("reads OpenAI-style lists", () => {
    expect(parseList("openai", { data: [{ id: "gpt-x" }, { id: "" }, {}] })).toEqual([{ id: "gpt-x", name: undefined }])
  })

  test("reads Anthropic's display names", () => {
    expect(parseList("anthropic", { data: [{ id: "claude-x", display_name: "Claude X" }] })).toEqual([
      { id: "claude-x", name: "Claude X" },
    ])
  })

  test("reads Gemini's generateContent models with their limits", () => {
    const out = parseList("gemini", {
      models: [
        {
          name: "models/gemini-x",
          displayName: "Gemini X",
          inputTokenLimit: 1000000,
          outputTokenLimit: 65536,
          supportedGenerationMethods: ["generateContent"],
        },
        { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
      ],
    })
    expect(out).toEqual([{ id: "gemini-x", name: "Gemini X", limit: { context: 1000000, output: 65536 } }])
  })

  test("returns nothing for a malformed answer", () => {
    expect(parseList("openai", null)).toEqual([])
    expect(parseList("gemini", { models: "x" })).toEqual([])
  })
})

describe("isTextModel", () => {
  test("keeps chat models and drops the rest", () => {
    expect(isTextModel("gpt-5.5")).toBe(true)
    for (const id of ["text-embedding-3", "gpt-4o-mini-tts", "tts-1", "gpt-image-1", "whisper-1", "gpt-realtime"])
      expect(isTextModel(id)).toBe(false)
  })

  test("drops deprecated models and ones that don't answer in text", () => {
    expect(isTextModel("grok-old", { status: "deprecated" })).toBe(false)
    expect(isTextModel("grok-imagine", { modalities: { output: ["image"] } })).toBe(false)
  })
})

describe("buildModel", () => {
  const anthropic = vendorByPrefix("anthropic")
  const google = vendorByPrefix("google")

  test("prefers models.dev metadata, then the live entry, then defaults", () => {
    const m = buildModel(
      anthropic,
      { id: "claude-x", name: "Claude X (live)", limit: { context: 100 } },
      CATALOG.anthropic.models["claude-x"],
      "native",
    )
    expect(m.id).toBe("anthropic/claude-x")
    expect(m.providerID).toBe("cloudflare-ai-gateway")
    expect(m.name).toBe("Claude X (models.dev)")
    expect(m.limit).toEqual({ context: 200000, output: 64000 })
    expect(m.api).toEqual({
      id: "anthropic/claude-x",
      url: "https://cloudflare-ai-gateway.invalid",
      npm: NPM.messages,
    })
    expect(m.capabilities.reasoning).toBe(true)
    expect(m.capabilities.input.image).toBe(true)
    expect(m.cost).toEqual({ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } })
    expect(Object.keys(m.variants)).toEqual(["low", "medium", "high"])
  })

  test("uses the live entry and defaults without metadata", () => {
    const m = buildModel(google, { id: "gemini-y", name: "Gemini Y", limit: { context: 1000000 } }, undefined, "native")
    expect(m.name).toBe("Gemini Y")
    expect(m.limit).toEqual({ context: 1000000, output: DEFAULT_LIMIT.output })
    expect(m.capabilities.toolcall).toBe(true)
    expect(m.capabilities.reasoning).toBe(false)
    expect(m.variants).toEqual({})
  })

  test("turns effort options into variants", () => {
    const m = buildModel(google, { id: "gemini-x" }, CATALOG.google.models["gemini-x"], "native")
    expect(m.variants).toEqual({ low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } })
  })

  test("declares the API by mode", () => {
    expect(buildModel(google, { id: "gemini-x" }, undefined, "native").api.npm).toBe(NPM.gemini)
    expect(buildModel(google, { id: "gemini-x" }, undefined, "rest").api.npm).toBe(NPM.chat)
  })
})

describe("loadCatalog", () => {
  test("fetches models.dev once and keeps only the vendors' catalogs", async () => {
    const f = fakeFetch([["models.dev", json({ ...CATALOG, mistral: { models: { m: {} } } })]])
    const first = await loadCatalog({ directory: dir, fetchImpl: f, now: () => 1000 })
    expect(Object.keys(first).sort()).toEqual(["anthropic", "deepseek", "google", "openai", "xai"])
    const second = await loadCatalog({ directory: dir, fetchImpl: f, now: () => 1000 + CACHE_TTL - 1 })
    expect(second).toEqual(first)
    expect(f.calls.length).toBe(1)
    const saved = JSON.parse(await readFile(join(dir, "cloudflare-ai-gateway-auth", "models-dev.json"), "utf8"))
    expect(saved.fetchedAt).toBe(1000)
  })

  test("falls back to a stale cache when models.dev is down", async () => {
    await loadCatalog({ directory: dir, fetchImpl: fakeFetch([["models.dev", json(CATALOG)]]), now: () => 0 })
    const down = fakeFetch([["models.dev", new Response("", { status: 503 })]])
    const out = await loadCatalog({ directory: dir, fetchImpl: down, now: () => CACHE_TTL * 2 })
    expect(out.xai.models["grok-9"].name).toBe("Grok 9")
  })

  test("throws with neither models.dev nor a cache", async () => {
    const down = fakeFetch([["models.dev", new Response("", { status: 503 })]])
    await expect(loadCatalog({ directory: dir, fetchImpl: down, now: () => 0 })).rejects.toThrow()
  })
})

describe("listModels", () => {
  const configs = (rows) => ["/provider_configs", json({ success: true, result: rows })]
  const row = (provider_slug, alias = "default") => ({ provider_slug, alias })

  test("lists the vendors with keys, live first and models.dev when live fails", async () => {
    const f = fakeFetch([
      configs([row("anthropic"), row("grok"), row("openai", "team")]),
      ["/anthropic/v1/models", json({ data: [{ id: "claude-x" }, { id: "claude-embed-1" }] })],
      ["/grok/v1/models", new Response("", { status: 500 })],
      ["models.dev", json(CATALOG)],
    ])
    const logs = []
    const models = await listModels({
      account: ACCOUNT,
      directory: dir,
      fetchImpl: f,
      log: (level, message) => logs.push([level, message]),
    })
    expect(Object.keys(models).sort()).toEqual(["anthropic/claude-x", "xai/grok-9"])
    expect(models["anthropic/claude-x"].name).toBe("Claude X (models.dev)")
    expect(models["xai/grok-9"].api.npm).toBe(NPM.chat)
    expect(logs.some(([level]) => level === "warn")).toBe(true)
    const list = f.calls.find((c) => c.url.includes("/anthropic/v1/models"))
    const headers = new Headers(list.init.headers)
    expect(headers.get("cf-aig-authorization")).toBe("Bearer tok")
    expect(headers.get("anthropic-version")).toBe("2023-06-01")
    expect(JSON.stringify(logs)).not.toContain("tok")
  })

  test("a refused token expires the sign-in", async () => {
    const f = fakeFetch([["/provider_configs", json({ success: false, errors: [{ code: 10000 }] }, 401)]])
    await expect(listModels({ account: ACCOUNT, directory: dir, fetchImpl: f })).rejects.toMatchObject({
      signIn: "expired",
    })
  })

  test("without permission to read keys, every vendor is tried", async () => {
    const f = fakeFetch([
      ["/provider_configs", json({ success: false, errors: [{ code: 10000 }] }, 403)],
      ["/openai/models", json({ data: [{ id: "gpt-x" }] })],
      ["models.dev", json(CATALOG)],
    ])
    const models = await listModels({ account: ACCOUNT, directory: dir, fetchImpl: f })
    expect(models["openai/gpt-x"]).toBeDefined()
    expect(models["google/gemini-x"]).toBeDefined()
    expect(models["xai/grok-9"]).toBeDefined()
  })

  test("a gateway with no keys lists nothing", async () => {
    const f = fakeFetch([configs([]), ["models.dev", json(CATALOG)]])
    expect(await listModels({ account: ACCOUNT, directory: dir, fetchImpl: f })).toEqual({})
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `bun test test/models.test.mjs`
Expected: FAIL，找不到 `../models.mjs`。

- [ ] **Step 3: 写 `models.mjs`**

```js
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { CfError, byokSlugs } from "./cf.mjs"
import { GATEWAY, PLACEHOLDER } from "./route.mjs"
import { NPM, PROVIDER, VENDORS, protocolFor } from "./vendors.mjs"

export const MODELS_DEV = "https://models.dev/api.json"
export const CACHE_TTL = 6 * 60 * 60 * 1000
export const DEFAULT_LIMIT = { context: 128000, output: 16384 }

// Ids of models that don't chat, after magpie's own textModel.
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

export function isTextModel(id, meta) {
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
    if (e instanceof CfError && e.status === 401)
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
      if (!isTextModel(entry.id, meta)) continue
      const model = buildModel(vendor, entry, meta, account.mode)
      models[model.id] = model
    }
  })
  return models
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `bun test test/models.test.mjs`
Expected: 全部 PASS。

- [ ] **Step 5: 跑全部测试**

Run: `bun test`
Expected: vendors / route / errors / cf / models 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add models.mjs test/models.test.mjs
git commit -F - <<'EOF'
feat: list models from the gateway's keys, live or from models.dev

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
git log --format='%h %G? %s' -1
```

---

### Task 6: 插件入口 `index.mjs`

**Files:**
- Create: `index.mjs`
- Test: `test/index.test.mjs`

**Interfaces:**
- Consumes: `annotate`、`localError`（errors）；`listModels`（models）；`PLACEHOLDER`、`RouteError`、`route`（route）；`NPM`、`PROVIDER`（vendors）；`fakeFetch`、`json`（test/fetch.mjs）
- Produces：
  - `export default { id: "cloudflare-ai-gateway", server }`，`server(input, options) → Promise<hooks>`
  - `export const _internal = { PROMPTS, normalize, signIn, accountOf, send }`
    - `normalize(inputs) → { account, gateway, mode, alias }`
    - `signIn(inputs) → { type: "success", metadata } | { type: "failed", error }`
    - `accountOf(auth) → { token, account, gateway, mode, alias }`（缺字段时抛出带 `signIn: "expired"` 的错误）
    - `send(input, init, account, settings, fetchImpl?) → Promise<Response>`

- [ ] **Step 1: 写失败的测试 `test/index.test.mjs`**

```js
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin, { _internal } from "../index.mjs"
import { GATEWAY, PLACEHOLDER } from "../route.mjs"
import { fakeFetch, json } from "./fetch.mjs"

const ACCT = "0123456789abcdef0123456789abcdef"
const AUTH = { type: "api", key: "tok", metadata: { account: ACCT, gateway: "my-gateway", mode: "native", alias: "" } }
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

describe("signIn", () => {
  test("normalizes the answers and names the account", () => {
    const r = _internal.signIn({ account: ` ${ACCT.toUpperCase()} `, gateway: " my-gateway ", mode: "native", alias: " default " })
    expect(r).toEqual({
      type: "success",
      metadata: { account: ACCT, gateway: "my-gateway", mode: "native", alias: "", email: `my-gateway · ${ACCT.slice(0, 8)}` },
    })
  })

  test("keeps a real alias in native mode and drops it in REST mode", () => {
    expect(_internal.signIn({ account: ACCT, gateway: "g", mode: "native", alias: "team" }).metadata.alias).toBe("team")
    expect(_internal.signIn({ account: ACCT, gateway: "g", mode: "rest", alias: "team" }).metadata.alias).toBe("")
  })

  test("treats a missing mode as native", () => {
    expect(_internal.signIn({ account: ACCT, gateway: "g" }).metadata.mode).toBe("native")
  })

  test("refuses a malformed account or gateway id", () => {
    expect(_internal.signIn({ account: "abc", gateway: "g" }).type).toBe("failed")
    expect(_internal.signIn({ account: ACCT, gateway: "My Gateway" }).type).toBe("failed")
    expect(_internal.signIn({ account: ACCT, gateway: "x".repeat(65) }).type).toBe("failed")
  })
})

describe("PROMPTS", () => {
  test("asks account, gateway, mode, then alias only in native mode", () => {
    expect(_internal.PROMPTS.map((p) => p.key)).toEqual(["account", "gateway", "mode", "alias"])
    expect(_internal.PROMPTS[3].when).toEqual({ key: "mode", op: "eq", value: "native" })
  })

  test("validates the account and gateway as they are typed", () => {
    const [account, gateway] = _internal.PROMPTS
    expect(account.validate(ACCT)).toBeUndefined()
    expect(typeof account.validate("nope")).toBe("string")
    expect(gateway.validate("my-gateway")).toBeUndefined()
    expect(typeof gateway.validate("bad gateway")).toBe("string")
  })
})

describe("accountOf", () => {
  test("reads a saved sign-in", () => {
    expect(_internal.accountOf(AUTH)).toEqual({ token: "tok", account: ACCT, gateway: "my-gateway", mode: "native", alias: "" })
  })

  test("asks for a new sign-in when the metadata is gone", () => {
    expect(() => _internal.accountOf({ type: "api", key: "tok" })).toThrow()
    try {
      _internal.accountOf({ type: "api", key: "tok" })
    } catch (e) {
      expect(e.signIn).toBe("expired")
    }
  })
})

describe("send", () => {
  const account = _internal.accountOf(AUTH)

  test("answers an unroutable request locally without calling out", async () => {
    const f = fakeFetch([])
    const res = await _internal.send(
      `${PLACEHOLDER}/messages`,
      { method: "POST", body: JSON.stringify({ model: "mistral/large" }) },
      account,
      {},
      f,
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error.type).toBe("invalid_request_error")
    expect(f.calls.length).toBe(0)
  })

  test("routes and marks Cloudflare's refusal", async () => {
    const f = fakeFetch([["/anthropic/v1/messages", json({ success: false, error: [{ code: 2009 }] }, 401)]])
    const res = await _internal.send(
      `${PLACEHOLDER}/messages`,
      { method: "POST", headers: { "x-api-key": "tok" }, body: JSON.stringify({ model: "anthropic/claude-x" }) },
      account,
      {},
      f,
    )
    expect(f.calls[0].url).toBe(`${GATEWAY}/${ACCT}/my-gateway/anthropic/v1/messages`)
    expect(res.headers.get("x-magpie-sign-in")).toBe("expired")
  })
})

describe("server hooks", () => {
  test("config declares the provider without overwriting the user's", async () => {
    const hooks = await plugin.server({}, undefined)
    const cfg = {}
    await hooks.config(cfg)
    expect(cfg.provider["cloudflare-ai-gateway"].api).toBe(PLACEHOLDER)
    const mine = { provider: { "cloudflare-ai-gateway": { name: "mine" } } }
    await hooks.config(mine)
    expect(mine.provider["cloudflare-ai-gateway"]).toEqual({ name: "mine" })
  })

  test("the loader sends through Cloudflare with the account's token", async () => {
    const f = fakeFetch([["/anthropic/v1/messages", json({ ok: true })]])
    globalThis.fetch = f
    const hooks = await plugin.server({}, {})
    const loaded = await hooks.auth.loader(async () => AUTH)
    expect(loaded.baseURL).toBe(PLACEHOLDER)
    const res = await loaded.fetch(`${PLACEHOLDER}/messages`, {
      method: "POST",
      headers: { "x-api-key": "tok" },
      body: JSON.stringify({ model: "anthropic/claude-x", max_tokens: 1 }),
    })
    expect(res.status).toBe(200)
    const headers = new Headers(f.calls[0].init.headers)
    expect(headers.get("cf-aig-authorization")).toBe("Bearer tok")
    expect(headers.get("cf-aig-no-wholesale")).toBe("true")
  })

  test("allowUnifiedBilling in the plugin's options drops cf-aig-no-wholesale", async () => {
    const f = fakeFetch([["/anthropic/v1/messages", json({ ok: true })]])
    globalThis.fetch = f
    const hooks = await plugin.server({}, { allowUnifiedBilling: true })
    const loaded = await hooks.auth.loader(async () => AUTH)
    await loaded.fetch(`${PLACEHOLDER}/messages`, { method: "POST", body: JSON.stringify({ model: "anthropic/claude-x" }) })
    expect(new Headers(f.calls[0].init.headers).get("cf-aig-no-wholesale")).toBeNull()
  })

  test("the loader gives nothing without an API sign-in", async () => {
    const hooks = await plugin.server({}, {})
    expect(await hooks.auth.loader(async () => undefined)).toEqual({})
  })

  test("models keeps magpie's list, marked, when nothing is listed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cf-aig-"))
    try {
      globalThis.fetch = fakeFetch([["/provider_configs", json({ success: true, result: [] })]])
      const hooks = await plugin.server({ directory: dir }, {})
      const given = { models: { "anthropic/claude-x": { id: "anthropic/claude-x" } } }
      const out = await hooks.provider.models(given, { auth: AUTH })
      expect(Object.keys(out)).toEqual(["anthropic/claude-x"])
      expect(out[Symbol.for("magpie.fellBack")]).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("models returns the given list without an API sign-in", async () => {
    const hooks = await plugin.server({}, {})
    const given = { models: { a: {} } }
    expect(await hooks.provider.models(given, {})).toBe(given.models)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `bun test test/index.test.mjs`
Expected: FAIL，找不到 `../index.mjs`。

- [ ] **Step 3: 写 `index.mjs`**

```js
import { annotate, localError } from "./errors.mjs"
import { listModels } from "./models.mjs"
import { PLACEHOLDER, RouteError, route } from "./route.mjs"
import { NPM, PROVIDER } from "./vendors.mjs"

const ACCOUNT_RE = /^[0-9a-f]{32}$/
// Cloudflare's own pattern for a gateway id
const GATEWAY_RE = /^[a-z0-9_]+(?:-[a-z0-9_]+)*$/
const ACCOUNT_HINT = "The account ID is 32 hexadecimal characters (Cloudflare dashboard → Account home)."
const GATEWAY_HINT = "The gateway ID is the gateway's name in AI Gateway, such as my-gateway."

const accountOk = (v) => ACCOUNT_RE.test(String(v ?? "").trim().toLowerCase())
const gatewayOk = (v) => {
  const s = String(v ?? "").trim()
  return s.length <= 64 && GATEWAY_RE.test(s)
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
  // magpie names an API-key account by metadata.email
  return { type: "success", metadata: { ...md, email: `${md.gateway} · ${md.account.slice(0, 8)}` } }
}

const expired = (message) => Object.assign(new Error(message), { signIn: "expired" })

function accountOf(auth) {
  if (auth?.type !== "api" || !auth.key) throw expired("Sign in with a Cloudflare API token")
  const md = normalize(auth.metadata)
  if (!accountOk(md.account) || !gatewayOk(md.gateway)) throw expired("This sign-in has no account or gateway; sign in again")
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
        const models = await listModels({ account: accountOf(auth), directory: input?.directory, log })
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
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `bun test test/index.test.mjs`
Expected: 全部 PASS。

- [ ] **Step 5: 跑全部测试**

Run: `bun test`
Expected: 全部 PASS，0 fail。

- [ ] **Step 6: Commit**

```bash
git add index.mjs test/index.test.mjs
git commit -F - <<'EOF'
feat: wire the magpie hooks for sign-in, requests and models

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
git log --format='%h %G? %s' -1
```

---

### Task 7: 沙箱集成测试与 BYOK 验证

**Files:**
- Create: `scripts/sandbox.sh`
- Create: `scripts/logs.mjs`
- Modify: spec「实测记录」节（追加 V8 与集成结果）

**Interfaces:**
- Consumes: 完整插件（Task 1–6）、`.env.local`、Task 0 报告里每个厂商选中的模型（`probe-report.json` 的 `picked`）
- Produces: 集成测试结论；V8 结论

- [ ] **Step 1: 写 `scripts/sandbox.sh`**

```bash
#!/usr/bin/env bash
# Integration check: runs magpie with a throwaway HOME, this folder as its
# plugin and an account seeded from .env.local, then tests each model given.
# Usage: scripts/sandbox.sh <native|rest> <model key>...
set -euo pipefail
mode=${1:?usage: scripts/sandbox.sh <native|rest> <model key>...}
shift
root=$(cd "$(dirname "$0")/.." && pwd)
sb=$(mktemp -d)
trap 'rm -rf "$sb"' EXIT
m() { env HOME="$sb" XDG_CONFIG_HOME="$sb/.config" XDG_CACHE_HOME="$sb/.cache" MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }

mkdir -p "$sb/.config/magpie"
# Seed the sign-in the way magpie keeps it (plugin-auth.json), so the token
# is never typed or echoed. authorize() is covered by the unit tests.
(cd "$root" && MODE="$mode" OUT="$sb/.config/magpie/plugin-auth.json" bun --env-file=.env.local -e '
  const { CF_API_TOKEN: key, CF_ACCOUNT_ID: account, CF_GATEWAY_ID: gateway, MODE: mode, OUT: out } = process.env
  const metadata = { account, gateway, mode, alias: "", email: `${gateway} · ${account.slice(0, 8)}` }
  await Bun.write(out, JSON.stringify({ "cloudflare-ai-gateway": { type: "api", key, metadata } }))
')
chmod 600 "$sb/.config/magpie/plugin-auth.json"

m plugin add "$root" </dev/null
m plugin --json >"$root/.sandbox-plugin.json"
echo "plugin listing saved to .sandbox-plugin.json"
status=0
for model in "$@"; do
  m provider test cloudflare-ai-gateway "$model" || { echo "FAILED: $model"; status=1; }
done
exit $status
```

Run: `chmod +x scripts/sandbox.sh`

- [ ] **Step 2: 写 `scripts/logs.mjs`**

```js
#!/usr/bin/env bun
// Prints the gateway's latest logs, to check the plugin's requests went
// through it. Run with: bun --env-file=.env.local scripts/logs.mjs
const { CF_API_TOKEN: token, CF_ACCOUNT_ID: account, CF_GATEWAY_ID: gateway } = process.env
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/ai-gateway/gateways/${gateway}/logs`
const headers = { authorization: `Bearer ${token}` }
const res = await fetch(`${base}?per_page=20&order_by=created_at&order_by_direction=desc`, { headers })
const body = await res.json()
if (!body.success) {
  console.error(JSON.stringify(body.errors))
  process.exit(1)
}
console.table(
  body.result.map(({ created_at, provider, model, path, status_code, success, cost }) => ({
    created_at,
    provider,
    model,
    path,
    status_code,
    success,
    cost,
  })),
)
const first = body.result[0]
if (first) {
  const detail = await (await fetch(`${base}/${first.id}`, { headers })).json()
  console.log("detail fields:", Object.keys(detail.result ?? {}).join(", "))
}
```

- [ ] **Step 3: 跑原生模式**

从 `probe-report.json` 的 `picked` 取每个厂商的模型，按 `<prefix>/<id>` 组成参数（例如 `anthropic/<picked.anthropic>`，xAI 用 `xai/<picked.xai>`）。

Run: `scripts/sandbox.sh native anthropic/<id> openai/<id> google/<id> deepseek/<id> xai/<id>`
Expected:
- `.sandbox-plugin.json` 中 `cloudflare-ai-gateway` 列出这 5 家（仅限网关上有 key 的）的模型，且无加载错误；
- 每个 `provider test` 显示 ✓；
- 若 Google 失败且错误显示 URL 中模型 ID 被编码或拆错 → 这是 V8，修 `route.mjs` 的 `GEMINI` 解析并补测试后重跑。

- [ ] **Step 4: 跑 REST 模式**

Run: `scripts/sandbox.sh rest anthropic/<id> openai/<id> deepseek/<id> xai/<id> google/<id>`
Expected: 每个 ✓（Task 0 判定 REST 不支持的厂商除外，应显示插件的本地 400 信息）。

- [ ] **Step 5: 看网关日志**

Run: `bun --env-file=.env.local scripts/logs.mjs`
Expected: 最近的日志包含 Step 3/4 的请求，`success` 为 true。结合 V5（`cf-aig-no-wholesale` 生效）与 route 测试（每个请求都带该头），可推出这些请求只可能使用 BYOK。若 `detail fields` 中出现计费方式相关字段，记录其值。

- [ ] **Step 6: 记录并提交**

在 spec「实测记录」节追加：V8 结论、两种模式的 `provider test` 结果表、日志检查结论。

```bash
git add scripts/sandbox.sh scripts/logs.mjs docs/superpowers/specs/2026-10-08-cloudflare-ai-gateway-byok-plugin-design.md
git commit -F - <<'EOF'
test: add sandbox integration and gateway log checks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
git log --format='%h %G? %s' -1
```

---

### Task 8: README 与包元数据

**Files:**
- Create: `README.md`
- Modify: `package.json`（加 `magpie.icon`）

**Interfaces:**
- Consumes: Task 0 / 7 的结论（V4 权限、V5、各厂商是否支持两种模式）
- Produces: 发布用文档

- [ ] **Step 1: 在 `package.json` 加图标**

在 `package.json` 顶层加入（通用云朵，不是 Cloudflare 商标图形）：

```json
"magpie": {
  "icon": "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='%23F38020' d='M7 19a5 5 0 0 1-.7-9.95A6.5 6.5 0 0 1 18.6 9.1 4.5 4.5 0 0 1 17.5 19z'/></svg>"
}
```

Run: `bun -e 'JSON.parse(await Bun.file("package.json").text()); console.log("ok")'`
Expected: `ok`

- [ ] **Step 2: 写 `README.md`**

````markdown
# opencode-cloudflare-ai-gateway-auth

A [magpie](https://usemagpie.ai) provider plugin that sends your requests through
[Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) and pays for
them with the provider keys stored in your gateway (BYOK), not Cloudflare's Unified
Billing. It also lists the models your gateway can reach.

> Not affiliated with or endorsed by Cloudflare.

## What you need

- A Cloudflare AI Gateway with authentication on, and provider keys stored under
  **Provider Keys** (BYOK). Turning on **Require provider credentials** (`byok_only`)
  is recommended.
- A Cloudflare API token with **Account → AI Gateway → Run** and
  **Account → AI Gateway → Read**. <!-- Task 0 V4: add "Workers AI → Read" here if the REST mode needs it -->
- magpie 0.1.1110 or later.

## Install

```sh
magpie plugin add opencode-cloudflare-ai-gateway-auth
```

or, in the app, **Plugins → Add a plugin**.

## Sign in

```sh
magpie plugin login cloudflare-ai-gateway
```

| Field | What to enter |
|---|---|
| Cloudflare API token | The token above |
| Cloudflare account ID | 32 hex characters, from the dashboard's account home |
| AI Gateway ID | Your gateway's name, e.g. `my-gateway` |
| Upstream endpoint | **Native provider endpoints** (recommended) or **Cloudflare REST API** |
| BYOK key alias | Native mode only; leave empty for the `default` key |

Each sign-in is one gateway. Sign in again for another gateway; magpie fails over
between them. The sign-in is kept in magpie's `plugin-auth.json` (mode 600).

## Models

Models are named `<vendor>/<model>`; agents reach them as
`cloudflare-ai-gateway/<vendor>/<model>`, e.g.
`cloudflare-ai-gateway/anthropic/claude-sonnet-5.5`.

| Vendor | Prefix | Native mode API | REST mode API |
|---|---|---|---|
| OpenAI | `openai/` | Responses | Responses |
| Anthropic | `anthropic/` | Messages | Messages |
| Google AI Studio | `google/` | Gemini | Chat Completions |
| DeepSeek | `deepseek/` | Chat Completions | Chat Completions |
| xAI | `xai/` | Chat Completions | Chat Completions |

<!-- Task 0 / Task 7: drop or mark any cell the probe found unsupported -->

Only vendors your gateway holds a key for are listed. Each vendor's list comes from
the vendor itself, through the gateway; when that fails, from
[models.dev](https://models.dev), which also supplies context windows, reasoning
levels and prices.

## Native vs REST mode

- **Native** sends each vendor's own API to
  `gateway.ai.cloudflare.com/v1/<account>/<gateway>/<provider>/…`. Nothing is
  translated, so prompt caching, extended thinking and the Responses API reach the
  vendor as they are. Use this for Claude Code and Codex.
- **REST** sends to `api.cloudflare.com/client/v4/accounts/<account>/ai/v1/…` with
  `cf-aig-gateway-id`. It has no key aliases and no Gemini API.

## Billing safety

Every request carries `cf-aig-no-wholesale: true`, so a vendor without a stored key
fails with 400 instead of falling back to Unified Billing. To allow the fallback:

```sh
magpie plugin options opencode-cloudflare-ai-gateway-auth '{"allowUnifiedBilling": true}'
```

## Troubleshooting

| You see | Meaning |
|---|---|
| The account asks to sign in again | Cloudflare refused the API token: check it hasn't expired and has AI Gateway Run and Read |
| 400 from a vendor | The gateway has no key for it under your alias, or it isn't allowed |
| 401 from a vendor, account still signed in | The vendor refused the key stored in the gateway |
| A model is missing | Its vendor has no key in the gateway, or it isn't a chat model |

## Development

```sh
bun test
bun --env-file=.env.local scripts/probe.mjs   # live checks, needs .env.local
scripts/sandbox.sh native anthropic/<model>   # magpie in a throwaway HOME
```

## License

MIT
````

按 Task 0 / 7 的结论处理 README 里的两条 HTML 注释（填入或删除对应内容），然后删除注释本身。

- [ ] **Step 3: 检查打包内容**

Run: `npm pack --dry-run 2>&1 | sed -n '/Tarball Contents/,/Tarball Details/p'`
Expected: 只包含 `LICENSE`、`README.md`、`cf.mjs`、`errors.mjs`、`index.mjs`、`models.mjs`、`package.json`、`route.mjs`、`vendors.mjs`；没有 `docs/`、`test/`、`scripts/`、`.env.local`。

- [ ] **Step 4: 跑全部测试**

Run: `bun test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add README.md package.json
git commit -F - <<'EOF'
docs: add README and plugin icon

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
git log --format='%h %G? %s' -1
```

---

### Task 9: 发布（每一步先征得用户同意）

**Files:**
- Modify: `package.json`（`repository`、`homepage`、`bugs`）

**Interfaces:**
- Consumes: 全部已提交内容
- Produces: GitHub 公开仓库、npm 包

- [ ] **Step 1: 确认 GitHub 账号并征得同意**

Run: `gh api user --jq .login`
把结果 `<owner>` 告诉用户，询问：「在 `<owner>/opencode-cloudflare-ai-gateway-auth` 建公开仓库（暂不推送）？」得到明确同意后继续。

- [ ] **Step 2: 建仓库**

```bash
gh repo create <owner>/opencode-cloudflare-ai-gateway-auth --public --source . --remote origin \
  --description "magpie provider plugin: Cloudflare AI Gateway with your own provider keys (BYOK)"
```

- [ ] **Step 3: 写入仓库元数据并提交**

在 `package.json` 顶层加入：

```json
"repository": { "type": "git", "url": "git+https://github.com/<owner>/opencode-cloudflare-ai-gateway-auth.git" },
"homepage": "https://github.com/<owner>/opencode-cloudflare-ai-gateway-auth#readme",
"bugs": { "url": "https://github.com/<owner>/opencode-cloudflare-ai-gateway-auth/issues" }
```

```bash
git add package.json
git commit -F - <<'EOF'
chore: add repository metadata

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 4: 校验签名并征得同意后推送**

Run: `git log --format='%h %G? %ae %s' main`
Expected: 每一行第二列都是 `G`，邮箱都是 `4sh0u0@linux.com`。有任何非 `G` → 停止，告诉用户，不推送。

全部为 `G` 时，询问用户「推送 main 到 origin？」，同意后：

```bash
git push -u origin main
gh repo edit <owner>/opencode-cloudflare-ai-gateway-auth --add-topic magpie-plugin --add-topic opencode-plugin --add-topic cloudflare
```

- [ ] **Step 5: npm 发布（由用户执行或明确授权）**

Run: `npm whoami`
- 未登录：请用户自己运行 `npm login`。
- 已登录：询问用户「以 `<npm 用户名>` 发布 `opencode-cloudflare-ai-gateway-auth@0.1.0`？」，同意后运行 `npm publish --access public`（如需 2FA 验证码，请用户自己输入）。

- [ ] **Step 6: 安装验证**

Run: `magpie plugin add opencode-cloudflare-ai-gateway-auth`（在用户真实 magpie 中，经用户同意）
然后请用户在 magpie 里登录，分别用 Claude Code 和 Codex 完成一次带工具调用的对话（spec 1.3 第 4 条）。
