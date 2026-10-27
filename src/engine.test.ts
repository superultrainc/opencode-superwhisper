import { describe, it, expect, beforeAll, afterEach } from "bun:test"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createEngine, type Engine } from "./engine.js"
import { __setInboxDirForTest, type InboxPayload } from "./inbox.js"
import { __setRunnerForTest } from "./system.js"
import { MESSAGE_DIR, type AssistantTurn, type Host, type PermissionReply, type RequestRef } from "./types.js"

const INBOX = "/tmp/superwhisper-test-inbox-engine"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let counter = 0
const uid = (p: string) => `${p}-${process.pid}-${Date.now()}-${counter++}`

function payloadsFor(sessionId: string): InboxPayload[] {
  if (!existsSync(INBOX)) return []
  return readdirSync(INBOX)
    .filter((n) => n.endsWith(".json"))
    .map((n) => JSON.parse(readFileSync(join(INBOX, n), "utf8")) as InboxPayload)
    .filter((p) => p.sessionId === sessionId)
}
const updates = (sid: string) => payloadsFor(sid).filter((p) => p.kind === "update")
const dismisses = (sid: string) => payloadsFor(sid).filter((p) => p.kind === "dismiss")

async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 3000): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = fn()
    if (v) return v
    await sleep(20)
  }
  throw new Error("waitFor timed out")
}

interface FakeHost extends Host {
  logs: { level: string; message: string }[]
  prompts: { sessionId: string; text: string }[]
  questionReplies: { request: RequestRef; answers: string[][] }[]
  questionRejects: RequestRef[]
  permissionReplies: { request: RequestRef; reply: PermissionReply }[]
  turn: AssistantTurn | undefined
  lastAssistantCalls: number
}

function makeHost(turn?: AssistantTurn): FakeHost {
  const host: FakeHost = {
    apiVersion: 2,
    opencodeVersion: "test",
    directory: "/tmp/my-project",
    projectName: "my-project",
    logs: [],
    prompts: [],
    questionReplies: [],
    questionRejects: [],
    permissionReplies: [],
    turn,
    lastAssistantCalls: 0,
    log(level, message) {
      host.logs.push({ level, message })
    },
    async lastAssistant() {
      host.lastAssistantCalls++
      return host.turn
    },
    async prompt(sessionId, text) {
      host.prompts.push({ sessionId, text })
    },
    async replyQuestion(request, answers) {
      host.questionReplies.push({ request, answers })
    },
    async rejectQuestion(request) {
      host.questionRejects.push(request)
    },
    async replyPermission(request, reply) {
      host.permissionReplies.push({ request, reply })
    },
  }
  return host
}

const pollCancelled = (host: FakeHost, key: string) =>
  waitFor(() => host.logs.some((l) => l.level === "info" && l.message === `Poll cancelled for key=${key}`))

let engines: Engine[] = []
let cleanup: string[] = []

async function start(host: FakeHost) {
  const engine = await createEngine(host)
  engines.push(engine)
  return engine
}

beforeAll(() => {
  rmSync(INBOX, { recursive: true, force: true })
  mkdirSync(MESSAGE_DIR, { recursive: true })
  __setInboxDirForTest(INBOX)
  __setRunnerForTest(async (cmd) => ({ code: 0, stdout: cmd === "git" ? "main\n" : "" }))
})

afterEach(() => {
  for (const e of engines) e.dispose()
  engines = []
  for (const f of cleanup) rmSync(f, { force: true })
  cleanup = []
})

const endTurn = (text: string): AssistantTurn => ({ text, endTurn: true })

