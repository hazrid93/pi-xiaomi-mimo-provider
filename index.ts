/**
 * Xiaomi MiMo Provider Extension
 *
 * Registers Xiaomi MiMo as a custom provider using the OpenAI completions API.
 *
 * Xiaomi MiMo is an OpenAI-compatible API at https://api.xiaomimimo.com/v1.
 * It supports DeepSeek-style thinking via `thinking: { type: "enabled" }` and
 * returns reasoning in the `reasoning_content` field.
 *
 * Model resolution strategy: static models.json merged with custom-models.json
 *
 * Reasoning notes:
 *   - All MiMo reasoning models return `reasoning_content` (not `reasoning`).
 *     pi's OpenAI completions handler checks `reasoning_content` first, so this
 *     is handled correctly.
 *   - Thinking is controlled via `thinking: { type: "enabled" | "disabled" }`,
 *     which matches Pi's "deepseek" thinkingFormat.
 *   - mimo-v2-flash: thinking OFF by default. Needs explicit `enabled` to reason.
 *   - mimo-v2.5 / mimo-v2.5-pro: thinking ON by default.
 *   - During multi-turn tool calls with thinking, Xiaomi returns `reasoning_content`
 *     alongside `tool_calls`. The docs recommend preserving all previous
 *     `reasoning_content` in the messages array for each subsequent request.
 *     This is handled by `requiresReasoningContentOnAssistantMessages: true`.
 *
 * Developer role IS supported by Xiaomi's API (unlike Makora/vLLM).
 *
 * Xiaomi API quirks documented:
 *   - `tool_choice` only supports `"auto"` — other values are silently removed
 *     server-side and treated as `auto`.
 *   - In thinking mode, temperature and top_p are forcibly overridden to 1.0 / 0.95
 *     for pro/omni models.
 *   - mimo-v2-pro and mimo-v2-omni are being deprecated in favor of V2.5 series.
 *
 * vLLM inspection hooks:
 *   - `before_provider_request` logs the full outgoing payload for inspection.
 *     This is useful for understanding what Pi sends vs what Xiaomi receives.
 *   - `after_provider_response` logs status code and response headers.
 *   - `message_end` logs finalized assistant messages including reasoning_content.
 *   - `context` logs the conversation context sent to the LLM.
 *
 * Usage:
 *   # Option 1: Store in auth.json (recommended)
 *   # Add to ~/.pi/agent/auth.json:
 *   #   "xiaomi-mimo": { "type": "api_key", "key": "your-api-key" }
 *   #   "xiaomi-mimo-token-plan-cn": { "type": "api_key", "key": "your-api-key" }
 *
 *   # Option 2: Set as environment variable
 *   export XIAOMI_MIMO_API_KEY=your-api-key
 *   export XIAOMI_MIMO_TOKEN_PLAN_CN_API_KEY=your-api-key
 *   export XIAOMI_MIMO_TOKEN_PLAN_AMS_API_KEY=your-api-key
 *   export XIAOMI_MIMO_TOKEN_PLAN_SGP_API_KEY=your-api-key
 *
 *   # Run pi with the extension
 *   pi -e /path/to/pi-xiaomi-mimo-provider
 *
 * Then use /model to select from available MiMo models.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import modelsData from "./models.json" with { type: "json" };
import customModelsData from "./custom-models.json" with { type: "json" };
import patchData from "./patch.json" with { type: "json" };

// ─── Types ───────────────────────────────────────────────────────────────────

interface JsonModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  baseUrl?: string;
  notes?: string;
  thinkingLevelMap?: Record<string, string | null>;
  headers?: Record<string, string>;
  vision?: {
    maxImagesPerRequest?: number;
  };
  compat?: {
    supportsDeveloperRole?: boolean;
    supportsStore?: boolean;
    maxTokensField?: "max_completion_tokens" | "max_tokens";
    thinkingFormat?:
      | "openai"
      | "openrouter"
      | "deepseek"
      | "together"
      | "zai"
      | "qwen"
      | "qwen-chat-template";
    supportsReasoningEffort?: boolean;
    supportsUsageInStreaming?: boolean;
    supportsStrictMode?: boolean;
    requiresReasoningContentOnAssistantMessages?: boolean;
    requiresToolResultName?: boolean;
    requiresAssistantAfterToolResult?: boolean;
    cacheControlFormat?: "anthropic";
  };
}

interface PatchEntry {
  name?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  contextWindow?: number;
  maxTokens?: number;
  baseUrl?: string;
  notes?: string;
  thinkingLevelMap?: Record<string, string | null>;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

type PatchMap = Record<string, PatchEntry>;

// ─── Patch Application ───────────────────────────────────────────────────────

function applyPatch(model: JsonModel, patch: PatchEntry): JsonModel {
  const result = { ...model };

  if (patch.name !== undefined) result.name = patch.name;
  if (patch.reasoning !== undefined) result.reasoning = patch.reasoning;
  if (patch.input !== undefined) result.input = patch.input;
  if (patch.contextWindow !== undefined)
    result.contextWindow = patch.contextWindow;
  if (patch.maxTokens !== undefined) result.maxTokens = patch.maxTokens;
  if (patch.baseUrl !== undefined) result.baseUrl = patch.baseUrl;
  if (patch.notes !== undefined) result.notes = patch.notes;
  if (patch.thinkingLevelMap !== undefined)
    result.thinkingLevelMap = { ...patch.thinkingLevelMap };
  if (patch.headers !== undefined) result.headers = { ...patch.headers };

  if (patch.cost) {
    result.cost = {
      input: patch.cost.input ?? result.cost.input,
      output: patch.cost.output ?? result.cost.output,
      cacheRead: patch.cost.cacheRead ?? result.cost.cacheRead,
      cacheWrite: patch.cost.cacheWrite ?? result.cost.cacheWrite,
    };
  }
  if (patch.compat) {
    result.compat = { ...(result.compat || {}), ...patch.compat };
  }

  if (!result.reasoning && result.compat?.thinkingFormat) {
    delete result.compat.thinkingFormat;
  }
  if (result.compat && Object.keys(result.compat).length === 0) {
    delete result.compat;
  }

  return result;
}

/** Merge static models with any user-defined custom models */
function buildModels(
  base: JsonModel[],
  custom: JsonModel[],
  patch: PatchMap
): JsonModel[] {
  const modelMap = new Map<string, JsonModel>();

  for (const model of base) {
    modelMap.set(model.id, model);
  }

  for (const [id, patchEntry] of Object.entries(patch)) {
    const existing = modelMap.get(id);
    if (existing) {
      modelMap.set(id, applyPatch(existing, patchEntry));
    }
  }

  for (const model of custom) {
    const existing = modelMap.get(model.id);
    const patchEntry = patch[model.id];
    if (existing && patchEntry) {
      modelMap.set(model.id, applyPatch(model, patchEntry));
    } else if (existing) {
      modelMap.set(model.id, model);
    } else if (patchEntry) {
      modelMap.set(model.id, applyPatch(model, patchEntry));
    } else {
      modelMap.set(model.id, model);
    }
  }

  return Array.from(modelMap.values());
}

