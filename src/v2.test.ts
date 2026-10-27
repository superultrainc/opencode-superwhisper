import { describe, it, expect, beforeAll, afterEach } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { answersToForm, formToQuestions, mapV2Event, readServiceEndpoint, setup, type Form, type V2Context, type V2Event } from "./v2.js"
import { __setInboxDirForTest, type InboxPayload } from "./inbox.js"
import { __setRunnerForTest } from "./system.js"
import { MESSAGE_DIR } from "./types.js"

const INBOX = "/tmp/superwhisper-test-inbox-v2"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let counter = 0
const uid = (p: string) => `${p}-${process.pid}-${Date.now()}-${counter++}`

function updates(sessionId: string): InboxPayload[] {
  if (!existsSync(INBOX)) return []
  return readdirSync(INBOX)
    .filter((n) => n.endsWith(".json"))
    .map((n) => JSON.parse(readFileSync(join(INBOX, n), "utf8")) as InboxPayload)
    .filter((p) => p.sessionId === sessionId && p.kind === "update")
}

async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 3000): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = fn()
    if (v) return v
    await sleep(20)
  }
  throw new Error("waitFor timed out")
}

const form = (fields: Form["fields"], extra: Partial<Form> = {}): Form => ({
  id: "f1",
  sessionID: "s1",
  title: "Form title",
  fields,
  ...extra,
})

const pickField = { key: "color", type: "string", title: "Color?", options: [
  { value: "r", label: "Red", description: "warm" },
  { value: "b", label: "Blue" },
] }