describe("engine: completed notifications", () => {
  it("writes a completed payload with summary, title, branch and project", async () => {
    const sid = uid("done")
    const host = makeHost(endTurn("All done."))
    const engine = await start(host)
    engine.handle({ type: "session.info", sessionId: sid, title: "Fix the bug" })
    engine.handle({ type: "idle", sessionId: sid })

    const [p] = await waitFor(() => updates(sid).length > 0 && updates(sid))
    expect(p).toMatchObject({
      kind: "update",
      agent: "opencode",
      status: "completed",
      sessionId: sid,
      summary: "All done.",
      title: "Fix the bug",
      branch: "main",
      project: "my-project",
      cwd: "/tmp/my-project",
      hookPid: process.pid,
      messageFile: `${MESSAGE_DIR}/${sid}-message.txt`,
      responseFile: `${MESSAGE_DIR}/${sid}-response.txt`,
    })
    expect(readFileSync(p!.messageFile!, "utf8")).toBe("All done.")
  })

  it("ignores placeholder session titles", async () => {
    const sid = uid("title")
    const host = makeHost(endTurn("ok"))
    const engine = await start(host)
    engine.handle({ type: "session.info", sessionId: sid, title: "New session - 2026" })
    engine.handle({ type: "idle", sessionId: sid })
    const [p] = await waitFor(() => updates(sid).length > 0 && updates(sid))
    expect(p!.title).toBeUndefined()
  })

  it("sends the response file content to host.prompt", async () => {
    const sid = uid("resp")
    const host = makeHost(endTurn("Done"))
    const engine = await start(host)
    engine.handle({ type: "idle", sessionId: sid })
    const [p] = await waitFor(() => updates(sid).length > 0 && updates(sid))
    writeFileSync(p!.responseFile!, "please continue")
    await waitFor(() => host.prompts.length > 0)
    expect(host.prompts).toEqual([{ sessionId: sid, text: "please continue" }])
    expect(existsSync(p!.responseFile!)).toBe(false)
  })

  it("skips mid-turn idle (endTurn false)", async () => {
    const sid = uid("mid")
    const host = makeHost({ text: "working", endTurn: false })
    const engine = await start(host)
    engine.handle({ type: "idle", sessionId: sid })
    await waitFor(() => host.lastAssistantCalls > 0)
    await sleep(150)
    expect(payloadsFor(sid)).toEqual([])
  })

  it("skips empty text and missing assistant message", async () => {
    const sid = uid("empty")
    const host = makeHost({ text: "", endTurn: true })
    const engine = await start(host)
    engine.handle({ type: "idle", sessionId: sid })
    await waitFor(() => host.lastAssistantCalls > 0)
    host.turn = undefined
    engine.handle({ type: "idle", sessionId: sid })
    await waitFor(() => host.lastAssistantCalls > 1)
    await sleep(150)
    expect(payloadsFor(sid)).toEqual([])
  })

  it("skips subagent sessions", async () => {
    const sid = uid("sub")
    const host = makeHost(endTurn("child done"))
    const engine = await start(host)
    engine.handle({ type: "session.info", sessionId: sid, parentId: "parent" })
    engine.handle({ type: "idle", sessionId: sid })
    await sleep(200)
    expect(host.lastAssistantCalls).toBe(0)
    expect(payloadsFor(sid)).toEqual([])
  })

  it("skips disabled sessions and resumes when re-enabled", async () => {
    const sid = uid("dis")
    cleanup.push(`${MESSAGE_DIR}/disabled-${sid}`)
    const host = makeHost(endTurn("hello"))
    const engine = await start(host)

    engine.setEnabled(sid, false)
    expect(existsSync(`${MESSAGE_DIR}/disabled-${sid}`)).toBe(true)
    engine.handle({ type: "idle", sessionId: sid })
    await sleep(200)
    expect(payloadsFor(sid)).toEqual([])

    engine.setEnabled(sid, true)
    expect(existsSync(`${MESSAGE_DIR}/disabled-${sid}`)).toBe(false)
    engine.handle({ type: "idle", sessionId: sid })
    await waitFor(() => updates(sid).length > 0)
  })

  it("honours a disabled flag file written by another process", async () => {
    const sid = uid("flag")
    cleanup.push(`${MESSAGE_DIR}/disabled-${sid}`)
    writeFileSync(`${MESSAGE_DIR}/disabled-${sid}`, "")
    const host = makeHost(endTurn("hello"))
    const engine = await start(host)
    engine.handle({ type: "idle", sessionId: sid })
    await sleep(200)
    expect(payloadsFor(sid)).toEqual([])
  })

  it("skips idle while a question is pending", async () => {
    const sid = uid("qidle")
    const host = makeHost(endTurn("text"))
    const engine = await start(host)
    engine.handle({ type: "question.asked", id: uid("q"), sessionId: sid, questions: [{ question: "Q?" }] })
    await waitFor(() => updates(sid).length > 0)
    engine.handle({ type: "idle", sessionId: sid })
    await sleep(200)
    expect(updates(sid).map((p) => p.status)).toEqual(["question"])
  })
})

