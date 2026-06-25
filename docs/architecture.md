# pi-xiaomi-mimo-provider — Architecture

> A Pi plugin that registers Xiaomi MiMo models as a custom provider using an OpenAI-compatible API. Features DeepSeek-style thinking (`reasoning_content`), multi-turn reasoning preservation, and 6 inspection hooks that log the full data flow between Pi and Xiaomi's vLLM backend.

| | |
|---|---|
| **Language** | TypeScript · ES Modules |
| **Runtime** | Pi coding agent (in-process extension) |
| **API** | OpenAI-compatible at `https://api.xiaomimimo.com/v1` |
| **Models** | MiMo-V2-Flash, MiMo-V2.5, MiMo-V2.5-Pro (+ 2 legacy) |
| **Thinking** | DeepSeek-style — `thinking.type: enabled` returns `reasoning_content` |
| **Hooks** | 6 lifecycle hooks for full payload inspection |

---

## High-Level Architecture

```mermaid
flowchart TB
  subgraph PiHost["Pi Coding Agent"]
    PI["Pi core<br/>ExtensionAPI"]
    AUTH["~/.pi/agent/auth.json<br/>or env var XIAOMI_MIMO_API_KEY"]
  end

  subgraph Ext["Extension  (index.ts)"]
    REG["registerProvider<br/>xiaomi-mimo"]
    MODELS["models.json<br/>+ custom-models.json"]
    PATCH["patch.json<br/>model-specific overrides"]
  end

  subgraph Hooks["6 Inspection Hooks"]
    H1["before_provider_request<br/>outgoing payload"]
    H2["after_provider_response<br/>status + headers"]
    H3["context<br/>conversation context"]
    H4["message_end<br/>finalized assistant msg"]
    H5["tool_call<br/>parsed tool calls"]
    H6["tool_result<br/>tool results"]
  end

  subgraph API["Xiaomi MiMo API"]
    BASE["api.xiaomimimo.com/v1<br/>OpenAI-compatible"]
    CN["token-plan-cn<br/>China region"]
    AMS["token-plan-ams<br/>Amsterdam region"]
    SGP["token-plan-sgp<br/>Singapore region"]
  end

  PI --> REG
  AUTH --> REG
  MODELS --> REG
  PATCH --> REG
  REG --> H1
  REG --> H2
  REG --> H3
  REG --> H4
  REG --> H5
  REG --> H6
  H1 --> BASE
  BASE --> CN
  BASE --> AMS
  BASE --> SGP
```

---

## Request Lifecycle with Hooks

```mermaid
sequenceDiagram
  participant Pi as Pi Agent
  participant Ext as Extension
  participant Hook as Inspection Hooks
  participant API as Xiaomi MiMo API

  Pi->>Ext: user sends message (model selected)
  Ext->>Hook: context hook fires
  Note over Hook: logs full conversation context<br/>with message-by-message breakdown

  Ext->>Ext: build OpenAI-compatible request
  Note over Ext: thinking.type: enabled or disabled<br/>based on model defaults<br/>requiresReasoningContentOnAssistantMessages: true
  Ext->>Hook: before_provider_request fires
  Note over Hook: logs full outgoing payload:<br/>thinking, tools, reasoning_content replay, temperature

  Ext->>API: POST /v1/chat/completions<br/>Authorization: Bearer key
  API-->>Ext: response (SSE stream or JSON)

  Ext->>Hook: after_provider_response fires
  Note over Hook: logs HTTP status, response headers,<br/>rate limiting headers

  loop streaming tokens
    API-->>Ext: delta chunk
  end

  alt response contains tool_calls
    Ext->>Hook: tool_call hook fires
    Note over Hook: logs parsed tool calls before execution
    Pi->>Pi: execute tool
    Pi->>Ext: tool result
    Ext->>Hook: tool_result hook fires
    Note over Hook: logs tool results before sending back to LLM
    Ext->>API: next turn with tool results + reasoning_content preserved
  end

  Ext->>Hook: message_end fires
  Note over Hook: logs finalized assistant message<br/>including reasoning_content
  Ext-->>Pi: assistant message + reasoning_content
```