describe("mapV2Event", () => {
  it("maps execution start/success to busy/idle", () => {
    expect(mapV2Event({ type: "session.execution.succeeded", data: { sessionID: "s" } })).toEqual({ type: "idle", sessionId: "s" })
    expect(mapV2Event({ type: "session.execution.started", data: { sessionID: "s" } })).toEqual({ type: "busy", sessionId: "s" })
    expect(mapV2Event({ type: "session.execution.succeeded", data: {} })).toBeUndefined()
    // Not delivered to plugins in the beta; ignored so a future server can't double-notify.
    expect(mapV2Event({ type: "session.status", data: { sessionID: "s", status: { type: "idle" } } })).toBeUndefined()
    expect(mapV2Event({ type: "session.idle", data: { sessionID: "s" } })).toBeUndefined()
  })

  it("maps session.execution.failed", () => {
    expect(mapV2Event({ type: "session.execution.failed", data: { sessionID: "s", error: { message: "bad" } } })).toEqual({
      type: "error",
      sessionId: "s",
      message: "bad",
    })
    expect(mapV2Event({ type: "session.execution.failed", data: { sessionID: "s" } })).toMatchObject({ message: "An error occurred" })
    expect(mapV2Event({ type: "session.execution.failed", data: {} })).toBeUndefined()
  })

  it("maps permission.asked using action and resources", () => {
    expect(
      mapV2Event({ type: "permission.asked", data: { id: "p", sessionID: "s", action: "bash", resources: ["ls"] } }),
    ).toEqual({ type: "permission.asked", id: "p", sessionId: "s", permission: "bash", patterns: ["ls"] })
    expect(mapV2Event({ type: "permission.asked", data: { id: "p", sessionID: "s" } })).toMatchObject({
      permission: "unknown",
      patterns: [],
    })
    expect(mapV2Event({ type: "permission.asked", data: { sessionID: "s" } })).toBeUndefined()
  })

  it("maps permission.replied", () => {
    expect(
      mapV2Event({ type: "permission.replied", data: { requestID: "p", sessionID: "s", reply: "once" } }),
    ).toEqual({ type: "permission.replied", id: "p", sessionId: "s", reply: "once" })
    expect(mapV2Event({ type: "permission.replied", data: { sessionID: "s" } })).toBeUndefined()
  })

  it("maps pickable form.created and remembers the form", () => {
    const forms = new Map<string, Form>()
    const f = form([pickField])
    const mapped = mapV2Event({ type: "form.created", data: { form: f } }, forms)
    expect(mapped).toEqual({
      type: "question.asked",
      id: "f1",
      sessionId: "s1",
      questions: [
        { question: "Color?", header: undefined, options: [{ label: "Red", description: "warm" }, { label: "Blue", description: undefined }], multiSelect: false },
      ],
    })
    expect(forms.get("f1")).toBe(f)
  })

  it("ignores non-pickable and malformed forms", () => {
    const forms = new Map<string, Form>()
    expect(mapV2Event({ type: "form.created", data: { form: form([{ key: "n", type: "number" }]) } }, forms)).toBeUndefined()
    expect(mapV2Event({ type: "form.created", data: { form: form([{ ...pickField, when: [{}] }]) } }, forms)).toBeUndefined()
    expect(mapV2Event({ type: "form.created", data: { form: form([]) } }, forms)).toBeUndefined()
    expect(mapV2Event({ type: "form.created", data: { form: { id: "x" } } }, forms)).toBeUndefined()
    expect(mapV2Event({ type: "form.created", data: {} }, forms)).toBeUndefined()
    expect(forms.size).toBe(0)
  })

  it("maps form.replied and form.cancelled and forgets the form", () => {
    for (const type of ["form.replied", "form.cancelled"]) {
      const forms = new Map<string, Form>([["f1", form([pickField])]])
      expect(mapV2Event({ type, data: { id: "f1", sessionID: "s1" } }, forms)).toEqual({ type: "question.closed", sessionId: "s1" })
      expect(forms.has("f1")).toBe(false)
    }
    expect(mapV2Event({ type: "form.replied", data: { id: "f1" } })).toBeUndefined()
  })

  it("maps session.created with parentID and session.renamed", () => {
    expect(mapV2Event({ type: "session.created", data: { sessionID: "s", title: "T", parentID: "p" } })).toEqual({
      type: "session.info",
      sessionId: "s",
      title: "T",
      parentId: "p",
    })
    expect(mapV2Event({ type: "session.renamed", data: { sessionID: "s", title: "New" } })).toEqual({
      type: "session.info",
      sessionId: "s",
      title: "New",
    })
    expect(mapV2Event({ type: "session.created", data: {} })).toBeUndefined()
    expect(mapV2Event({ type: "session.renamed", data: {} })).toBeUndefined()
  })

  it("ignores unknown events", () => {
    expect(mapV2Event({ type: "something.else", data: {} })).toBeUndefined()
    expect(mapV2Event({ type: "session.status" })).toBeUndefined()
  })
})

describe("formToQuestions", () => {
  it("builds headers only for multi-field forms", () => {
    expect(formToQuestions(form([pickField]))![0]!.header).toBeUndefined()
    const qs = formToQuestions(form([pickField, { key: "b", type: "boolean", title: "Sure?" }]))!
    expect(qs.map((q) => q.header)).toEqual(["Form title", "Form title"])
  })

  it("uses description as the question for question-tool forms", () => {
    const f: Form = {
      id: "frm_q",
      sessionID: "s",
      title: "Questions",
      metadata: { kind: "question" },
      fields: [{ key: "q0", type: "string", title: "Color", description: "Pick a color?", options: [{ value: "Red", label: "Red" }] }],
    }
    expect(formToQuestions(f)![0]).toMatchObject({ question: "Pick a color?", header: "Color" })
  })

  it("turns booleans into Yes/No options", () => {
    const [q] = formToQuestions(form([{ key: "b", type: "boolean", title: "Sure?" }]))!
    expect(q).toMatchObject({ question: "Sure?", multiSelect: false })
    expect(q!.options!.map((o) => o.label)).toEqual(["Yes", "No"])
  })

  it("marks multiselect fields and falls back to the form title", () => {
    const [q] = formToQuestions(form([{ key: "m", type: "multiselect", options: [{ value: "a", label: "A" }] }]))!
    expect(q).toMatchObject({ question: "Form title", multiSelect: true })
  })

  it("rejects text/number fields, empty options, conditional fields and empty forms", () => {
    expect(formToQuestions(form([{ key: "t", type: "text" }]))).toBeUndefined()
    expect(formToQuestions(form([{ key: "s", type: "string", options: [] }]))).toBeUndefined()
    expect(formToQuestions(form([pickField, { key: "n", type: "number" }]))).toBeUndefined()
    expect(formToQuestions(form([{ ...pickField, when: [1] }]))).toBeUndefined()
    expect(formToQuestions(form([]))).toBeUndefined()
  })
})

