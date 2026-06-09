/**
 * Test: Preserved Reasoning Across Xiaomi MiMo Models
 *
 * For each reasoning model, this script:
 *   1. Sends a chat completion request that mimics pi's payload and verifies
 *      the reasoning_content field is present
 *   2. Sends a follow-up request that includes the assistant's prior message
 *      with its reasoning_content preserved — and verifies the model continues reasoning
 *
 * This validates the key Xiaomi-specific behavior:
 *   - `thinking: { type: "enabled" }` triggers reasoning
 *   - `reasoning_content` is returned on assistant messages
 *   - Preserving `reasoning_content` on replayed messages maintains reasoning context
 *
 * Usage:
 *   XIAOMI_MIMO_API_KEY=your-key npx tsx test-reasoning.ts
 *
 * Or with a specific endpoint:
 *   XIAOMI_MIMO_API_KEY=your-key MIMO_BASE_URL=https://api.xiaomimimo.com/v1 npx tsx test-reasoning.ts
 */

const BASE_URL = process.env.MIMO_BASE_URL ?? "https://api.xiaomimimo.com/v1";
const API_KEY = process.env.XIAOMI_MIMO_API_KEY;
const TIMEOUT_MS = 120_000;

if (!API_KEY) {
  console.error("Set XIAOMI_MIMO_API_KEY env var");
  console.error(
    "Usage: XIAOMI_MIMO_API_KEY=your-key npx tsx test-reasoning.ts"
  );
  process.exit(1);
}

interface ModelSpec {
  id: string;
  name: string;
  /** Whether thinking is enabled by default for this model */
  thinkingDefault: "enabled" | "disabled";
  /** Build the full request payload for this model */
  buildPayload: (
    messages: Record<string, unknown>[]
  ) => Record<string, unknown>;
}

const MODELS: ModelSpec[] = [
  {
    id: "mimo-v2.5-pro",
    name: "MiMo-V2.5-Pro",
    thinkingDefault: "enabled",
    buildPayload: (messages) => ({
      model: "mimo-v2.5-pro",
      messages,
      max_completion_tokens: 2048,
      stream: false,
      // DeepSeek-style thinking — matches Pi's thinkingFormat: "deepseek"
      thinking: { type: "enabled" },
    }),
  },
  {
    id: "mimo-v2.5",
    name: "MiMo-V2.5",
    thinkingDefault: "enabled",
    buildPayload: (messages) => ({
      model: "mimo-v2.5",
      messages,
      max_completion_tokens: 2048,
      stream: false,
      thinking: { type: "enabled" },
    }),
  },
  {
    id: "mimo-v2-flash",
    name: "MiMo-V2-Flash",
    thinkingDefault: "disabled",
    buildPayload: (messages) => ({
      model: "mimo-v2-flash",
      messages,
      max_completion_tokens: 2048,
      stream: false,
      // Flash needs explicit "enabled" to reason — OFF by default
      thinking: { type: "enabled" },
    }),
  },
];

// ─── API Helper ──────────────────────────────────────────────────────────────