// ─── Xiaomi MiMo Endpoint Configuration ──────────────────────────────────────

const XIAOMI_ENDPOINTS: Record<string, string> = {
  "xiaomi-mimo": "https://api.xiaomimimo.com/v1",
  "xiaomi-mimo-token-plan-cn": "https://token-plan-cn.xiaomimimo.com/v1",
  "xiaomi-mimo-token-plan-ams": "https://token-plan-ams.xiaomimimo.com/v1",
  "xiaomi-mimo-token-plan-sgp": "https://token-plan-sgp.xiaomimimo.com/v1",
};

const XIAOMI_API_KEY_ENV: Record<string, string> = {
  "xiaomi-mimo": "XIAOMI_MIMO_API_KEY",
  "xiaomi-mimo-token-plan-cn": "XIAOMI_MIMO_TOKEN_PLAN_CN_API_KEY",
  "xiaomi-mimo-token-plan-ams": "XIAOMI_MIMO_TOKEN_PLAN_AMS_API_KEY",
  "xiaomi-mimo-token-plan-sgp": "XIAOMI_MIMO_TOKEN_PLAN_SGP_API_KEY",
};

const XIAOMI_NAMES: Record<string, string> = {
  "xiaomi-mimo": "Xiaomi MiMo",
  "xiaomi-mimo-token-plan-cn": "Xiaomi MiMo Token Plan (China)",
  "xiaomi-mimo-token-plan-ams": "Xiaomi MiMo Token Plan (Amsterdam)",
  "xiaomi-mimo-token-plan-sgp": "Xiaomi MiMo Token Plan (Singapore)",
};