describe("answersToForm", () => {
  const f = form([
    pickField,
    { key: "ok", type: "boolean" },
    { key: "tags", type: "multiselect", options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }] },
  ])

  it("maps labels to values", () => {
    expect(answersToForm(f, [["Blue"], ["Yes"], ["X", "Y"]])).toEqual({ color: "b", ok: true, tags: ["x", "y"] })
  })

  it("maps No to false", () => {
    expect(answersToForm(f, [["Red"], ["No"], ["Y"]])).toEqual({ color: "r", ok: false, tags: ["y"] })
  })

  it("accepts raw values and passes custom text through", () => {
    expect(answersToForm(f, [["Something else"], ["true"], ["X", "custom"]])).toEqual({
      color: "Something else",
      ok: true,
      tags: ["x", "custom"],
    })
  })

  it("omits fields without answers", () => {
    expect(answersToForm(f, [["Red"], [], undefined as any])).toEqual({ color: "r" })
  })
})

describe("readServiceEndpoint", () => {
  let dir: string
  const file = () => join(dir, "service.json")
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "sw-v2-svc-"))
  })

  it("returns undefined for a pid mismatch", () => {
    writeFileSync(file(), JSON.stringify({ pid: 1, url: "http://127.0.0.1:1" }))
    expect(readServiceEndpoint(file(), 2)).toBeUndefined()
  })

  it("returns undefined for a missing file, bad JSON or missing url", () => {
    expect(readServiceEndpoint(join(dir, "nope.json"), 1)).toBeUndefined()
    writeFileSync(file(), "not json")
    expect(readServiceEndpoint(file(), 1)).toBeUndefined()
    writeFileSync(file(), JSON.stringify({ pid: 1 }))
    expect(readServiceEndpoint(file(), 1)).toBeUndefined()
  })

  it("returns url without auth when there is no password", () => {
    writeFileSync(file(), JSON.stringify({ pid: 1, url: "http://127.0.0.1:9" }))
    const ep = readServiceEndpoint(file(), 1)!
    expect(ep.url).toBe("http://127.0.0.1:9")
    expect(ep.headers.authorization).toBeUndefined()
    expect(ep.headers["Content-Type"]).toBe("application/json")
  })

  it("adds a Basic opencode:<password> header", () => {
    writeFileSync(file(), JSON.stringify({ pid: 1, url: "http://127.0.0.1:9", password: "secret" }))
    expect(readServiceEndpoint(file(), 1)!.headers.authorization).toBe(
      "Basic " + Buffer.from("opencode:secret").toString("base64"),
    )
  })
})

// --- setup() with a fake OpenCode 2 context ---

class EventFeed {
  private queue: V2Event[] = []
  private waiter?: () => void
  subscribeCalls = 0
  signals: AbortSignal[] = []
  failFirst = false

  push(e: V2Event) {
    this.queue.push(e)
    this.waiter?.()
  }

