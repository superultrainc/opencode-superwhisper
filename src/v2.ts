import { readFileSync } from "fs"
import { homedir } from "os"
import { basename, join } from "path"
import { createEngine } from "./engine.js"
import { debugFileLog } from "./system.js"
import { LOG_PREFIX, type EngineEvent, type Host, type LogLevel, type Question } from "./types.js"

// Minimal structural view of the OpenCode 2 promise plugin context (@opencode-ai/plugin@beta).
// Typed locally so the published bundle doesn't pull in the beta packages.
export interface V2Context {
  app: { version: string; channel?: string }
  location: { directory: string; project?: { id: string } }
  event: { subscribe(options?: { signal?: AbortSignal }): AsyncIterable<V2Event> }
  session: {
    context(input: { sessionID: string }): Promise<V2Message[]>
    prompt(input: { sessionID: string; text: string }): Promise<unknown>
  }
  permission: {
    reply(input: { sessionID: string; requestID: string; reply: "once" | "always" | "reject" }): Promise<unknown>
  }
  tool: { transform(callback: (editor: { add(tool: V2Tool): void }) => void): Promise<unknown> }
}

export interface V2Event {
  type: string
  data?: any
}

interface V2Message {
  type: string
  content?: { type: string; text?: string }[]
  finish?: string
}

interface V2Tool {
  name: string
  description: string
  input: Record<string, unknown>
  options?: { codemode?: boolean }
  execute(input: any, context: { sessionID: string }): Promise<{ content: string }>
}

interface FormField {
  key: string
  type: string
  title?: string
  description?: string
  options?: { value: string; label: string; description?: string }[]
  when?: unknown[]
}

export interface Form {
  id: string
  sessionID: string
  title: string
  metadata?: { kind?: string }
  fields: FormField[]
}

const DEBUG = !!process.env.SUPERWHISPER_DEBUG
const BOOLEAN_OPTIONS: { value: string; label: string; description?: string }[] = [
  { value: "true", label: "Yes" },
  { value: "false", label: "No" },
]

function fieldOptions(field: FormField) {
  return field.type === "boolean" ? BOOLEAN_OPTIONS : field.options
}

/** Forms become Superwhisper questions only when every field is a pick-from-options field. */
export function formToQuestions(form: Form): Question[] | undefined {
  const pickable = form.fields.every(
    (f) =>
      !f.when?.length &&
      (f.type === "boolean" ||
        ((f.type === "string" || f.type === "multiselect") && (f.options?.length ?? 0) > 0)),
  )
  if (!pickable || !form.fields.length) return undefined
  // The question tool puts the header in `title` and the question in `description`.
  const fromQuestionTool = form.metadata?.kind === "question"
  return form.fields.map((field) => ({
    question: (fromQuestionTool && field.description) || field.title || form.title,
    header: fromQuestionTool ? field.title : form.fields.length > 1 ? form.title : undefined,
    options: (fieldOptions(field) ?? []).map((o) => ({ label: o.label, description: o.description })),
    multiSelect: field.type === "multiselect",
  }))
}

/** Maps Superwhisper's per-question labels back to form values. Unknown labels pass through as custom text. */
export function answersToForm(form: Form, answers: string[][]): Record<string, string | boolean | string[]> {
  const result: Record<string, string | boolean | string[]> = {}
  form.fields.forEach((field, i) => {
    const labels = answers[i] ?? []
    const values = labels.map(
      (label) => fieldOptions(field)?.find((o) => o.label === label || o.value === label)?.value ?? label,
    )
    if (!values.length) return
    if (field.type === "multiselect") result[field.key] = values
    else if (field.type === "boolean") result[field.key] = values[0] === "true"
    else result[field.key] = values[0]!
  })
  return result
}

export function mapV2Event(e: V2Event, forms?: Map<string, Form>): EngineEvent | undefined {
  const d = e.data || {}
  switch (e.type) {
    // Turn boundaries; the plugin event stream doesn't carry session.status/session.idle.
    case "session.execution.started":
      return d.sessionID ? { type: "busy", sessionId: d.sessionID } : undefined

    case "session.execution.succeeded":
      return d.sessionID ? { type: "idle", sessionId: d.sessionID } : undefined

    case "session.execution.failed":
      return d.sessionID
        ? { type: "error", sessionId: d.sessionID, message: d.error?.message || "An error occurred" }
        : undefined

    case "permission.asked":
      if (!d.id || !d.sessionID) return
      return {
        type: "permission.asked",
        id: d.id,
        sessionId: d.sessionID,
        permission: d.action || "unknown",
        patterns: d.resources || [],
      }

    case "permission.replied":
      return d.requestID && d.sessionID
        ? { type: "permission.replied", id: d.requestID, sessionId: d.sessionID, reply: d.reply }
        : undefined

    case "form.created": {
      const form = d.form as Form | undefined
      if (!form?.id || !form.sessionID || !Array.isArray(form.fields)) return
      const questions = formToQuestions(form)
      if (!questions) return
      forms?.set(form.id, form)
      return { type: "question.asked", id: form.id, sessionId: form.sessionID, questions }
    }

    case "form.replied":
    case "form.cancelled":
      if (d.id) forms?.delete(d.id)
      return d.sessionID ? { type: "question.closed", sessionId: d.sessionID } : undefined

    case "session.created":
      return d.sessionID
        ? { type: "session.info", sessionId: d.sessionID, title: d.title, parentId: d.parentID }
        : undefined

    case "session.renamed":
      return d.sessionID ? { type: "session.info", sessionId: d.sessionID, title: d.title } : undefined
  }
}