// ─── vLLM Payload Inspection Helpers ─────────────────────────────────────────

/**
 * Inspect the outgoing payload before it hits Xiaomi's API.
 *
 * This is the equivalent of Makora's `rewriteDsVllmPayload` but for Xiaomi MiMo.
 * Unlike Makora (which needed to rewrite vLLM-specific params), Xiaomi's API
 * accepts the standard DeepSeek thinking format directly. This hook is primarily
 * for **learning and inspection** — to see exactly what Pi sends to Xiaomi.
 *
 * What to look for in the logs:
 *   1. `thinking` field — should be `{ type: "enabled" }` for reasoning models
 *   2. `reasoning_content` on replayed assistant messages — check it's preserved
 *   3. `tool_choice` — Xiaomi only supports `"auto"`, other values are silently dropped
 *   4. `temperature` / `top_p` — forcibly overridden in thinking mode for pro models
 *   5. `max_completion_tokens` — should be used (not `max_tokens`)
 *   6. `stream_options` — check if Pi sends usage-in-streaming config
 */
function inspectOutgoingPayload(payload: Record<string, unknown>): void {
  const model = payload.model as string | undefined;
  const thinking = payload.thinking;
  const tools = payload.tools as unknown[] | undefined;
  const toolChoice = payload.tool_choice;
  const temperature = payload.temperature;
  const topP = payload.top_p;
  const maxTokens =
    payload.max_completion_tokens ?? payload.max_tokens;
  const streamOptions = payload.stream_options;

  console.log(
    "\n╔══════════════════════════════════════════════════════════════"
  );
  console.log("║ [pi-xiaomi-mimo] → OUTGOING PAYLOAD INSPECTION");
  console.log("╠══════════════════════════════════════════════════════════════");
  console.log(`║ model:              ${model ?? "N/A"}`);
  console.log(
    `║ thinking:           ${JSON.stringify(thinking) ?? "not set"}`
  );
  console.log(`║ tool_choice:        ${JSON.stringify(toolChoice) ?? "not set"}`);
  console.log(`║ tools count:        ${tools?.length ?? 0}`);
  console.log(`║ temperature:        ${temperature ?? "not set"}`);
  console.log(`║ top_p:              ${topP ?? "not set"}`);
  console.log(`║ max_tokens:         ${maxTokens ?? "not set"}`);
  console.log(
    `║ stream_options:     ${JSON.stringify(streamOptions) ?? "not set"}`
  );

  // Check for Xiaomi-specific quirks
  if (toolChoice && toolChoice !== "auto") {
    console.log(
      `║ ⚠  WARNING: tool_choice=${JSON.stringify(toolChoice)} — Xiaomi only supports "auto", other values are silently dropped`
    );
  }

  // Check if thinking is enabled/disabled and what the model expects
  if (thinking && typeof thinking === "object") {
    const thinkingObj = thinking as Record<string, unknown>;
    if (thinkingObj.type === "enabled") {
      console.log("║ ✓  Thinking ENABLED — model will return reasoning_content");
    } else if (thinkingObj.type === "disabled") {
      console.log(
        "║ ✓  Thinking DISABLED — no reasoning_content expected"
      );
    }
  }

  // Check for reasoning_content on replayed assistant messages
  const messages = payload.messages as
    | Record<string, unknown>[]
    | undefined;
  if (messages) {
    const assistantWithReasoning = messages.filter(
      (m) =>
        m.role === "assistant" &&
        m.reasoning_content &&
        (m.reasoning_content as string).length > 0
    );
    if (assistantWithReasoning.length > 0) {
      console.log(
        `║ ✓  ${assistantWithReasoning.length} assistant message(s) with reasoning_content preserved`
      );
      for (const msg of assistantWithReasoning) {
        const rc = msg.reasoning_content as string;
        console.log(
          `║    └─ reasoning_content: ${rc.length} chars (${rc.slice(0, 80).replace(/\n/g, " ")}...)`
        );
      }
    } else {
      console.log(
        "║ ⚠  No assistant messages with reasoning_content found"
      );
    }
  }

  console.log(
    "╚══════════════════════════════════════════════════════════════\n"
  );
}

/**
 * Inspect the response headers and status from Xiaomi's API.
 *
 * Useful for detecting:
 *   - Rate limiting (429 + retry-after)
 *   - Model routing changes (v2-pro → v2.5 auto-route)
 *   - Cached tokens from prompt caching
 *   - Any Xiaomi-specific headers
 */