  subscribe = (options?: { signal?: AbortSignal }): AsyncIterable<V2Event> => {
    this.subscribeCalls++
    if (options?.signal) this.signals.push(options.signal)
    const self = this
    if (this.failFirst && this.subscribeCalls === 1) {
      return {
        [Symbol.asyncIterator]() {
          return { next: () => Promise.reject(new Error("stream dropped")) }
        },
      }
    }
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            while (!self.queue.length) {
              if (options?.signal?.aborted) return { done: true as const, value: undefined }
              await new Promise<void>((r) => {
                self.waiter = r
                options?.signal?.addEventListener("abort", () => r(), { once: true })
              })
            }
            return { done: false as const, value: self.queue.shift()! }
          },
        }
      },
    }
  }
}

function makeCtx(assistant: { text: string; finish?: string } | undefined = { text: "All done", finish: "stop" }) {
  const feed = new EventFeed()
  const tools: any[] = []
  const prompts: any[] = []
  const permissionReplies: any[] = []
  const ctx: V2Context = {
    app: { version: "2.0.0-test" },
    location: { directory: "/tmp/v2-project" },
    event: { subscribe: feed.subscribe },
    session: {
      context: async () => [
        { type: "user", content: [{ type: "text", text: "hi" }] },
        ...(assistant ? [{ type: "assistant", content: [{ type: "text", text: assistant.text }], finish: assistant.finish }] : []),
      ],
      prompt: async (input) => {
        prompts.push(input)
      },
    },
    permission: {
      reply: async (input) => {
        permissionReplies.push(input)
      },
    },
    tool: {
      transform: async (cb) => {
        cb({ add: (t) => tools.push(t) })
      },
    },
  }
  return { ctx, feed, tools, prompts, permissionReplies }
}

let cleanups: (() => void)[] = []
let files: string[] = []

beforeAll(() => {
  rmSync(INBOX, { recursive: true, force: true })
  mkdirSync(MESSAGE_DIR, { recursive: true })
  __setInboxDirForTest(INBOX)
  __setRunnerForTest(async (cmd) => ({ code: 0, stdout: cmd === "git" ? "main\n" : "" }))
})

afterEach(() => {
  for (const c of cleanups) c()
  cleanups = []
  for (const f of files) rmSync(f, { force: true })
  files = []
})

async function boot(c = makeCtx()) {
  const cleanup = await setup(c.ctx)
  cleanups.push(cleanup)
  return { ...c, cleanup }
}

const status = (sid: string, type: string): V2Event => ({
  type: type === "idle" ? "session.execution.succeeded" : "session.execution.started",
  data: { sessionID: sid },
})