interface ServiceEndpoint {
  url: string
  headers: Record<string, string>
}

/**
 * Forms have no plugin API in OpenCode 2, so they're answered over HTTP. The local
 * service registers its URL and password here; only trust it if it's this process.
 */
export function readServiceEndpoint(
  file = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode", "service.json"),
  pid = process.pid,
): ServiceEndpoint | undefined {
  try {
    const info = JSON.parse(readFileSync(file, "utf8"))
    if (info?.pid !== pid || typeof info.url !== "string") return undefined
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (typeof info.password === "string") {
      headers.authorization = "Basic " + Buffer.from(`opencode:${info.password}`).toString("base64")
    }
    return { url: info.url, headers }
  } catch {
    return undefined
  }
}

export async function setup(ctx: V2Context): Promise<() => void> {
  const forms = new Map<string, Form>()
  const abort = new AbortController()

  function log(level: LogLevel, message: string) {
    if (!DEBUG) return
    console.error(`${LOG_PREFIX} [${level}] ${message}`)
    debugFileLog(level, message)
  }

  async function formRequest(method: "POST" | "DELETE", path: string, body?: unknown) {
    const endpoint = readServiceEndpoint()
    if (!endpoint) throw new Error("OpenCode service endpoint not found")
    const res = await fetch(new URL(path, endpoint.url), {
      method,
      headers: endpoint.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`${method} ${path} failed (${res.status})`)
  }

  const host: Host = {
    apiVersion: 2,
    opencodeVersion: ctx.app?.version,
    directory: ctx.location.directory,
    projectName: basename(ctx.location.directory) || ctx.location.project?.id || "",
    log,

    async lastAssistant(sessionId) {
      const messages = await ctx.session.context({ sessionID: sessionId })
      const last = messages.filter((m) => m.type === "assistant").at(-1)
      if (!last) return undefined
      const text = (last.content ?? [])
        .filter((p) => p.type === "text")
        .map((p) => p.text || "")
        .join("\n")
        .trim()
      return { text, endTurn: last.finish === "stop" }
    },

    async prompt(sessionId, text) {
      await ctx.session.prompt({ sessionID: sessionId, text })
    },

    async replyQuestion(request, answers) {
      const form = forms.get(request.id)
      if (!form) throw new Error(`Unknown form ${request.id}`)
      await formRequest(
        "POST",
        `/api/session/${encodeURIComponent(request.sessionId)}/form/${encodeURIComponent(request.id)}/reply`,
        { answer: answersToForm(form, answers) },
      )
    },

    async rejectQuestion(request) {
      await formRequest(
        "DELETE",
        `/api/session/${encodeURIComponent(request.sessionId)}/form/${encodeURIComponent(request.id)}`,
      )
    },

    async replyPermission(request, reply) {
      await ctx.permission.reply({ sessionID: request.sessionId, requestID: request.id, reply })
    },
  }

  const engine = await createEngine(host)

  await ctx.tool.transform((editor) =>
    editor.add({
      name: "superwhisper_toggle",
      description:
        "Enable or disable Superwhisper voice notifications for this session. Use action='disable' when the user wants to turn Superwhisper off, and action='enable' when they want to turn it back on.",
      input: {
        type: "object",
        properties: { action: { type: "string", enum: ["enable", "disable"] } },
        required: ["action"],
        additionalProperties: false,
      },
      // Direct tool; otherwise OpenCode 2 hides it behind code mode's `execute`.
      options: { codemode: false },
      async execute(input: { action: "enable" | "disable" }, context) {
        const enabled = input.action === "enable"
        engine.setEnabled(context.sessionID, enabled)
        return {
          content: `Superwhisper voice notifications ${enabled ? "re-enabled" : "disabled"} for this session.`,
        }
      },
    }),
  )

  // Resubscribe if the stream drops; stop on cleanup.
  void (async () => {
    while (!abort.signal.aborted) {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          log("debug", `Event: ${event.type} ${JSON.stringify(event.data ?? {}).substring(0, 300)}`)
          const mapped = mapV2Event(event, forms)
          if (mapped) engine.handle(mapped)
        }
      } catch (err) {
        if (abort.signal.aborted) break
        log("warn", `Event stream ended: ${err}`)
      }
      if (!abort.signal.aborted) await new Promise((r) => setTimeout(r, 1_000))
    }
  })()

  return () => {
    abort.abort()
    engine.dispose()
  }
}