function inspectResponseHeaders(
  status: number,
  headers: Record<string, string>
): void {
  console.log(
    "\n╔══════════════════════════════════════════════════════════════"
  );
  console.log("║ [pi-xiaomi-mimo] ← RESPONSE INSPECTION");
  console.log("╠══════════════════════════════════════════════════════════════");
  console.log(`║ status:             ${status}`);
  console.log(
    `║ content-type:       ${headers["content-type"] ?? "N/A"}`
  );
  console.log(
    `║ x-request-id:       ${headers["x-request-id"] ?? "N/A"}`
  );
  console.log(
    `║ x-ratelimit-remaining: ${headers["x-ratelimit-remaining-requests"] ?? headers["x-ratelimit-remaining"] ?? "N/A"}`
  );
  console.log(
    `║ retry-after:        ${headers["retry-after"] ?? "N/A"}`
  );

  // Check for Xiaomi-specific or interesting headers
  const interestingHeaders = Object.entries(headers).filter(
    ([key]) =>
      key.startsWith("x-") ||
      key === "retry-after" ||
      key === "server" ||
      key === "cf-ray"
  );
  if (interestingHeaders.length > 0) {
    console.log("║ ── All interesting headers ──");
    for (const [key, value] of interestingHeaders) {
      console.log(`║    ${key}: ${value}`);
    }
  }

  // Check for rate limiting
  if (status === 429) {
    console.log(
      "║ ⚠  RATE LIMITED — check retry-after header and implement backoff"
    );
  }

  console.log(
    "╚══════════════════════════════════════════════════════════════\n"
  );
}

/**
 * Inspect the conversation context (messages array) before each LLM call.
 *
 * This shows the full picture of what the LLM sees, including:
 *   - System prompt
 *   - All user and assistant messages
 *   - Tool results
 *   - Whether reasoning_content is properly preserved on assistant messages
 *   - The message count and approximate token usage
 */
function inspectContext(
  messages: Record<string, unknown>[],
  providerId: string
): void {
  console.log(
    "\n╔══════════════════════════════════════════════════════════════"
  );
  console.log("║ [pi-xiaomi-mimo] 📋 CONTEXT INSPECTION");
  console.log("╠══════════════════════════════════════════════════════════════");
  console.log(`║ provider:           ${providerId}`);
  console.log(`║ total messages:     ${messages.length}`);

  let reasoningPreserved = 0;
  let assistantWithTools = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const role = msg.role as string;
    const hasReasoning =
      typeof msg.reasoning_content === "string" &&
      (msg.reasoning_content as string).length > 0;
    const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;

    let summary = "";
    if (role === "system" || role === "developer") {
      const content = msg.content as string;
      summary = `${(content ?? "").slice(0, 60).replace(/\n/g, " ")}...`;
    } else if (role === "user") {
      if (Array.isArray(msg.content)) {
        const parts = msg.content as Record<string, unknown>[];
        const types = parts.map((p) => p.type).join(", ");
        summary = `[${types}] ${parts.length} part(s)`;
      } else {
        summary = `${(msg.content as string).slice(0, 60).replace(/\n/g, " ")}...`;
      }
    } else if (role === "assistant") {
      const content = typeof msg.content === "string" ? msg.content : "";
      summary = `${content.slice(0, 50).replace(/\n/g, " ")}...`;
      if (hasReasoning) {
        summary += ` [✓ reasoning_content: ${(msg.reasoning_content as string).length} chars]`;
        reasoningPreserved++;
      }
      if (hasToolCalls) {
        const toolCalls = msg.tool_calls as Record<string, unknown>[];
        const names = toolCalls
          .map((tc) => {
            const fn = tc.function as Record<string, unknown>;
            return fn?.name;
          })
          .join(", ");
        summary += ` [tool_calls: ${names}]`;
        assistantWithTools++;
      }
    } else if (role === "toolResult") {
      summary = `toolName=${msg.toolName ?? "?"}, toolCallId=${msg.toolCallId ?? "?"}`;
    }

    console.log(`║ [${i}] ${role.padEnd(10)} ${summary}`);
  }

  console.log("║ ── Summary ──");
  console.log(`║ reasoning_content preserved: ${reasoningPreserved}`);
  console.log(`║ assistant with tool_calls:   ${assistantWithTools}`);
  console.log(
    "╚══════════════════════════════════════════════════════════════\n"
  );
}

