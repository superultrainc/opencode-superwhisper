import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { createEngine } from "./engine.js"
import { extractFullText, isEndTurn } from "./message.js"
import { debugFileLog } from "./system.js"
import {
  LOG_PREFIX,
  type EngineEvent,
  type Host,
  type LogLevel,
} from "./types.js"

const DEBUG = !!process.env.SUPERWHISPER_DEBUG

/** OpenCode errors arrive as `{ name, data: { message } }` objects, not strings. */
export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error
  const e = error as any
  return e?.data?.message || e?.message || e?.name || "An error occurred"
}

/** Maps a V1 bus event to an engine event. Covers 1.0 (`permission.updated`) through 1.18. */
export function mapV1Event(e: any, legacyPermissionIds?: Set<string>): EngineEvent | undefined {
  const props = e?.properties || {}
  switch (e?.type as string) {
    case "session.idle":
      return props.sessionID ? { type: "idle", sessionId: props.sessionID } : undefined

    case "session.busy":
      return props.sessionID ? { type: "busy", sessionId: props.sessionID } : undefined

    // session.idle is still emitted alongside status=idle, so only busy is taken from here.
    case "session.status":
      return props.sessionID && props.status?.type === "busy"
        ? { type: "busy", sessionId: props.sessionID }
        : undefined

    case "session.error":
      // No session to answer, and aborts are the user pressing Escape.
      if (!props.sessionID || props.error?.name === "MessageAbortedError") return
      return { type: "error", sessionId: props.sessionID, message: errorMessage(props.error) }

    case "permission.asked":
      if (!props.id || !props.sessionID) return
      return {
        type: "permission.asked",
        id: props.id,
        sessionId: props.sessionID,
        permission: props.permission || "unknown",
        patterns: props.patterns || [],
        toolName: props.tool?.tool,
      }

    // OpenCode 1.0.x permission system.
    case "permission.updated": {
      if (!props.id || !props.sessionID) return
      legacyPermissionIds?.add(props.id)
      const pattern = props.pattern
      return {
        type: "permission.asked",
        id: props.id,
        sessionId: props.sessionID,
        permission: props.type || "unknown",
        patterns: pattern === undefined ? [] : Array.isArray(pattern) ? pattern : [pattern],
        toolName: props.title,
      }
    }

    case "permission.replied": {
      const id = props.requestID || props.permissionID || props.id
      if (!id || !props.sessionID) return
      return {
        type: "permission.replied",
        id,
        sessionId: props.sessionID,
        reply: props.reply || props.response,
      }
    }

    case "question.asked": {
      const q = e.properties || e
      if (!q.id || !q.sessionID) return
      return {
        type: "question.asked",
        id: q.id,
        sessionId: q.sessionID,
        questions: q.questions || [],
      }
    }

    case "question.replied":
    case "question.rejected":
    case "question.answered":
      return props.sessionID ? { type: "question.closed", sessionId: props.sessionID } : undefined

    case "session.created":
    case "session.updated":
      return props.info?.id
        ? {
            type: "session.info",
            sessionId: props.info.id,
            title: typeof props.info.title === "string" ? props.info.title : undefined,
            parentId: props.info.parentID,
          }
        : undefined
  }
}

export async function server(input: PluginInput): Promise<Hooks> {
  const { client, directory, project } = input
  const raw = (client as any)._client
  const legacyPermissionIds = new Set<string>()

  async function post(url: string, body?: unknown) {
    if (!raw?.post) throw new Error("No internal client.post available")
    const result = await raw.post({
      url,
      ...(body ? { body, headers: { "Content-Type": "application/json" } } : {}),
    })
    const status = result?.response?.status
    if (result?.error || (typeof status === "number" && status >= 400)) {
      throw new Error(`POST ${url} failed (${status ?? "no status"})`)
    }
    return result
  }

  // /global/health exists from ~1.1; older servers just report "unknown".
  async function detectVersion(): Promise<string | undefined> {
    try {
      const result = await raw?.get?.({ url: "/global/health" })
      const version = result?.data?.version
      return typeof version === "string" ? version : undefined
    } catch {
      return undefined
    }
  }

  function log(level: LogLevel, message: string) {
    if (!DEBUG) return
    client.app
      .log({ body: { service: "superwhisper", level, message: `${LOG_PREFIX} ${message}` } })
      ?.catch?.(() => {})
    debugFileLog(level, message)
  }

  const host: Host = {
    apiVersion: 1,
    opencodeVersion: await detectVersion(),
    directory,
    projectName: directory.split("/").pop() || project?.id || "",
    log,

    async lastAssistant(sessionId) {
      const res = await client.session.messages({ path: { id: sessionId } })
      const last = (res.data || []).filter((m: any) => m.info?.role === "assistant").pop()
      if (!last) return undefined
      return { text: extractFullText(last), endTurn: isEndTurn(last) }
    },

    async prompt(sessionId, text) {
      const result: any = await client.session.prompt({
        path: { id: sessionId },
        body: { parts: [{ type: "text", text }] },
      })
      if (result?.error) throw new Error(`prompt failed: ${JSON.stringify(result.error)}`)
    },

    async replyQuestion(request, answers) {
      await post(`/question/${request.id}/reply`, { answers })
    },

    async rejectQuestion(request) {
      await post(`/question/${request.id}/reject`)
    },

    async replyPermission(request, reply) {
      if (legacyPermissionIds.delete(request.id)) {
        await post(`/session/${request.sessionId}/permissions/${request.id}`, { response: reply })
        return
      }
      await post(`/permission/${request.id}/reply`, { reply })
    },
  }

  const engine = await createEngine(host)

  return {
    tool: {
      superwhisper_toggle: tool({
        description:
          "Enable or disable Superwhisper voice notifications for this session. Use action='disable' when the user wants to turn Superwhisper off, and action='enable' when they want to turn it back on.",
        args: {
          action: tool.schema.enum(["enable", "disable"]),
        },
        execute: async (args, context) => {
          const enabled = args.action === "enable"
          engine.setEnabled(context.sessionID, enabled)
          return `Superwhisper voice notifications ${enabled ? "re-enabled" : "disabled"} for this session.`
        },
      }),
    },
    event: async ({ event }) => {
      log("debug", `Event: ${event.type} ${JSON.stringify((event as any).properties || {}).substring(0, 300)}`)
      const mapped = mapV1Event(event, legacyPermissionIds)
      if (mapped) engine.handle(mapped)
    },
  }
}
