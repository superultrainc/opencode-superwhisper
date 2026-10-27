import { describe, it, expect, beforeAll, afterEach } from "bun:test"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { errorMessage, mapV1Event, server } from "./v1.js"
import { __setInboxDirForTest, type InboxPayload } from "./inbox.js"
import { __setRunnerForTest } from "./system.js"
import { MESSAGE_DIR } from "./types.js"

const INBOX = "/tmp/superwhisper-test-inbox-v1"
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

describe("errorMessage", () => {
  it("handles strings, data.message, message, name and fallback", () => {
    expect(errorMessage("plain")).toBe("plain")
    expect(errorMessage({ name: "UnknownError", data: { message: "boom" } })).toBe("boom")
    expect(errorMessage({ message: "m" })).toBe("m")
    expect(errorMessage({ name: "ProviderAuthError" })).toBe("ProviderAuthError")
    expect(errorMessage(undefined)).toBe("An error occurred")
    expect(errorMessage({})).toBe("An error occurred")
  })
})

describe("mapV1Event", () => {
  it("maps session.idle", () => {
    expect(mapV1Event({ type: "session.idle", properties: { sessionID: "s" } })).toEqual({ type: "idle", sessionId: "s" })
    expect(mapV1Event({ type: "session.idle", properties: {} })).toBeUndefined()
  })

  it("maps session.busy", () => {
    expect(mapV1Event({ type: "session.busy", properties: { sessionID: "s" } })).toEqual({ type: "busy", sessionId: "s" })
    expect(mapV1Event({ type: "session.busy", properties: {} })).toBeUndefined()
  })

  it("maps session.status busy but not idle", () => {
    expect(mapV1Event({ type: "session.status", properties: { sessionID: "s", status: { type: "busy" } } })).toEqual({
      type: "busy",
      sessionId: "s",
    })
    expect(mapV1Event({ type: "session.status", properties: { sessionID: "s", status: { type: "idle" } } })).toBeUndefined()
    expect(mapV1Event({ type: "session.status", properties: { status: { type: "busy" } } })).toBeUndefined()
  })

  it("maps session.error with an object error", () => {
    expect(
      mapV1Event({
        type: "session.error",
        properties: { sessionID: "s", error: { name: "UnknownError", data: { message: "boom" } } },
      }),
    ).toEqual({ type: "error", sessionId: "s", message: "boom" })
  })

  it("ignores aborted errors and errors without a session", () => {
    expect(
      mapV1Event({ type: "session.error", properties: { sessionID: "s", error: { name: "MessageAbortedError" } } }),
    ).toBeUndefined()
    expect(mapV1Event({ type: "session.error", properties: { error: { name: "X" } } })).toBeUndefined()
  })

  it("maps permission.asked", () => {
    expect(
      mapV1Event({
        type: "permission.asked",
        properties: { id: "p", sessionID: "s", permission: "bash", patterns: ["ls"], tool: { tool: "Bash" } },
      }),
    ).toEqual({ type: "permission.asked", id: "p", sessionId: "s", permission: "bash", patterns: ["ls"], toolName: "Bash" })
  })

  it("defaults permission.asked fields and requires id and session", () => {
    expect(mapV1Event({ type: "permission.asked", properties: { id: "p", sessionID: "s" } })).toEqual({
      type: "permission.asked",
      id: "p",
      sessionId: "s",
      permission: "unknown",
      patterns: [],
      toolName: undefined,
    })
    expect(mapV1Event({ type: "permission.asked", properties: { sessionID: "s" } })).toBeUndefined()
    expect(mapV1Event({ type: "permission.asked", properties: { id: "p" } })).toBeUndefined()
  })

  it("maps OpenCode 1.0 permission.updated and records the legacy id", () => {
    const legacy = new Set<string>()
    const mapped = mapV1Event(
      { type: "permission.updated", properties: { id: "p", type: "bash", pattern: "ls *", sessionID: "s", title: "Run ls" } },
      legacy,
    )
    expect(mapped).toEqual({
      type: "permission.asked",
      id: "p",
      sessionId: "s",
      permission: "bash",
      patterns: ["ls *"],
      toolName: "Run ls",
    })
    expect(legacy.has("p")).toBe(true)
  })

  it("handles permission.updated pattern arrays, missing patterns, and missing ids", () => {
    const legacy = new Set<string>()
    const arr = mapV1Event({ type: "permission.updated", properties: { id: "a", sessionID: "s", pattern: ["x", "y"] } }, legacy)
    expect(arr).toMatchObject({ patterns: ["x", "y"], permission: "unknown" })
    const none = mapV1Event({ type: "permission.updated", properties: { id: "b", sessionID: "s" } }, legacy)
    expect(none).toMatchObject({ patterns: [] })
    expect(mapV1Event({ type: "permission.updated", properties: { sessionID: "s" } }, legacy)).toBeUndefined()
    expect([...legacy]).toEqual(["a", "b"])
    expect(() => mapV1Event({ type: "permission.updated", properties: { id: "c", sessionID: "s" } })).not.toThrow()
  })

  it("maps permission.replied in the 1.0 shape", () => {
    expect(
      mapV1Event({ type: "permission.replied", properties: { permissionID: "p", sessionID: "s", response: "once" } }),
    ).toEqual({ type: "permission.replied", id: "p", sessionId: "s", reply: "once" })
  })

  it("maps permission.replied in the 1.1+ shape", () => {
    expect(
      mapV1Event({ type: "permission.replied", properties: { requestID: "p", sessionID: "s", reply: "always" } }),
    ).toEqual({ type: "permission.replied", id: "p", sessionId: "s", reply: "always" })
    expect(mapV1Event({ type: "permission.replied", properties: { sessionID: "s" } })).toBeUndefined()
    expect(mapV1Event({ type: "permission.replied", properties: { requestID: "p" } })).toBeUndefined()
  })

  it("maps question.asked", () => {
    expect(
      mapV1Event({
        type: "question.asked",
        properties: { id: "q", sessionID: "s", questions: [{ question: "Q" }] },
      }),
    ).toEqual({ type: "question.asked", id: "q", sessionId: "s", questions: [{ question: "Q" }] })
    expect(mapV1Event({ type: "question.asked", properties: { id: "q", sessionID: "s" } })).toMatchObject({ questions: [] })
    expect(mapV1Event({ type: "question.asked", properties: { sessionID: "s" } })).toBeUndefined()
  })

  it("maps question close events", () => {
    for (const type of ["question.replied", "question.rejected", "question.answered"]) {
      expect(mapV1Event({ type, properties: { sessionID: "s" } })).toEqual({ type: "question.closed", sessionId: "s" })
      expect(mapV1Event({ type, properties: {} })).toBeUndefined()
    }
  })

  it("maps session.created and session.updated to session.info", () => {
    for (const type of ["session.created", "session.updated"]) {
      expect(mapV1Event({ type, properties: { info: { id: "s", title: "T", parentID: "p" } } })).toEqual({
        type: "session.info",
        sessionId: "s",
        title: "T",
        parentId: "p",
      })
    }
    expect(mapV1Event({ type: "session.created", properties: { info: { id: "s", title: 5 } } })).toMatchObject({
      title: undefined,
    })
    expect(mapV1Event({ type: "session.created", properties: {} })).toBeUndefined()
  })

  it("ignores unknown and malformed events", () => {
    expect(mapV1Event({ type: "message.updated", properties: {} })).toBeUndefined()
    expect(mapV1Event(undefined)).toBeUndefined()
    expect(mapV1Event({})).toBeUndefined()
  })
})