/**
 * Inspect a finalized assistant message including its reasoning_content.
 *
 * This runs after the model has finished generating, showing:
 *   - The final content text
 *   - The reasoning_content (if thinking was enabled)
 *   - Tool calls
 *   - Usage statistics
 *   - Stop reason
 */
function inspectAssistantMessage(message: Record<string, unknown>): void {
  const content = message.content as
    | Record<string, unknown>[]
    | undefined;
  const usage = message.usage as Record<string, unknown> | undefined;
  const stopReason = message.stopReason as string | undefined;
  const model = message.model as string | undefined;
  const provider = message.provider as string | undefined;

  console.log(
    "\n╔══════════════════════════════════════════════════════════════"
  );
  console.log("║ [pi-xiaomi-mimo] 🤖 ASSISTANT MESSAGE INSPECTION");
  console.log("╠══════════════════════════════════════════════════════════════");
  console.log(`║ model:        ${model ?? "N/A"}`);
  console.log(`║ provider:     ${provider ?? "N/A"}`);
  console.log(`║ stopReason:   ${stopReason ?? "N/A"}`);

  if (usage) {
    console.log("║ ── Usage ──");
    console.log(`║   input:       ${usage.input ?? 0}`);
    console.log(`║   output:      ${usage.output ?? 0}`);
    console.log(`║   cacheRead:   ${usage.cacheRead ?? 0}`);
    console.log(`║   cacheWrite:  ${usage.cacheWrite ?? 0}`);
    console.log(`║   totalTokens: ${usage.totalTokens ?? 0}`);
    const cost = usage.cost as Record<string, unknown> | undefined;
    if (cost) {
      console.log(`║   cost.total:  $${cost.total ?? 0}`);
    }
  }

  if (content && Array.isArray(content)) {
    console.log(`║ ── Content (${content.length} block(s)) ──`);
    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      const type = block.type as string;
      if (type === "text") {
        const text = block.text as string;
        console.log(
          `║ [${i}] text: ${text.length} chars — "${text.slice(0, 100).replace(/\n/g, " ")}${text.length > 100 ? "..." : ""}"`
        );
      } else if (type === "thinking") {
        const thinking = block.thinking as string;
        console.log(
          `║ [${i}] thinking: ${thinking.length} chars — "${thinking.slice(0, 100).replace(/\n/g, " ")}${thinking.length > 100 ? "..." : ""}"`
        );
      } else if (type === "toolCall") {
        const name = block.name as string;
        const args = JSON.stringify(block.arguments ?? {});
        console.log(
          `║ [${i}] toolCall: ${name}(${args.slice(0, 80)}${args.length > 80 ? "..." : ""})`
        );
      }
    }
  }

  console.log(
    "╚══════════════════════════════════════════════════════════════\n"
  );
}