describe("engine: busy handling", () => {
  it("dismisses and cancels the poll when the session goes busy", async () => {
    const sid = uid("busy")
    const host = makeHost(endTurn("Done"))
    const engine = await start(host)
    engine.handle({ type: "idle", sessionId: sid })
    const [p] = await waitFor(() => updates(sid).length > 0 && updates(sid))

    engine.handle({ type: "busy", sessionId: sid })
    await waitFor(() => dismisses(sid).length === 1)
    writeFileSync(p!.responseFile!, "too late")
    await pollCancelled(host, sid)
    await sleep(100)
    expect(host.prompts).toEqual([])
  })

  it("does nothing on busy when nothing is pending", async () => {
    const sid = uid("nobusy")
    const host = makeHost(endTurn("Done"))
    const engine = await start(host)
    engine.handle({ type: "busy", sessionId: sid })
    await sleep(150)
    expect(payloadsFor(sid)).toEqual([])
  })

  it("does not dismiss on busy caused by our own injected prompt", async () => {
    const sid = uid("inj")
    const host = makeHost(endTurn("Done"))
    const engine = await start(host)
    engine.handle({ type: "idle", sessionId: sid })
    const [first] = await waitFor(() => updates(sid).length > 0 && updates(sid))
    writeFileSync(first!.responseFile!, "go on")
    await waitFor(() => host.prompts.length > 0)
    engine.handle({ type: "busy", sessionId: sid })
    await sleep(150)
    expect(dismisses(sid)).toEqual([])
  })

  it("dismisses on a later user busy after our injected prompt already started", async () => {
    const sid = uid("inj2")
    const host = makeHost(endTurn("Done"))
    const engine = await start(host)
    engine.handle({ type: "idle", sessionId: sid })
    const [first] = await waitFor(() => updates(sid).length > 0 && updates(sid))
    writeFileSync(first!.responseFile!, "go on")
    await waitFor(() => host.prompts.length > 0)
    engine.handle({ type: "busy", sessionId: sid })

    engine.handle({ type: "idle", sessionId: sid })
    await waitFor(() => updates(sid).length === 2)
    engine.handle({ type: "busy", sessionId: sid })
    await waitFor(() => dismisses(sid).length === 1)
  })
})

describe("engine: questions", () => {
  it("sends a normalized question payload and replies with parsed answers", async () => {
    const sid = uid("q")
    const id = uid("qid")
    const host = makeHost(endTurn("Which one?"))
    const engine = await start(host)
    engine.handle({
      type: "question.asked",
      id,
      sessionId: sid,
      questions: [
        { question: "Pick", header: "H", options: [{ label: "A", description: "a" }, { label: "B" }], multiple: true },
        { question: "Free text" },
      ],
    })
    const [p] = await waitFor(() => updates(sid).length > 0 && updates(sid))
    expect(p!.status).toBe("question")
    expect(p!.summary).toBe("Pick")
    expect(JSON.parse(readFileSync(p!.messageFile!, "utf8"))).toEqual({
      questions: [
        { question: "Pick", header: "H", options: [{ label: "A", description: "a" }, { label: "B" }], multiSelect: true },
        { question: "Free text", options: [], multiSelect: false },
      ],
      context: "Which one?",
    })

    writeFileSync(p!.responseFile!, '{"answers":[["A"]]}')
    await waitFor(() => host.questionReplies.length > 0)
    expect(host.questionReplies[0]).toEqual({ request: { id, sessionId: sid }, answers: [["A"]] })
    expect(host.questionRejects).toEqual([])
  })

  it("omits context when there is no assistant text", async () => {
    const sid = uid("qnoctx")
    const host = makeHost(undefined)
    const engine = await start(host)
    engine.handle({ type: "question.asked", id: uid("q"), sessionId: sid, questions: [{ question: "Q" }] })
    const [p] = await waitFor(() => updates(sid).length > 0 && updates(sid))
    expect("context" in JSON.parse(readFileSync(p!.messageFile!, "utf8"))).toBe(false)
  })

  it("ignores questions with no entries", async () => {
    const sid = uid("qempty")
    const host = makeHost()
    const engine = await start(host)
    engine.handle({ type: "question.asked", id: uid("q"), sessionId: sid, questions: [] })
    await sleep(150)
    expect(payloadsFor(sid)).toEqual([])
  })

  it("dismisses and cancels when the question is closed elsewhere", async () => {
    const sid = uid("qclose")
    const id = uid("qid")
    const host = makeHost()
    const engine = await start(host)
    engine.handle({ type: "question.asked", id, sessionId: sid, questions: [{ question: "Q" }] })
    await waitFor(() => updates(sid).length > 0)
    engine.handle({ type: "question.closed", sessionId: sid })
    await waitFor(() => dismisses(sid).length === 1)
    await pollCancelled(host, sid)
    expect(host.questionReplies).toEqual([])
    expect(host.questionRejects).toEqual([])
  })
})