---

## Model Resolution

Models are loaded from two JSON files and merged. `patch.json` applies per-model overrides.

```mermaid
flowchart LR
  STATIC["models.json<br/>5 model definitions"] --> MERGE["merge models"]
  CUSTOM["custom-models.json<br/>user-defined models"] --> MERGE
  MERGE --> PATCH["apply patch.json<br/>per-model overrides"]
  PATCH --> REG["register all models<br/>under provider 'xiaomi-mimo'"]

  subgraph ModelProps["Each model definition"]
    M1["id, name"]
    M2["reasoning: true or false"]
    M3["input: text, image"]
    M4["contextWindow, maxTokens"]
    M5["thinkingFormat: deepseek"]
    M6["requiresReasoningContentOnAssistantMessages"]
  end

  REG --> ModelProps
```

---

## Thinking / Reasoning Flow

All MiMo reasoning models use DeepSeek-style thinking. The `reasoning_content` field is preserved across multi-turn conversations for best performance.

```mermaid
flowchart TD
  REQ["User message"] --> CHECK{"Model thinking<br/>default?"}
  CHECK -- "mimo-v2-flash (OFF)" --> DISABLED["thinking.type: disabled<br/>unless user enables"]
  CHECK -- "mimo-v2.5 or v2.5-pro (ON)" --> ENABLED["thinking.type: enabled"]

  DISABLED --> API1["POST /v1/chat/completions<br/>no reasoning_content"]
  ENABLED --> API2["POST /v1/chat/completions<br/>with thinking enabled"]

  API1 --> RESP1["Standard assistant response"]
  API2 --> RESP2["Assistant response +<br/>reasoning_content field"]

  RESP2 --> PRESERVE["requiresReasoningContentOnAssistantMessages: true"]
  PRESERVE --> MULTITURN["Next turn: previous reasoning_content<br/>replayed in messages array"]
  MULTITURN --> API2

  note right of PRESERVE
    Xiaomi docs: keep all previous
    reasoning_content in messages for
    each subsequent request to achieve
    best multi-turn performance
  end note
```

---

## Multi-Region Endpoint Routing

```mermaid
flowchart LR
  USER["User configures provider ID<br/>in auth.json or env var"] --> PROVIDER{"Provider ID?"}

  PROVIDER -- "xiaomi-mimo" --> GLOBAL["api.xiaomimimo.com/v1<br/>Global"]
  PROVIDER -- "xiaomi-mimo-token-plan-cn" --> CN["token-plan-cn.xiaomimimo.com/v1<br/>China"]
  PROVIDER -- "xiaomi-mimo-token-plan-ams" --> AMS["token-plan-ams.xiaomimimo.com/v1<br/>Amsterdam"]
  PROVIDER -- "xiaomi-mimo-token-plan-sgp" --> SGP["token-plan-sgp.xiaomimimo.com/v1<br/>Singapore"]

  GLOBAL --> MODEL["POST /v1/chat/completions<br/>model: mimo-v2.5-pro<br/>Authorization: Bearer key"]
  CN --> MODEL
  AMS --> MODEL
  SGP --> MODEL
```

---

## API Quirks and Compatibility

| Quirk | Handling |
|---|---|
| `tool_choice` only supports `"auto"` | Other values silently dropped server-side — plugin passes through |
| Thinking mode overrides `temperature` and `top_p` | Pro and Omni models forced to `1.0` and `0.95` by server |
| Uses `max_completion_tokens` (not `max_tokens`) | Plugin maps this in the request |
| Supports `developer` role (unlike many vLLM deployments) | Passed through natively |
| `reasoning_content` (not `reasoning`) | Pi checks `reasoning_content` first — handled correctly |
| Legacy models auto-route to V2.5 | `mimo-v2-pro` routes to `mimo-v2.5-pro`, `mimo-v2-omni` routes to `mimo-v2.5` |
