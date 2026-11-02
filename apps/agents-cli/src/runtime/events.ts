import type { LlmTurnTrace, ToolCallTrace } from "../core/hooks/types.js";
import type { RuntimeTodoUpdate } from "./todo-events.js";

export type RuntimeRunStartedEvent = {
  type: "run.started";
  prompt: string;
  sessionId?: string;
};

export type RuntimeTextDeltaEvent = {
  type: "text.delta";
  delta: string;
};

/** 思考链增量事件：与 text.delta 分离，上层按权限决定是否透传/展示 */
export type RuntimeReasoningDeltaEvent = {
  type: "reasoning.delta";
  delta: string;
};

export type RuntimeToolStartedEvent = {
  type: "tool.started";
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  startedAt: string;
};

export type RuntimeTodoUpdatedEvent = {
  type: "todo.updated";
  todo: RuntimeTodoUpdate;
};

export type RuntimeTurnCompletedEvent = {
  type: "turn.completed";
  turn: LlmTurnTrace;
};

export type RuntimeToolCompletedEvent = {
  type: "tool.completed";
  toolCall: ToolCallTrace;
};

export type RuntimeRunCompletedEvent = {
  type: "run.completed";
  result: string;
};

export type RuntimeRunFailedEvent = {
  type: "run.failed";
  message: string;
};

export type RuntimeRunEvent =
  | RuntimeRunStartedEvent
  | RuntimeTextDeltaEvent
  | RuntimeReasoningDeltaEvent
  | RuntimeToolStartedEvent
  | RuntimeTodoUpdatedEvent
  | RuntimeTurnCompletedEvent
  | RuntimeToolCompletedEvent
  | RuntimeRunCompletedEvent
  | RuntimeRunFailedEvent;

export type RuntimeRunEventSink = (event: RuntimeRunEvent) => void | Promise<void>;