describe("engine: permissions", () => {
  const ask = (sid: string, id: string) =>
    ({
      type: "permission.asked",
      id,
      sessionId: sid,
      permission: "bash",
      patterns: ["ls", "pwd"],
      toolName: "Bash",
    }) as const

  it("sends a permission payload and replies 'always' for Always Allow", async () => {
    const sid = uid("perm")
    const id = uid("pid")
    const host = makeHost()
    const engine = await start(host)
    engine.handle(ask(sid, id))
    const [p] = await waitFor(() => updates(sid).length > 0 && updates(sid))
    expect(p!.status).toBe("permission")
    expect(p!.responseFile).toBe(`${MESSAGE_DIR}/${id}-response.txt`)
    const msg = JSON.parse(readFileSync(p!.messageFile!, "utf8"))
    expect(msg).toMatchObject({ permissionId: id, toolName: "Bash", details: "ls, pwd" })
    expect(msg.suggestions.map((s: any) => s.label)).toEqual([
      "Allow",
      "Always Allow",
      "Bypass permissions for this session",
      "Deny",
    ])

    writeFileSync(p!.responseFile!, "Always Allow")
    await waitFor(() => host.permissionReplies.length > 0)
    expect(host.permissionReplies).toEqual([{ request: { id, sessionId: sid }, reply: "always" }])
  })

  it("maps Deny to reject", async () => {
    const sid = uid("deny")
    const host = makeHost()
    const engine = await start(host)
    engine.handle(ask(sid, "p-deny-" + sid))
    const [p] = await waitFor(() => updates(sid).length > 0 && updates(sid))
    writeFileSync(p!.responseFile!, "Deny")
    await waitFor(() => host.permissionReplies.length > 0)
    expect(host.permissionReplies[0]!.reply).toBe("reject")
  })

  it("bypass writes the flag file, replies once, and auto-allows later permissions", async () => {
    const sid = uid("bypass")
    cleanup.push(`${MESSAGE_DIR}/${sid}-bypass-perms`)
    const host = makeHost()
    const engine = await start(host)
    engine.handle(ask(sid, "p1-" + sid))
    const [p] = await waitFor(() => updates(sid).length > 0 && updates(sid))
    writeFileSync(p!.responseFile!, "Bypass permissions for this session")
    await waitFor(() => host.permissionReplies.length > 0)
    expect(host.permissionReplies[0]).toEqual({ request: { id: "p1-" + sid, sessionId: sid }, reply: "once" })
    expect(existsSync(`${MESSAGE_DIR}/${sid}-bypass-perms`)).toBe(true)

    engine.handle(ask(sid, "p2-" + sid))
    await waitFor(() => host.permissionReplies.length === 2)
    expect(host.permissionReplies[1]).toEqual({ request: { id: "p2-" + sid, sessionId: sid }, reply: "once" })
    expect(updates(sid)).toHaveLength(1)
  })

  it("dismisses without replying when answered in the OpenCode UI", async () => {
    const sid = uid("ui")
    const id = uid("pid")
    const host = makeHost()
    const engine = await start(host)
    engine.handle(ask(sid, id))
    await waitFor(() => updates(sid).length > 0)
    engine.handle({ type: "permission.replied", id, sessionId: sid, reply: "once" })
    await waitFor(() => dismisses(sid).length === 1)
    await pollCancelled(host, id)
    expect(host.permissionReplies).toEqual([])
  })

  it("dismisses without replying when answered in the UI before the notification lands", async () => {
    const sid = uid("uirace")
    const id = uid("pid")
    const host = makeHost()
    const engine = await start(host)
    engine.handle(ask(sid, id))
    engine.handle({ type: "permission.replied", id, sessionId: sid, reply: "once" })
    await waitFor(() => dismisses(sid).length === 2)
    await sleep(1500)
    expect(host.permissionReplies).toEqual([])
  })

  it("does not dismiss on the permission.replied that follows our own reply", async () => {
    const sid = uid("own")
    const id = uid("pid")
    const host = makeHost()
    const engine = await start(host)
    engine.handle(ask(sid, id))
    const [p] = await waitFor(() => updates(sid).length > 0 && updates(sid))
    writeFileSync(p!.responseFile!, "Allow")
    await waitFor(() => host.permissionReplies.length > 0)
    engine.handle({ type: "permission.replied", id, sessionId: sid, reply: "once" })
    await sleep(150)
    expect(dismisses(sid)).toEqual([])
  })

  it("skips permissions for disabled sessions", async () => {
    const sid = uid("permdis")
    cleanup.push(`${MESSAGE_DIR}/disabled-${sid}`)
    const host = makeHost()
    const engine = await start(host)
    engine.setEnabled(sid, false)
    engine.handle(ask(sid, uid("pid")))
    await sleep(150)
    expect(payloadsFor(sid)).toEqual([])
  })
})

