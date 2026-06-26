# 🔌 pi-xiaomi-mimo-provider

**Xiaomi MiMo models through [MiMo API](https://platform.xiaomimimo.com) with vLLM payload inspection hooks**

_MiMo-V2.5-Pro, MiMo-V2.5, MiMo-V2-Flash — with DeepSeek-style thinking and multi-turn reasoning preservation for [pi](https://github.com/earendil-works/pi-coding-agent)._

📎 **[Architecture & Sequence Diagrams](docs/architecture.md)**

📖 **[DeepWiki](https://app.devin.ai/org/isaiya-9bf81eafd4d3/wiki/hazrid93/pi-xiaomi-mimo-provider?branch=main)**


## What This Plugin Does

This is a **learning and reverse-engineering plugin** for understanding how Pi communicates with Xiaomi MiMo's OpenAI-compatible API.

It registers Xiaomi MiMo as a custom Pi provider and instruments **6 hooks** that log the full data flow between Pi and Xiaomi:

| Hook | What it inspects |
|------|-----------------|
| `before_provider_request` | Full outgoing payload — thinking, tools, reasoning_content replay, temperature |
| `after_provider_response` | HTTP status, response headers, rate limiting |
| `context` | Full conversation context with message-by-message breakdown |
| `message_end` | Finalized assistant messages including reasoning_content |
| `tool_call` | Parsed tool calls before execution |
| `tool_result` | Tool results before they're sent back to the LLM |

## Models

<!-- MODELS_TABLE_START -->
| Model | ID | Reasoning | Input | Context | Output | Notes |
|-------|----|-----------|-------|---------|--------|-------|
| MiMo-V2-Flash | `mimo-v2-flash` | Yes | text | 262K | 66K | Fast model. Thinking off by default (`thinking.type: disabled`). Returns `reasoning_content` when thinking enabled. |
| MiMo-V2.5 | `mimo-v2.5` | Yes | text, image | 1049K | 131K | Omni model (text + image). Thinking always on by default. Returns `reasoning_content`. Context: 1M, output: 128K. |
| MiMo-V2.5-Pro | `mimo-v2.5-pro` | Yes | text | 1049K | 131K | Pro reasoning model. Thinking always on by default. Returns `reasoning_content`. Context: 1M, output: 128K. |
| MiMo-V2-Pro (Legacy) | `mimo-v2-pro` | Yes | text | 1049K | 131K | LEGACY — auto-routes to V2.5 after June 1 2026, fully deprecated June 30. Use `mimo-v2.5-pro` instead. |
| MiMo-V2-Omni (Legacy) | `mimo-v2-omni` | Yes | text, image | 262K | 131K | LEGACY — auto-routes to V2.5 after June 1 2026, fully deprecated June 30. Use `mimo-v2.5` instead. |
<!-- MODELS_TABLE_END -->

## Endpoints

| Provider ID | Base URL | Region |
|-------------|----------|--------|
| `xiaomi-mimo` | `https://api.xiaomimimo.com/v1` | Global |
| `xiaomi-mimo-token-plan-cn` | `https://token-plan-cn.xiaomimimo.com/v1` | China |
| `xiaomi-mimo-token-plan-ams` | `https://token-plan-ams.xiaomimimo.com/v1` | Amsterdam |
| `xiaomi-mimo-token-plan-sgp` | `https://token-plan-sgp.xiaomimimo.com/v1` | Singapore |

## Installation

### Option 1: Using `pi install` (Recommended)

```bash
pi install https://github.com/your-username/pi-xiaomi-mimo-provider
```

### Option 2: Manual Clone

```bash
git clone https://github.com/your-username/pi-xiaomi-mimo-provider.git
cd pi-xiaomi-mimo-provider
pi -e .
```

## Setup

### API Key

Add your Xiaomi MiMo API key to `~/.pi/agent/auth.json` (recommended):

```json
{
  "xiaomi-mimo": { "type": "api_key", "key": "your-api-key" },
  "xiaomi-mimo-token-plan-cn": { "type": "api_key", "key": "your-api-key" }
}
```

Or set as environment variables:

```bash
export XIAOMI_MIMO_API_KEY=your-api-key
export XIAOMI_MIMO_TOKEN_PLAN_CN_API_KEY=your-api-key
```

### Usage

```bash
pi -e /path/to/pi-xiaomi-mimo-provider
```

Then use `/model` to select from available MiMo models.

## API Notes

- Xiaomi's API is OpenAI-compatible (`/v1/chat/completions`)
- Auth via `Authorization: Bearer <key>` or `api-key: <key>` header
- Supports `developer` role (unlike many vLLM deployments)
- Uses `max_completion_tokens` (not `max_tokens`)
- `tool_choice` only supports `"auto"` — other values are silently dropped
- In thinking mode, `temperature` and `top_p` are forcibly overridden to 1.0 / 0.95 for pro models

## Reasoning / Thinking

All MiMo reasoning models use DeepSeek-style thinking:

```json
{
  "thinking": { "type": "enabled" }
}
```

Returns reasoning in `reasoning_content` field on assistant messages.

### Model-specific behavior

| Model | Default Thinking | To Enable | To Disable |
|-------|-----------------|-----------|------------|
| mimo-v2-flash | OFF | `thinking: { type: "enabled" }` | `thinking: { type: "disabled" }` |
| mimo-v2.5 | ON | default | `thinking: { type: "disabled" }` |
| mimo-v2.5-pro | ON | default | `thinking: { type: "disabled" }` |

### Multi-turn reasoning preservation

Xiaomi docs explicitly state: *"During the multi-turn tool calls process in thinking mode, the model returns a `reasoning_content` field alongside `tool_calls`. To continue the conversation, it is recommended to keep all previous `reasoning_content` in the `messages` array for each subsequent request to achieve the best performance."*

This plugin sets `requiresReasoningContentOnAssistantMessages: true` on all models, which tells Pi to preserve `reasoning_content` when replaying assistant messages in multi-turn conversations.

## Testing

### Test reasoning preservation

```bash
XIAOMI_MIMO_API_KEY=your-key npx tsx test-reasoning.ts
```

This validates:
1. `thinking: { type: "enabled" }` triggers reasoning
2. `reasoning_content` is returned on assistant messages
3. Preserving `reasoning_content` on replay maintains reasoning context
4. Multi-turn reasoning works across user → assistant → user

### Update README model table

```bash
node update-models.mjs
```

## How the hooks work

When you run `pi -e .`, watch the terminal output. You'll see:

### Before each request
```
╔══════════════════════════════════════════════════════════════
║ [pi-xiaomi-mimo] → OUTGOING PAYLOAD INSPECTION
╠══════════════════════════════════════════════════════════════
║ model:              mimo-v2.5-pro
║ thinking:           {"type":"enabled"}
║ tool_choice:        "auto"
║ tools count:        4
║ temperature:        1.0
║ max_tokens:         131072
║ ✓  Thinking ENABLED — model will return reasoning_content
║ ✓  2 assistant message(s) with reasoning_content preserved
║    └─ reasoning_content: 847 chars (Okay, the user asked me to...)
╚══════════════════════════════════════════════════════════════
```

### After each response
```
╔══════════════════════════════════════════════════════════════
║ [pi-xiaomi-mimo] ← RESPONSE INSPECTION
╠══════════════════════════════════════════════════════════════
║ status:             200
║ content-type:       text/event-stream
║ x-request-id:       8b51f9e0515949cb8207fbd35ea6ea5c
╚══════════════════════════════════════════════════════════════
```

### On each LLM call
```
╔══════════════════════════════════════════════════════════════
║ [pi-xiaomi-mimo] 📋 CONTEXT INSPECTION
╠══════════════════════════════════════════════════════════════
║ total messages:     8
║ [0] developer  You are MiMo, an AI assistant developed by ...
║ [1] user       Please help me refactor this function...
║ [2] assistant  I'll help you refactor... [✓ reasoning_content: 1234 chars]
║ [3] toolResult toolName=bash, toolCallId=call_abc123
║ ...
║ ── Summary ──
║ reasoning_content preserved: 3
║ assistant with tool_calls:   1
╚══════════════════════════════════════════════════════════════
```

## Comparing with built-in Pi Xiaomi support

Pi already has built-in Xiaomi providers (`xiaomi`, `xiaomi-token-plan-cn`, etc.). This plugin is useful for:

1. **Learning** — see exactly what Pi sends to Xiaomi's API
2. **Reverse engineering** — understand how thinking/reasoning flows work
3. **Debugging** — diagnose issues with tool calls, reasoning preservation, etc.
4. **Customization** — a base for adding your own Xiaomi-specific behavior

## Adding Custom Models

Edit `models.json` directly, or add entries to `custom-models.json`:

```json
[
  {
    "id": "mimo-custom-model",
    "name": "My Custom MiMo Model",
    "reasoning": false,
    "input": ["text"],
    "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
    "contextWindow": 128000,
    "maxTokens": 16384
  }
]
```

## License

MIT


---

## Key Features & Highlights

`pi-xiaomi-mimo-provider` is a TypeScript extension for the Pi coding agent (`@earendil-works/pi-coding-agent`) that registers Xiaomi MiMo models as OpenAI-compatible providers. Its standout quality is the depth of *observability* it builds into the Pi↔Xiaomi data flow: rather than just wiring up endpoints, it instruments every lifecycle stage.

- **OpenAI-compatible provider registration with multi-region routing** — The single `export default function (pi: ExtensionAPI)` entry point loops over a `XIAOMI_ENDPOINTS` map (`index.ts:206-211`) to register four separate providers, each pointing at a distinct base URL: `api.xiaomimimo.com/v1` (global), `token-plan-cn.xiaomimimo.com/v1` (China), `...-ams...` (Amsterdam), and `...-sgp...` (Singapore). Each provider resolves its API key via a per-endpoint env var name (`XIAOMI_API_KEY_ENV`, `index.ts:213-218`) using the `$VAR` indirection Pi understands, and all four share the same merged model list. This lets users pick the lowest-latency region without changing model configuration.

- **Three-layer model resolution: static + custom + patch override** — `buildModels()` (`index.ts:169-202`) merges `models.json` into a `Map<string, JsonModel>`, overlays `patch.json` entries via `applyPatch()` (`index.ts:131-166`), then folds in any `custom-models.json` models — again with patch application. `applyPatch` is field-by-field defensive: it only overwrites when a patch field is defined (e.g. `if (patch.contextWindow !== undefined)`), performs a merge of the existing `compat` object rather than replacing it (`result.compat = { ...(result.compat || {}), ...patch.compat }`), and even strips `thinkingFormat` and the empty `compat` object when a patch flips `reasoning: false`. The result is a single source of truth where users can override per-model behavior without touching the shipped JSON.

- **Six lifecycle inspection hooks for full vLLM payload transparency** — The extension registers `pi.on(...)` handlers for `before_provider_request`, `after_provider_response`, `context`, `message_end`, `tool_call`, and `tool_result` (`index.ts:573-736`). Each hook guards with `provider.startsWith("xiaomi-mimo")` so it never fires for unrelated providers. `inspectOutgoingPayload()` (`index.ts:245-324`) logs the model, `thinking` field, `tool_choice`, tool count, temperature/top_p, `max_completion_tokens`, and `stream_options`, then walks `messages` to count assistant entries carrying `reasoning_content` — explicitly warning if any value other than `"auto"` is passed for `tool_choice` (Xiaomi silently drops it). This is essentially a debug-level tap on the entire request/response cycle.

- **DeepSeek-style thinking + multi-turn reasoning preservation** — The model compat block sets `thinkingFormat: "deepseek"` and `requiresReasoningContentOnAssistantMessages: true` on every reasoning model (`models.json:19-20, 43-44, 67-68`). The `test-reasoning.ts` harness (lines 245-259) demonstrates the contract: turn 1 returns `reasoning_content`; turn 2 replays the assistant message *with its `reasoning_content` field intact* alongside the original `content`, honoring Xiaomi's documented recommendation that "all previous reasoning_content" be kept in the messages array for best multi-turn performance. The `inspectOutgoingPayload` hook even logs `✓ N assistant message(s) with reasoning_content preserved` when it detects the replay, giving a live correctness signal.

- **Thinking-level mapping with model-specific opt-in semantics** — `patch.json` defines a `thinkingLevelMap` per model that translates Pi's abstract effort levels (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`) into Xiaomi's concrete `thinking: { type: "enabled"|"disabled" }`. Notably `mimo-v2-flash` maps `off → "disabled"` while all four pro/v2.5/omni models map `off → null` (no value emitted), reflecting that only the Flash model disables thinking by default. Intermediate levels (`minimal`/`low`/`medium`) all map to `null` for the pro models — Xiaomi exposes only an enabled/disabled toggle, so the plugin honestly degrades the six-level effort knob down to a binary rather than inventing unsupported intermediate states.

- **Documented Xiaomi API quirks enforced via compat flags** — Rather than fighting the API, the compat block encodes Xiaomi's real constraints: `maxTokensField: "max_completion_tokens"` (not `max_tokens`), `supportsStore: false` (no conversation store), `supportsDeveloperRole: true` (a vLLM rarity — the `developer` role passes through natively), `supportsStrictMode: true` for structured outputs, and `supportsUsageInStreaming: true`. The header doc (`index.ts:27-32`) additionally warns that thinking mode forces `temperature`/`top_p` to `1.0`/`0.95` server-side for pro/omni models, and the `inspectResponseHeaders` hook surfaces `retry-after` and `x-ratelimit-remaining` headers — so rate limits are visible in logs rather than silent failures.

- **Legacy model deprecation bookkeeping** — `models.json` carries a `mimo-v2-pro` entry marked `"LEGACY — auto-routes to V2.5 after June 1 2026, fully deprecated June 30. Use mimo-v2.5-pro instead."` and a `mimo-v2-omni` entry with the same sunset schedule routing to `mimo-v2.5`. The notes field surfaces the migration inside the `/model` selection UI itself, so users are warned at the point of choice rather than discovering the deprecation from a 404.

- **Idempotent README model-table generator** — `update-models.mjs` re-implements the same `applyPatchToModel`/merge logic as `index.ts` (kept deliberately in sync, lines 27-50), then regenerates the markdown table between `<!-- MODELS_TABLE_START -->` and `<!-- MODELS_TABLE_END -->` markers in `README.md`. Because it reads the same three JSON sources the runtime uses, the documentation table can never drift from the actually-registered models — a single `npm run update-models` reconciles both. The script hard-fails (`process.exit(1)`) if the markers are missing, preventing silent README corruption.

- **Standalone reasoning-contract test harness** — `test-reasoning.ts` is a self-contained integration test (npm script `"test": "npx tsx test-reasoning.ts"`) that builds real OpenAI-compatible payloads for each of the three current models, POSTs to `/chat/completions` with `AbortController` + 120s timeout, and tracks per-model `ModelTestResult` `{turn1ReasoningPresent, turn2ReasoningPresent, ...}` fields with explicit `PASS`/`FAIL` exits. It catches `aborted` errors and reformats them as `"Timeout after Ns"`, and produces a summary table — so it doubles as a live regression check that Xiaomi's `reasoning_content` field contract hasn't silently changed.

- **Defensive payload inspection with mutability escape hatch** — The `before_provider_request` hook returns `undefined` (`index.ts:593`) with an explicit comment that returning a modified payload would rewrite the request Makora-style. The `inspectOutgoingPayload` helper reads but never mutates. This makes the inspection layer safe-by-default while leaving the door open for future payload rewriting (e.g. vLLM param translation) without restructuring, since the hook signature already supports it.