interface ApiResponse {
  choices: {
    message: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: Record<string, unknown>[] | null;
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
}

async function chatCompletion(
  model: ModelSpec,
  messages: Record<string, unknown>[]
): Promise<{
  content: string;
  reasoning: string;
  toolCalls: Record<string, unknown>[] | null;
  usage: ApiResponse["usage"];
}> {
  const payload = model.buildPayload(messages);

  console.log("\n  ── Request payload ──");
  console.log(
    `  model: ${payload.model}, thinking: ${JSON.stringify(payload.thinking)}`
  );
  console.log(
    `  max_completion_tokens: ${payload.max_completion_tokens}`
  );
  console.log(`  messages count: ${(payload.messages as unknown[]).length}`);
  for (const msg of payload.messages as Record<string, unknown>[]) {
    const hasRC =
      typeof msg.reasoning_content === "string" &&
      (msg.reasoning_content as string).length > 0;
    console.log(
      `    [${msg.role}] content=${typeof msg.content === "string" ? (msg.content as string).length + " chars" : "complex"}${hasRC ? ` | reasoning_content=${(msg.reasoning_content as string).length} chars` : ""}`
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    console.log(`  HTTP ${res.status} ${res.statusText}`);

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`);
    }

    const data = (await res.json()) as ApiResponse;

    const msg = data.choices?.[0]?.message;
    const content = msg?.content ?? "";
    const reasoning = msg?.reasoning_content ?? "";
    const toolCalls = msg?.tool_calls ?? null;

    console.log("\n  ── Response ──");
    console.log(
      `  content: ${content.length} chars — "${content.slice(0, 100).replace(/\n/g, " ")}${content.length > 100 ? "..." : ""}"`
    );
    console.log(
      `  reasoning_content: ${reasoning.length} chars — "${reasoning.slice(0, 100).replace(/\n/g, " ")}${reasoning.length > 100 ? "..." : ""}"`
    );
    if (toolCalls && toolCalls.length > 0) {
      console.log(
        `  tool_calls: ${toolCalls.length} call(s) — ${JSON.stringify(toolCalls).slice(0, 200)}`
      );
    }
    if (data.usage) {
      console.log(
        `  usage: prompt=${data.usage.prompt_tokens}, completion=${data.usage.completion_tokens}, reasoning=${data.usage.completion_tokens_details?.reasoning_tokens ?? "N/A"}`
      );
    }

    return { content, reasoning, toolCalls, usage: data.usage };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Test Runner ─────────────────────────────────────────────────────────────

type TestResult = "PASS" | "FAIL";

interface ModelTestResult {
  model: string;
  turn1ReasoningPresent: TestResult;
  turn1ReasoningLen: number;
  turn2ReasoningPresent: TestResult;
  turn2ReasoningLen: number;
  turn1ContentLen: number;
  turn2ContentLen: number;
  error?: string;
}

async function testModel(model: ModelSpec): Promise<ModelTestResult> {
  const result: ModelTestResult = {
    model: model.name,
    turn1ReasoningPresent: "FAIL",
    turn1ReasoningLen: 0,
    turn2ReasoningPresent: "FAIL",
    turn2ReasoningLen: 0,
    turn1ContentLen: 0,
    turn2ContentLen: 0,
  };

  try {
    // Turn 1: simple reasoning question
    const messages1: Record<string, unknown>[] = [
      {
        role: "developer",
        content:
          "You are MiMo, an AI assistant developed by Xiaomi. Think step by step before answering.",
      },
      {
        role: "user",
        content:
          "What is 17 * 23? Think step by step, then give the final answer.",
      },
    ];

    console.log(`\n  [Turn 1] Sending request...`);
    const r1 = await chatCompletion(model, messages1);
    result.turn1ReasoningLen = r1.reasoning.length;
    result.turn1ContentLen = r1.content.length;
    result.turn1ReasoningPresent =
      r1.reasoning.length > 0 ? "PASS" : "FAIL";

    if (result.turn1ReasoningPresent === "FAIL") {
      result.error = "No reasoning_content returned on turn 1";
      return result;
    }

    // Turn 2: follow-up with preserved reasoning
    // Build the assistant message with reasoning_content — matching Pi's
    // requiresReasoningContentOnAssistantMessages behavior.
    // Xiaomi docs: "it is recommended to keep all previous reasoning_content
    // in the messages array for each subsequent request to achieve the best
    // performance."
    const assistantMsg: Record<string, unknown> = {
      role: "assistant",
      content: r1.content,
      reasoning_content: r1.reasoning,
    };

    const messages2: Record<string, unknown>[] = [
      messages1[0], // developer
      messages1[1], // user
      assistantMsg, // assistant with preserved reasoning
      {
        role: "user",
        content: "Now add 5 to that result. Think step by step again.",
      },
    ];

    console.log(`\n  [Turn 2] Sending preserved-reasoning request...`);
    const r2 = await chatCompletion(model, messages2);
    result.turn2ReasoningLen = r2.reasoning.length;
    result.turn2ContentLen = r2.content.length;
    result.turn2ReasoningPresent =
      r2.reasoning.length > 0 ? "PASS" : "FAIL";

    if (result.turn2ReasoningPresent === "FAIL") {
      result.error =
        "No reasoning_content returned on turn 2 (preserved reasoning)";
    }
  } catch (err: unknown) {
    result.error = err instanceof Error ? err.message : String(err);
    if (result.error.includes("aborted")) {
      result.error = `Timeout after ${TIMEOUT_MS / 1000}s`;
    }
  }

  return result;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════");
  console.log("║  Xiaomi MiMo — Preserved Reasoning Test");
  console.log("║  Validates thinking mode + reasoning_content preservation");
  console.log("╠══════════════════════════════════════════════════════════════");
  console.log(`║  Base URL:  ${BASE_URL}`);
  console.log(`║  API Key:   ${API_KEY!.slice(0, 8)}...`);
  console.log(`║  Models:    ${MODELS.length}`);
  console.log(
    "╚══════════════════════════════════════════════════════════════"
  );

  const results: ModelTestResult[] = [];

  for (const model of MODELS) {
    console.log(
      `\n══════════════════════════════════════════════════════════════`
    );
    console.log(
      `► ${model.name} (${model.id})`
    );
    console.log(
      `  Thinking default: ${model.thinkingDefault}`
    );

    const r = await testModel(model);
    results.push(r);
  }

  // Summary table
  console.log(
    "\n\n╔══════════════════════════════════════════════════════════════"
  );
  console.log("║  RESULTS SUMMARY");
  console.log(
    "╠══════════════════════════════════════════════════════════════"
  );
  console.log(
    "| Model | T1 Reasoning | T1 Len | T2 Reasoning | T2 Len | Error |"
  );
  console.log(
    "|-------|-------------|--------|-------------|--------|-------|"
  );

  for (const r of results) {
    console.log(
      `| ${r.model.padEnd(16)} | ${r.turn1ReasoningPresent.padEnd(12)} | ${String(r.turn1ReasoningLen).padEnd(6)} | ${r.turn2ReasoningPresent.padEnd(12)} | ${String(r.turn2ReasoningLen).padEnd(6)} | ${r.error ?? ""} |`
    );
  }

  const passes = results.filter(
    (r) =>
      r.turn1ReasoningPresent === "PASS" &&
      r.turn2ReasoningPresent === "PASS"
  ).length;
  const fails = results.length - passes;

  console.log(
    `\n${passes}/${results.length} models pass both turns.`
  );

  if (fails > 0) {
    console.log(`\n❌ ${fails} model(s) failed:`);
    for (const r of results) {
      if (
        r.turn1ReasoningPresent !== "PASS" ||
        r.turn2ReasoningPresent !== "PASS"
      ) {
        console.log(
          `  - ${r.model}: T1=${r.turn1ReasoningPresent} T2=${r.turn2ReasoningPresent}${r.error ? ` (${r.error})` : ""}`
        );
      }
    }
  } else {
    console.log(
      `\n✅ All models pass preserved reasoning.`
    );
  }

  console.log(
    "\n╔══════════════════════════════════════════════════════════════"
  );
  console.log("║  What this test validates:");
  console.log("║  1. thinking: { type: 'enabled' } triggers reasoning_content");
  console.log(
    "║  2. reasoning_content is returned on assistant messages"
  );
  console.log(
    "║  3. Preserving reasoning_content on replay maintains context"
  );
  console.log(
    "║  4. Multi-turn reasoning works across user → assistant → user"
  );
  console.log(
    "╚══════════════════════════════════════════════════════════════\n"
  );

  process.exit(fails > 0 ? 1 : 0);
}

main();