describe("v2 setup()", () => {
  it("registers superwhisper_toggle via ctx.tool.transform", async () => {
    const { tools } = await boot()
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe("superwhisper_toggle")
    expect(tools[0].options).toEqual({ codemode: false })
    expect(tools[0].input.properties.action.enum).toEqual(["enable", "disable"])
  })

  it("the toggle tool disables and re-enables a session", async () => {
    const { tools, feed } = await boot()
    const sid = uid("v2toggle")
    files.push(`${MESSAGE_DIR}/disabled-${sid}`)
    const off = await tools[0].execute({ action: "disable" }, { sessionID: sid })
    expect(off.content).toContain("disabled")
    expect(existsSync(`${MESSAGE_DIR}/disabled-${sid}`)).toBe(true)
    feed.push(status(sid, "idle"))
    await sleep(200)
    expect(updates(sid)).toEqual([])

    const on = await tools[0].execute({ action: "enable" }, { sessionID: sid })
    expect(on.content).toContain("re-enabled")
    expect(existsSync(`${MESSAGE_DIR}/disabled-${sid}`)).toBe(false)
  })

  it("idle event writes a payload and the response goes to ctx.session.prompt", async () => {
    const { feed, prompts } = await boot()
    const sid = uid("v2idle")
    feed.push({ type: "session.renamed", data: { sessionID: sid, title: "Named" } })
    feed.push(status(sid, "idle"))
    const [p] = await waitFor(() => updates(sid).length > 0 && updates(sid))
    expect(p).toMatchObject({ status: "completed", summary: "All done", title: "Named", project: "v2-project", branch: "main" })
    writeFileSync(p!.responseFile!, "keep going")
    await waitFor(() => prompts.length > 0)
    expect(prompts).toEqual([{ sessionID: sid, text: "keep going" }])
  })

  it("skips idle when the assistant message did not finish with stop", async () => {
    const { feed } = await boot(makeCtx({ text: "thinking", finish: "tool-calls" }))
    const sid = uid("v2mid")
    feed.push(status(sid, "idle"))
    await sleep(250)
    expect(updates(sid)).toEqual([])
  })

  it("permission events reply through ctx.permission.reply", async () => {
    const { feed, permissionReplies } = await boot()
    const sid = uid("v2perm")
    const id = uid("pid")
    feed.push({ type: "permission.asked", data: { id, sessionID: sid, action: "bash", resources: ["ls"] } })
    const [p] = await waitFor(() => updates(sid).length > 0 && updates(sid))
    expect(p!.status).toBe("permission")
    writeFileSync(p!.responseFile!, "Allow")
    await waitFor(() => permissionReplies.length > 0)
    expect(permissionReplies).toEqual([{ sessionID: sid, requestID: id, reply: "once" }])
  })

  it("execution failures write an error payload", async () => {
    const { feed } = await boot()
    const sid = uid("v2err")
    feed.push({ type: "session.execution.failed", data: { sessionID: sid, error: { message: "kaput" } } })
    const [p] = await waitFor(() => updates(sid).length > 0 && updates(sid))
    expect(p).toMatchObject({ status: "error", summary: "kaput" })
  })

  it("cleanup aborts the subscription", async () => {
    const { feed, cleanup } = await boot()
    await waitFor(() => feed.signals.length > 0)
    expect(feed.signals[0]!.aborted).toBe(false)
    cleanup()
    expect(feed.signals[0]!.aborted).toBe(true)
    const calls = feed.subscribeCalls
    await sleep(1200)
    expect(feed.subscribeCalls).toBe(calls)
  })

  it("resubscribes when the stream drops", async () => {
    const c = makeCtx()
    c.feed.failFirst = true
    await boot(c)
    await waitFor(() => c.feed.subscribeCalls >= 2, 3000)
  })

  it("answers forms over the local service API", async () => {
    const requests: { method: string; path: string; auth: string | null; body: any }[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const text = await req.text()
        requests.push({
          method: req.method,
          path: new URL(req.url).pathname,
          auth: req.headers.get("authorization"),
          body: text ? JSON.parse(text) : undefined,
        })
        return new Response("{}")
      },
    })
    const stateDir = mkdtempSync(join(tmpdir(), "sw-v2-state-"))
    mkdirSync(join(stateDir, "opencode"), { recursive: true })
    writeFileSync(
      join(stateDir, "opencode", "service.json"),
      JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${server.port}`, password: "pw" }),
    )
    const prev = process.env.XDG_STATE_HOME
    process.env.XDG_STATE_HOME = stateDir
    try {
      const { feed } = await boot()
      const sid = uid("v2form")
      const fid = uid("form")
      feed.push({
        type: "form.created",
        data: { form: { id: fid, sessionID: sid, title: "Pick", fields: [pickField, { key: "ok", type: "boolean", title: "Sure?" }] } },
      })
      const [p] = await waitFor(() => updates(sid).length > 0 && updates(sid))
      expect(p!.status).toBe("question")
      writeFileSync(p!.responseFile!, '{"answers":[["Blue"],["Yes"]]}')
      await waitFor(() => requests.length > 0)
      expect(requests[0]).toEqual({
        method: "POST",
        path: `/api/session/${sid}/form/${fid}/reply`,
        auth: "Basic " + Buffer.from("opencode:pw").toString("base64"),
        body: { answer: { color: "b", ok: true } },
      })
    } finally {
      if (prev === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = prev
      server.stop(true)
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
