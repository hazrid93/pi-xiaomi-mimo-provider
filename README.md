# 🔌 pi-xiaomi-mimo-provider

**Xiaomi MiMo models through [MiMo API](https://platform.xiaomimimo.com) with vLLM payload inspection hooks**

_MiMo-V2.5-Pro, MiMo-V2.5, MiMo-V2-Flash — with DeepSeek-style thinking and multi-turn reasoning preservation for [pi](https://github.com/earendil-works/pi-coding-agent)._

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
