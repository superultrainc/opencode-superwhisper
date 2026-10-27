export const LOG_PREFIX = "[@superwhisper/opencode]"
export const PLUGIN_ID = "superwhisper"
export const MESSAGE_DIR = "/tmp/superwhisper-agent"
export const POLL_INTERVAL_MS = 1_000
export const POLL_TIMEOUT_MS = 30 * 60 * 1_000

export enum EndReason {
  END_TURN = "end_turn",
  STOP = "stop",
}

export type LogLevel = "debug" | "info" | "warn" | "error"
export type PermissionReply = "once" | "always" | "reject"

export interface Question {
  question: string
  header?: string
  options?: { label: string; description?: string }[]
  multiple?: boolean
  multiSelect?: boolean
}

/** A pending OpenCode request. `sessionId` is needed by V2's session-scoped routes. */
export interface RequestRef {
  id: string
  sessionId: string
}

/** Version-independent view of OpenCode events. Each adapter maps its own events into these. */
export type EngineEvent =
  | { type: "idle"; sessionId: string }
  | { type: "busy"; sessionId: string }
  | { type: "error"; sessionId: string; message: string }
  | {
      type: "permission.asked"
      id: string
      sessionId: string
      permission: string
      patterns: string[]
      toolName?: string
    }
  | { type: "permission.replied"; id: string; sessionId: string; reply?: string }
  | { type: "question.asked"; id: string; sessionId: string; questions: Question[] }
  | { type: "question.closed"; sessionId: string }
  | { type: "session.info"; sessionId: string; title?: string; parentId?: string }

export interface AssistantTurn {
  text: string
  endTurn: boolean
}

/** What the engine needs from OpenCode. V1 and V2 each implement this. */
export interface Host {
  /** e.g. "1.18.34" or "2.0.0-beta.1"; sent to Superwhisper for diagnostics. */
  readonly opencodeVersion?: string
  readonly apiVersion: 1 | 2
  readonly directory: string
  readonly projectName: string
  log(level: LogLevel, message: string): void
  lastAssistant(sessionId: string): Promise<AssistantTurn | undefined>
  prompt(sessionId: string, text: string): Promise<void>
  replyQuestion(request: RequestRef, answers: string[][]): Promise<void>
  rejectQuestion(request: RequestRef): Promise<void>
  replyPermission(request: RequestRef, reply: PermissionReply): Promise<void>
}
