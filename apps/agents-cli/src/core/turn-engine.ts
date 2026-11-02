import type { LLMClient } from "../llm/client.js";
import type { LLMResponse, ToolDefinition } from "../types/index.js";
import { compactMessagesForTurn, recordCompactionEvent, shouldRetryWithCompaction } from "./message-compaction.js";
import type { AgentSessionEngine } from "./session/session-engine.js";

/**
 * 发给模型的上下文最大消息条数。
 *
 * <p>会话文件侧仍保留 200 条（见 core/memory/session.ts 的 DEFAULT_MAX_MESSAGES），
 * 这里只在组装 LLM 请求时截取最近 N 条，避免长会话把过多历史塞进模型上下文、无谓消耗 token。</p>
 */
const MAX_MODEL_CONTEXT_MESSAGES = 30;

export async function executeAgentTurn(input: {
  client: LLMClient;
  session: AgentSessionEngine;
  system: string;
  tools: ToolDefinition[];
  modelOverride?: string;
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  abortSignal?: AbortSignal;
}): Promise<LLMResponse> {
  const modelContextMessages = input.session.getMessages().slice(-MAX_MODEL_CONTEXT_MESSAGES);
  console.log("[agents] model context messages=%d", modelContextMessages.length);
  const preflight = compactMessagesForTurn({
    messages: modelContextMessages,
    kind: "preflight",
  });
  recordCompactionEvent(input.session.getRuntimeMeta(), preflight.event);
  try {
    return await input.client.call({
      system: input.system,
      messages: preflight.messages,
      tools: input.tools,
      ...(input.modelOverride ? { model: input.modelOverride } : {}),
      ...(input.onTextDelta ? { onTextDelta: input.onTextDelta } : {}),
      ...(input.onReasoningDelta ? { onReasoningDelta: input.onReasoningDelta } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
  } catch (error) {
    if (!shouldRetryWithCompaction(error)) {
      throw error;
    }
    const recovery = compactMessagesForTurn({
      messages: preflight.messages,
      kind: "recovery",
      maxChars: Math.max(8_000, Math.trunc((preflight.event?.compactedChars ?? 24_000) * 0.7)),
      preserveLastMessages: 6,
    });
    recordCompactionEvent(input.session.getRuntimeMeta(), recovery.event);
    return input.client.call({
      system: input.system,
      messages: recovery.messages,
      tools: input.tools,
      ...(input.modelOverride ? { model: input.modelOverride } : {}),
      ...(input.onTextDelta ? { onTextDelta: input.onTextDelta } : {}),
      ...(input.onReasoningDelta ? { onReasoningDelta: input.onReasoningDelta } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
  }
}