interface PostCall {
  url: string
  body?: unknown
}

function makeInput(opts: { postResult?: (call: PostCall) => unknown; text?: string; version?: unknown } = {}) {
  const posts: PostCall[] = []
  const gets: { url: string }[] = []
  const prompts: any[] = []
  const messages = [
    { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
    {
      info: { role: "assistant" },
      parts: [{ type: "text", text: opts.text ?? "Finished the task." }, { type: "step-finish", reason: "end_turn" }],
    },
  ]
  const client = {
    app: { log: async () => {} },
    session: {
      messages: async () => ({ data: messages }),
      prompt: async (args: any) => {
        prompts.push(args)
      },
    },
    _client: {
      post: async (call: PostCall) => {
        posts.push(call)
        return opts.postResult ? opts.postResult(call) : { response: { status: 200 } }
      },
      get: async (call: { url: string }) => {
        gets.push(call)
        return { data: { version: opts.version ?? "1.18.0" } }
      },
    },
  }
  const input = { client, directory: "/tmp/v1-project", project: { id: "proj" } } as any
  return { input, posts, gets, prompts }
}

let cleanup: string[] = []
const idleEvent = (sid: string) => ({ event: { type: "session.idle", properties: { sessionID: sid } } }) as any

beforeAll(() => {
  rmSync(INBOX, { recursive: true, force: true })
  mkdirSync(MESSAGE_DIR, { recursive: true })
  __setInboxDirForTest(INBOX)
  __setRunnerForTest(async (cmd) => ({ code: 0, stdout: cmd === "git" ? "main\n" : "" }))
})

afterEach(() => {
  for (const f of cleanup) rmSync(f, { force: true })
  cleanup = []
})

// Cancels the pending completion poll by going busy after the test.
function finish(hooks: any, sid: string) {
  hooks.event({ event: { type: "session.busy", properties: { sessionID: sid } } })
}

describe("v1 server()", () => {
  it("probes /global/health and exposes event and tool hooks", async () => {
    const { input, gets } = makeInput()
    const hooks = await server(input)
    expect(gets).toEqual([{ url: "/global/health" }])
    expect(typeof hooks.event).toBe("function")
    expect(typeof hooks.tool?.superwhisper_toggle?.execute).toBe("function")
  })

  it("survives a failing health probe", async () => {
    const { input } = makeInput()
    input.client._client.get = async () => {
      throw new Error("404")
    }
    await expect(server(input)).resolves.toBeDefined()
  })

  it("session.idle writes a payload and the response is sent via session.prompt", async () => {
    const { input, prompts } = makeInput()
    const hooks = await server(input)
    const sid = uid("v1idle")
    await hooks.event!(idleEvent(sid))
    const [p] = await waitFor(() => updates(sid).length > 0 && updates(sid))
    expect(p).toMatchObject({ status: "completed", summary: "Finished the task.", project: "v1-project", branch: "main" })
    writeFileSync(p!.responseFile!, "next step")
    await waitFor(() => prompts.length > 0)
    expect(prompts[0]).toEqual({ path: { id: sid }, body: { parts: [{ type: "text", text: "next step" }] } })
  })

  it("new permissions reply through POST /permission/<id>/reply", async () => {
    const { input, posts } = makeInput()
    const hooks = await server(input)
    const sid = uid("v1perm")
    const id = uid("pid")
    await hooks.event!({
      event: { type: "permission.asked", properties: { id, sessionID: sid, permission: "bash", patterns: ["ls"] } },
    } as any)
    const [p] = await waitFor(() => updates(sid).length > 0 && updates(sid))
    writeFileSync(p!.responseFile!, "Always Allow")
    await waitFor(() => posts.length > 0)
    expect(posts[0]).toMatchObject({ url: `/permission/${id}/reply`, body: { reply: "always" } })
  })

  it("legacy permissions reply through POST /session/<sid>/permissions/<id>", async () => {
    const { input, posts } = makeInput()
    const hooks = await server(input)
    const sid = uid("v1legacy")
    const id = uid("pid")
    await hooks.event!({
      event: { type: "permission.updated", properties: { id, type: "bash", pattern: "ls", sessionID: sid, title: "ls" } },
    } as any)
    const [p] = await waitFor(() => updates(sid).length > 0 && updates(sid))
    writeFileSync(p!.responseFile!, "Allow")
    await waitFor(() => posts.length > 0)
    expect(posts[0]).toMatchObject({ url: `/session/${sid}/permissions/${id}`, body: { response: "once" } })
  })

  it("question replies post answers to /question/<id>/reply", async () => {
    const { input, posts } = makeInput()
    const hooks = await server(input)
    const sid = uid("v1q")
    const id = uid("qid")
    await hooks.event!({
      event: { type: "question.asked", properties: { id, sessionID: sid, questions: [{ question: "Q?", options: [{ label: "A" }] }] } },
    } as any)
    const [p] = await waitFor(() => updates(sid).length > 0 && updates(sid))
    expect(p!.status).toBe("question")
    writeFileSync(p!.responseFile!, '{"answers":[["A"]]}')
    await waitFor(() => posts.length > 0)
    expect(posts[0]).toMatchObject({ url: `/question/${id}/reply`, body: { answers: [["A"]] } })
  })

  it("a 404 response from post is swallowed, not thrown", async () => {
    const { input, posts } = makeInput({ postResult: () => ({ response: { status: 404 }, error: { message: "nf" } }) })
    const hooks = await server(input)
    const sid = uid("v1404")
    const id = uid("pid")
    await hooks.event!({
      event: { type: "permission.asked", properties: { id, sessionID: sid, permission: "bash", patterns: [] } },
    } as any)
    const [p] = await waitFor(() => updates(sid).length > 0 && updates(sid))
    writeFileSync(p!.responseFile!, "Allow")
    await waitFor(() => posts.length > 0)
    await sleep(100)
  })

  it("a rejecting post is swallowed, not thrown", async () => {
    const { input, posts } = makeInput({
      postResult: () => {
        throw new Error("network down")
      },
    })
    const hooks = await server(input)
    const sid = uid("v1rej")
    await hooks.event!({
      event: { type: "question.asked", properties: { id: uid("q"), sessionID: sid, questions: [{ question: "Q" }] } },
    } as any)
    const [p] = await waitFor(() => updates(sid).length > 0 && updates(sid))
    writeFileSync(p!.responseFile!, "A")
    await waitFor(() => posts.length > 0)
    await sleep(100)
  })

  it("the event hook ignores unknown events", async () => {
    const { input } = makeInput()
    const hooks = await server(input)
    await expect(hooks.event!({ event: { type: "message.part.updated", properties: {} } } as any)).resolves.toBeUndefined()
  })

  it("superwhisper_toggle disables and re-enables the session", async () => {
    const { input } = makeInput()
    const hooks = await server(input)
    const sid = uid("v1toggle")
    cleanup.push(`${MESSAGE_DIR}/disabled-${sid}`)
    const exec = hooks.tool!.superwhisper_toggle!.execute as any

    const off = await exec({ action: "disable" }, { sessionID: sid })
    expect(String(off)).toContain("disabled")
    expect(existsSync(`${MESSAGE_DIR}/disabled-${sid}`)).toBe(true)
    await hooks.event!(idleEvent(sid))
    await sleep(200)
    expect(updates(sid)).toEqual([])

    const on = await exec({ action: "enable" }, { sessionID: sid })
    expect(String(on)).toContain("re-enabled")
    expect(existsSync(`${MESSAGE_DIR}/disabled-${sid}`)).toBe(false)
    await hooks.event!(idleEvent(sid))
    await waitFor(() => updates(sid).length > 0)
    finish(hooks, sid)
  })

  it("session.created with a parent marks the session as a subagent", async () => {
    const { input } = makeInput()
    const hooks = await server(input)
    const sid = uid("v1sub")
    await hooks.event!({
      event: { type: "session.created", properties: { info: { id: sid, parentID: "root" } } },
    } as any)
    await hooks.event!(idleEvent(sid))
    await sleep(200)
    expect(updates(sid)).toEqual([])
  })
})