// ─── Extension Entry Point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const embeddedModels = modelsData as JsonModel[];
  const customModels = customModelsData as JsonModel[];
  const patches = patchData as PatchMap;

  const models = buildModels(embeddedModels, customModels, patches);

  // Register each Xiaomi endpoint as a separate provider
  for (const [providerId, baseUrl] of Object.entries(XIAOMI_ENDPOINTS)) {
    const envKey = XIAOMI_API_KEY_ENV[providerId];
    const name = XIAOMI_NAMES[providerId];

    pi.registerProvider(providerId, {
      name,
      baseUrl,
      apiKey: `$${envKey}`,
      api: "openai-completions",
      models,
    });
  }

  // ─── vLLM Layer Inspection Hooks ───────────────────────────────────────────

  /**
   * Hook 1: before_provider_request
   *
   * Fires AFTER Pi builds the OpenAI-compatible payload, right BEFORE the HTTP
   * request is sent to Xiaomi's API.
   *
   * This is the most valuable hook for understanding the Pi → Xiaomi data flow.
   *
   * What to study here:
   *   - How Pi constructs `thinking: { type: "enabled" }` from thinking levels
   *   - How Pi preserves `reasoning_content` on assistant replay messages
   *   - What tool definitions Pi sends
   *   - Whether Pi sends unsupported fields that Xiaomi silently drops
   */
  pi.on("before_provider_request", (event, ctx) => {
    const payload = event.payload as
      | Record<string, unknown>
      | undefined;
    if (!payload || typeof payload.model !== "string") return;

    const provider = ctx.model?.provider;
    if (
      !provider ||
      !provider.startsWith("xiaomi-mimo")
    ) {
      return;
    }

    // Full payload inspection
    inspectOutgoingPayload(payload);

    // Return undefined = keep payload unchanged
    // If you wanted to rewrite the payload (like Makora does for vLLM),
    // you'd return a modified copy here.
    return undefined;
  });

  /**
   * Hook 2: after_provider_response
   *
   * Fires AFTER the HTTP response is received, BEFORE the stream is consumed.
   *
   * Useful for:
   *   - Detecting rate limiting (429)
   *   - Monitoring Xiaomi-specific response headers
   *   - Detecting model routing (v2-pro → v2.5 auto-route)
   */
  pi.on("after_provider_response", (event, ctx) => {
    const provider = ctx.model?.provider;
    if (
      !provider ||
      !provider.startsWith("xiaomi-mimo")
    ) {
      return;
    }

    inspectResponseHeaders(
      event.status,
      event.headers as Record<string, string>
    );
  });

  /**
   * Hook 3: context
   *
   * Fires BEFORE each LLM call. Shows the full conversation context.
   *
   * This is where you can verify:
   *   - `reasoning_content` is preserved on assistant messages
   *   - The message order is correct
   *   - System/developer prompts are properly formatted
   *   - Tool results are structured correctly
   */
  pi.on("context", (event, ctx) => {
    const provider = ctx.model?.provider;
    if (
      !provider ||
      !provider.startsWith("xiaomi-mimo")
    ) {
      return;
    }

    const messages = event.messages as unknown as Record<string, unknown>[];
    inspectContext(messages, provider);
  });

  /**
   * Hook 4: message_end
   *
   * Fires AFTER a message is finalized (streaming complete).
   *
   * This is where you can inspect the final assistant message including:
   *   - reasoning_content
   *   - tool_calls
   *   - usage statistics
   *   - cost calculation
   */
  pi.on("message_end", (event, ctx) => {
    const provider = ctx.model?.provider;
    if (
      !provider ||
      !provider.startsWith("xiaomi-mimo")
    ) {
      return;
    }

    const message = event.message;
    if (message.role !== "assistant") return;

    inspectAssistantMessage(message as unknown as Record<string, unknown>);
  });

  /**
   * Hook 5: tool_call
   *
   * Fires BEFORE a tool executes. Log the tool call for inspection.
   *
   * This shows the actual tool calls the model decided to make, including
   * the parsed arguments. Useful for verifying tool call parsing works
   * correctly with Xiaomi's response format.
   */
  pi.on("tool_call", (event, ctx) => {
    const provider = ctx.model?.provider;
    if (
      !provider ||
      !provider.startsWith("xiaomi-mimo")
    ) {
      return;
    }

    console.log(
      "\n╔══════════════════════════════════════════════════════════════"
    );
    console.log("║ [pi-xiaomi-mimo] 🔧 TOOL CALL");
    console.log("╠══════════════════════════════════════════════════════════════");
    console.log(`║ toolName:   ${event.toolName}`);
    console.log(`║ toolCallId: ${event.toolCallId}`);
    console.log(
      `║ args:       ${JSON.stringify(event.input, null, 2).slice(0, 500)}`
    );
    console.log(
      "╚══════════════════════════════════════════════════════════════\n"
    );
  });

  /**
   * Hook 6: tool_result
   *
   * Fires AFTER a tool executes, BEFORE the result is finalized.
   *
   * Useful for verifying tool results are properly structured for Xiaomi's
   * multi-turn tool call flow.
   */
  pi.on("tool_result", (event, ctx) => {
    const provider = ctx.model?.provider;
    if (
      !provider ||
      !provider.startsWith("xiaomi-mimo")
    ) {
      return;
    }

    console.log(
      "\n╔══════════════════════════════════════════════════════════════"
    );
    console.log("║ [pi-xiaomi-mimo] 🔧 TOOL RESULT");
    console.log("╠══════════════════════════════════════════════════════════════");
    console.log(`║ toolName:   ${event.toolName}`);
    console.log(`║ toolCallId: ${event.toolCallId}`);
    console.log(
      `║ isError:    ${event.isError}`
    );
    const contentPreview = JSON.stringify(event.content).slice(0, 300);
    console.log(`║ content:    ${contentPreview}`);
    console.log(
      "╚══════════════════════════════════════════════════════════════\n"
    );
  });
}