describe("engine: errors", () => {
  it("writes an error payload", async () => {
    const sid = uid("err")
    const host = makeHost()
    const engine = await start(host)
    engine.handle({ type: "error", sessionId: sid, message: "boom" })
    const [p] = await waitFor(() => updates(sid).length > 0 && updates(sid))
    expect(p).toMatchObject({ status: "error", summary: "boom" })
    expect(readFileSync(p!.messageFile!, "utf8")).toBe("boom")
  })

  it("truncates long error summaries to 200 chars", async () => {
    const sid = uid("errlong")
    const host = makeHost()
    const engine = await start(host)
    engine.handle({ type: "error", sessionId: sid, message: "x".repeat(500) })
    const [p] = await waitFor(() => updates(sid).length > 0 && updates(sid))
    expect(p!.summary).toHaveLength(200)
  })

  it("skips errors for disabled sessions", async () => {
    const sid = uid("errdis")
    cleanup.push(`${MESSAGE_DIR}/disabled-${sid}`)
    const host = makeHost()
    const engine = await start(host)
    engine.setEnabled(sid, false)
    engine.handle({ type: "error", sessionId: sid, message: "boom" })
    await sleep(150)
    expect(payloadsFor(sid)).toEqual([])
  })
})

describe("engine: wake", () => {
  it("opens the app via deep link when Superwhisper is not running", async () => {
    const calls: string[][] = []
    __setRunnerForTest(async (cmd, args) => {
      calls.push([cmd, ...args])
      if (cmd === "pgrep") return { code: 1, stdout: "" }
      return { code: 0, stdout: cmd === "git" ? "main\n" : "" }
    })
    try {
      process.env.SUPERWHISPER_SCHEME = "superwhisper-test"
      const sid = uid("wake")
      const host = makeHost(endTurn("hi"))
      const engine = await start(host)
      engine.handle({ type: "idle", sessionId: sid })
      await waitFor(() => updates(sid).length > 0)
      expect(calls).toContainEqual(["open", "superwhisper-test://agent-wake"])
    } finally {
      delete process.env.SUPERWHISPER_SCHEME
      __setRunnerForTest(async (cmd) => ({ code: 0, stdout: cmd === "git" ? "main\n" : "" }))
    }
  })
})
