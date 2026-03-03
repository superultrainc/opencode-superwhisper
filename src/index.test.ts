import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import {
  buildDeeplinkUrl,
  extractFullText,
  extractSummary,
  isEndTurn,
  pollForResponse,
  SuperWhisperPlugin,
} from "./index.js"
import type { DeeplinkParams } from "./index.js"
import { unlink, mkdir } from "node:fs/promises"

// --- extractFullText ---

describe("extractFullText", () => {
  it("returns empty string for null message", () => {
    expect(extractFullText(null)).toBe("")
  })

  it("returns empty string for undefined message", () => {
    expect(extractFullText(undefined)).toBe("")
  })

  it("returns empty string for message with no parts", () => {
    expect(extractFullText({ parts: [] })).toBe("")
  })

  it("extracts text from single text part", () => {
    const message = {
      parts: [{ type: "text", text: "Hello world" }],
    }
    expect(extractFullText(message)).toBe("Hello world")
  })

  it("joins multiple text parts with newline", () => {
    const message = {
      parts: [
        { type: "text", text: "First" },
        { type: "text", text: "Second" },
      ],
    }
    expect(extractFullText(message)).toBe("First\nSecond")
  })

  it("filters out non-text parts", () => {
    const message = {
      parts: [
        { type: "text", text: "Hello" },
        { type: "tool_call", text: "ignored" },
        { type: "text", text: "World" },
      ],
    }
    expect(extractFullText(message)).toBe("Hello\nWorld")
  })

  it("trims whitespace", () => {
    const message = {
      parts: [{ type: "text", text: "  Hello  " }],
    }
    expect(extractFullText(message)).toBe("Hello")
  })

  it("handles parts with missing text", () => {
    const message = {
      parts: [{ type: "text" }, { type: "text", text: "OK" }],
    }
    expect(extractFullText(message)).toBe("OK")
  })
})

// --- isEndTurn ---

describe("isEndTurn", () => {
  it("returns false for null message", () => {
    expect(isEndTurn(null)).toBe(false)
  })

  it("returns false for message with no parts", () => {
    expect(isEndTurn({ parts: [] })).toBe(false)
  })

  it("returns false when no step-finish parts present", () => {
    const message = {
      parts: [{ type: "text", text: "Hello" }],
    }
    expect(isEndTurn(message)).toBe(false)
  })

  it("returns true when last step-finish reason is end_turn", () => {
    const message = {
      parts: [
        { type: "step-start" },
        { type: "text", text: "Done" },
        { type: "step-finish", reason: "end_turn" },
      ],
    }
    expect(isEndTurn(message)).toBe(true)
  })

  it("returns false when last step-finish reason is tool-calls", () => {
    const message = {
      parts: [
        { type: "step-start" },
        { type: "text", text: "Running tools..." },
        { type: "step-finish", reason: "tool-calls" },
      ],
    }
    expect(isEndTurn(message)).toBe(false)
  })

  it("uses the LAST step-finish when multiple are present", () => {
    const message = {
      parts: [
        { type: "step-finish", reason: "tool-calls" },
        { type: "step-finish", reason: "end_turn" },
      ],
    }
    expect(isEndTurn(message)).toBe(true)
  })

  it("returns false when last step-finish was tool-calls after an end_turn", () => {
    const message = {
      parts: [
        { type: "step-finish", reason: "end_turn" },
        { type: "step-finish", reason: "tool-calls" },
      ],
    }
    expect(isEndTurn(message)).toBe(false)
  })

  it("returns true when last step-finish reason is stop", () => {
    const message = {
      parts: [
        { type: "step-start" },
        { type: "text", text: "Done" },
        { type: "step-finish", reason: "stop" },
      ],
    }
    expect(isEndTurn(message)).toBe(true)
  })

  it("returns true when stop follows tool-calls", () => {
    const message = {
      parts: [
        { type: "step-finish", reason: "tool-calls" },
        { type: "step-finish", reason: "stop" },
      ],
    }
    expect(isEndTurn(message)).toBe(true)
  })
})

// --- extractSummary ---

describe("extractSummary", () => {
  it("returns empty string for empty text", () => {
    expect(extractSummary("")).toBe("")
  })

  it("returns empty string for falsy text", () => {
    expect(extractSummary(null as any)).toBe("")
  })

  it("returns full text if under 200 chars", () => {
    expect(extractSummary("Short message")).toBe("Short message")
  })

  it("returns full text if exactly 200 chars", () => {
    const text = "x".repeat(200)
    expect(extractSummary(text)).toBe(text)
  })

  it("truncates at sentence boundary if available", () => {
    const prefix = "x".repeat(110) + ". "
    const text = prefix + "y".repeat(200)
    const result = extractSummary(text)
    expect(result).toBe("x".repeat(110) + ".")
  })

  it("ignores sentence break too early (under 100 chars)", () => {
    const text = "Hi. " + "x".repeat(250)
    const result = extractSummary(text)
    expect(result).not.toBe("Hi.")
  })

  it("truncates at word boundary with ellipsis", () => {
    const text = "word ".repeat(50)
    const result = extractSummary(text)
    expect(result.length).toBeLessThanOrEqual(203)
    expect(result).toEndWith("...")
  })

  it("hard truncates with ellipsis when no breaks found", () => {
    const text = "x".repeat(300)
    const result = extractSummary(text)
    expect(result).toBe("x".repeat(200) + "...")
  })
})

// --- buildDeeplinkUrl ---

describe("buildDeeplinkUrl", () => {
  const baseParams: DeeplinkParams = {
    agent: "opencode",
    status: "completed",
    sessionId: "abc123",
    summary: "Done",
    messageFile: "/tmp/superwhisper-agent/abc123-message.txt",
    responseFile: "/tmp/superwhisper-agent/abc123-response.txt",
  }

  it("builds URL with all required params", () => {
    const url = buildDeeplinkUrl("superwhisper", baseParams)
    expect(url).toStartWith("superwhisper://agent-update?")
    expect(url).toContain("agent=opencode")
    expect(url).toContain("status=completed")
    expect(url).toContain("sessionId=abc123")
    expect(url).toContain("summary=Done")
    expect(url).toContain("messageFile=")
    expect(url).toContain("responseFile=")
  })

  it("uses debug scheme when specified", () => {
    const url = buildDeeplinkUrl("superwhisper-debug", baseParams)
    expect(url).toStartWith("superwhisper-debug://agent-update?")
  })

  it("includes optional params when provided", () => {
    const url = buildDeeplinkUrl("superwhisper", {
      ...baseParams,
      cwd: "/Users/test/project",
      project: "myproject",
      branch: "main",
    })
    expect(url).toContain("cwd=%2FUsers%2Ftest%2Fproject")
    expect(url).toContain("project=myproject")
    expect(url).toContain("branch=main")
  })

  it("omits optional params when undefined", () => {
    const url = buildDeeplinkUrl("superwhisper", baseParams)
    expect(url).not.toContain("cwd=")
    expect(url).not.toContain("project=")
    expect(url).not.toContain("branch=")
  })

  it("omits optional params when empty string", () => {
    const url = buildDeeplinkUrl("superwhisper", {
      ...baseParams,
      branch: "",
    })
    expect(url).not.toContain("branch=")
  })

  it("encodes special characters in summary", () => {
    const url = buildDeeplinkUrl("superwhisper", {
      ...baseParams,
      summary: "Fixed bug & added tests",
    })
    expect(url).toContain("summary=Fixed%20bug%20%26%20added%20tests")
  })

  it("does not encode spaces as +", () => {
    const url = buildDeeplinkUrl("superwhisper", {
      ...baseParams,
      summary: "hello world",
    })
    expect(url).not.toContain("+")
    expect(url).toContain("hello%20world")
  })

  it("encodes file paths correctly", () => {
    const url = buildDeeplinkUrl("superwhisper", baseParams)
    expect(url).toContain(
      "messageFile=%2Ftmp%2Fsuperwhisper-agent%2Fabc123-message.txt",
    )
  })
})

// --- pollForResponse ---

describe("pollForResponse", () => {
  const testDir = "/tmp/superwhisper-agent-test"
  const testFile = `${testDir}/poll-test-response.txt`

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true })
    try {
      await unlink(testFile)
    } catch {}
  })

  afterEach(async () => {
    try {
      await unlink(testFile)
    } catch {}
  })

  it("returns file content when file exists immediately", async () => {
    await Bun.write(testFile, "user response")
    const result = await pollForResponse(testFile, 5000, 100)
    expect(result).toBe("user response")
  })

  it("returns file content when file appears during polling", async () => {
    setTimeout(() => Bun.write(testFile, "delayed response"), 300)
    const result = await pollForResponse(testFile, 5000, 100)
    expect(result).toBe("delayed response")
  })

  it("returns null on timeout", async () => {
    const result = await pollForResponse(testFile, 300, 100)
    expect(result).toBeNull()
  })

  it("returns null when cancelled", async () => {
    let cancelled = false
    setTimeout(() => {
      cancelled = true
    }, 200)
    const result = await pollForResponse(testFile, 5000, 100, () => cancelled)
    expect(result).toBeNull()
  })

  it("waits for non-empty content", async () => {
    await Bun.write(testFile, "")
    const result = await pollForResponse(testFile, 200, 50)
    expect(result).toBeNull()
  })

  it("returns content once file has non-empty text", async () => {
    await Bun.write(testFile, "hello world")
    const result = await pollForResponse(testFile, 5000, 100)
    expect(result).toBe("hello world")
  })
})

// --- Plugin integration helpers ---

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const MESSAGE_DIR = "/tmp/superwhisper-agent"

function makeAssistantMessage(text: string, endReason: string = "end_turn") {
  return {
    info: { role: "assistant" },
    parts: [
      { type: "text", text },
      { type: "step-finish", reason: endReason },
    ],
  }
}

function makeUserMessage(text: string = "Do something") {
  return {
    info: { role: "user" },
    parts: [{ type: "text", text }],
  }
}

function createMock$() {
  const shellCommands: string[] = []
  const mock$ = (strings: TemplateStringsArray, ...values: any[]) => {
    const cmd = strings.reduce(
      (acc, str, i) => acc + str + (values[i] ?? ""),
      "",
    )
    shellCommands.push(cmd)
    const p = Promise.resolve({ exitCode: 0 }) as any
    p.quiet = () => p
    p.text = () => Promise.resolve("")
    p.exitCode = 0
    return p
  }
  return { mock$, shellCommands }
}

function createMockClient(overrides?: {
  messages?: any[]
  promptFn?: (...args: any[]) => any
}) {
  return {
    app: { log: mock(() => {}) },
    session: {
      messages: mock(async () => ({
        data: overrides?.messages ?? [
          makeUserMessage(),
          makeAssistantMessage("I completed the task successfully."),
        ],
      })),
      prompt: overrides?.promptFn ?? mock(async () => {}),
    },
  }
}

async function initPlugin(opts?: {
  messages?: any[]
  promptFn?: (...args: any[]) => any
}) {
  const { mock$, shellCommands } = createMock$()
  const mockClient = createMockClient(opts)
  const plugin = await SuperWhisperPlugin({
    client: mockClient,
    $: mock$,
    directory: "/tmp/test-project",
    project: { id: "test" },
  } as any)
  return { plugin, shellCommands, mockClient }
}

async function cleanupSession(sessionId: string) {
  try {
    await unlink(`${MESSAGE_DIR}/${sessionId}-response.txt`)
  } catch {}
  try {
    await unlink(`${MESSAGE_DIR}/${sessionId}-message.txt`)
  } catch {}
}

async function writeResponse(
  sessionId: string,
  text: string = "voice response",
) {
  await Bun.write(`${MESSAGE_DIR}/${sessionId}-response.txt`, text)
}

function hasDismissCmd(cmds: string[], sessionId: string): boolean {
  return cmds.some(
    (c) => c.includes("agent-dismiss") && c.includes(sessionId),
  )
}

function hasDeeplinkCmd(cmds: string[], sessionId: string): boolean {
  return cmds.some(
    (c) => c.includes("agent-update") && c.includes(sessionId),
  )
}

// --- Plugin basic ---

describe("SuperWhisperPlugin", () => {
  it("initializes without error", async () => {
    const { plugin } = await initPlugin()
    expect(plugin).toBeDefined()
    expect(plugin.event).toBeDefined()
  })

  it("creates temp directory on init", async () => {
    const { shellCommands } = await initPlugin()
    const mkdirCmd = shellCommands.find((c) => c.includes("mkdir"))
    expect(mkdirCmd).toBeDefined()
    expect(mkdirCmd).toContain("/tmp/superwhisper-agent")
  })

  it("ignores session.idle without sessionID", async () => {
    const { plugin, mockClient } = await initPlugin()
    await plugin.event?.({
      event: { type: "session.idle", properties: {} },
    } as any)
    await wait(100)
    expect(mockClient.session.messages).not.toHaveBeenCalled()
  })
})

// --- session.idle → handleCompleted ---

describe("session.idle → handleCompleted", () => {
  it("skips when sessionId is missing", async () => {
    const { plugin, mockClient } = await initPlugin()
    await plugin.event?.({
      event: { type: "session.idle", properties: {} },
    } as any)
    await wait(100)
    expect(mockClient.session.messages).not.toHaveBeenCalled()
  })

  it("skips when last assistant message is empty", async () => {
    const sid = "idle-empty-msg"
    const { plugin, shellCommands } = await initPlugin({
      messages: [
        makeUserMessage(),
        { info: { role: "assistant" }, parts: [] },
      ],
    })
    await plugin.event?.({
      event: { type: "session.idle", properties: { sessionID: sid } },
    } as any)
    await wait(200)
    expect(hasDeeplinkCmd(shellCommands, sid)).toBe(false)
  })

  it("skips when isEndTurn is false", async () => {
    const sid = "idle-tool-calls"
    const { plugin, shellCommands } = await initPlugin({
      messages: [
        makeUserMessage(),
        makeAssistantMessage("Running tools...", "tool-calls"),
      ],
    })
    await plugin.event?.({
      event: { type: "session.idle", properties: { sessionID: sid } },
    } as any)
    await wait(200)
    expect(hasDeeplinkCmd(shellCommands, sid)).toBe(false)
    await cleanupSession(sid)
  })

  it("sends deeplink when message has content and isEndTurn", async () => {
    const sid = "idle-sends-deeplink"
    const { plugin, shellCommands } = await initPlugin()
    await plugin.event?.({
      event: { type: "session.idle", properties: { sessionID: sid } },
    } as any)
    await wait(300)

    expect(hasDeeplinkCmd(shellCommands, sid)).toBe(true)
    const deeplinkCmd = shellCommands.find(
      (c) => c.includes("agent-update") && c.includes(sid),
    )!
    expect(deeplinkCmd).toContain("status=completed")
    expect(deeplinkCmd).toContain("agent=opencode")

    await writeResponse(sid)
    await wait(200)
    await cleanupSession(sid)
  })

  it("skips when no assistant messages exist", async () => {
    const sid = "idle-no-assistant"
    const { plugin, shellCommands } = await initPlugin({
      messages: [makeUserMessage()],
    })
    await plugin.event?.({
      event: { type: "session.idle", properties: { sessionID: sid } },
    } as any)
    await wait(200)
    expect(hasDeeplinkCmd(shellCommands, sid)).toBe(false)
  })

  it("sends response back to OpenCode when user responds", async () => {
    const sid = "idle-response-flow"
    const { plugin, mockClient } = await initPlugin()
    await plugin.event?.({
      event: { type: "session.idle", properties: { sessionID: sid } },
    } as any)
    await wait(300)

    await writeResponse(sid, "fix the bug please")
    await wait(2500)

    expect(mockClient.session.prompt).toHaveBeenCalled()
    const promptCall = (mockClient.session.prompt as any).mock.calls[0]
    expect(promptCall[0].path.id).toBe(sid)
    expect(promptCall[0].body.parts[0].text).toBe("fix the bug please")

    await cleanupSession(sid)
  }, 10_000)
})

// --- session.busy dismiss handler ---

describe("session.busy dismiss handler", () => {
  it("does NOT dismiss when no activePolls entry", async () => {
    const sid = "busy-no-poll"
    const { plugin, shellCommands } = await initPlugin()
    await plugin.event?.({
      event: { type: "session.busy", properties: { sessionID: sid } },
    } as any)
    expect(hasDismissCmd(shellCommands, sid)).toBe(false)
  })

  it("sends dismiss deeplink when activePolls has the session", async () => {
    const sid = "busy-with-poll"
    const { plugin, shellCommands } = await initPlugin()
    await plugin.event?.({
      event: { type: "session.idle", properties: { sessionID: sid } },
    } as any)
    await wait(300)

    await plugin.event?.({
      event: { type: "session.busy", properties: { sessionID: sid } },
    } as any)

    expect(hasDismissCmd(shellCommands, sid)).toBe(true)
    await cleanupSession(sid)
  })

  it("cancels the poll when dismissing", async () => {
    const sid = "busy-cancels-poll"
    const { plugin, shellCommands } = await initPlugin()
    await plugin.event?.({
      event: { type: "session.idle", properties: { sessionID: sid } },
    } as any)
    await wait(300)

    await plugin.event?.({
      event: { type: "session.busy", properties: { sessionID: sid } },
    } as any)

    const cmdsBefore = shellCommands.filter((c) => c.includes("agent-dismiss"))
    await plugin.event?.({
      event: { type: "session.busy", properties: { sessionID: sid } },
    } as any)
    const cmdsAfter = shellCommands.filter((c) => c.includes("agent-dismiss"))

    expect(cmdsAfter.length).toBe(cmdsBefore.length)
    await cleanupSession(sid)
  })

  it("does NOT dismiss for superwhisperInjectedSessions", async () => {
    const sid = "busy-injected"
    const { plugin, shellCommands, mockClient } = await initPlugin()

    await plugin.event?.({
      event: { type: "session.idle", properties: { sessionID: sid } },
    } as any)
    await wait(300)

    await writeResponse(sid, "voice reply")
    await wait(2500)

    expect(mockClient.session.prompt).toHaveBeenCalled()

    await plugin.event?.({
      event: { type: "session.idle", properties: { sessionID: sid } },
    } as any)
    await wait(300)

    const dismissBefore = shellCommands.filter((c) =>
      c.includes("agent-dismiss"),
    ).length

    await plugin.event?.({
      event: { type: "session.busy", properties: { sessionID: sid } },
    } as any)

    const dismissAfter = shellCommands.filter((c) =>
      c.includes("agent-dismiss"),
    ).length
    expect(dismissAfter).toBe(dismissBefore)

    await writeResponse(sid)
    await wait(200)
    await cleanupSession(sid)
  }, 10_000)
})

// --- message.updated ---

describe("message.updated handler", () => {
  it("clears dismissedSessions for user messages", async () => {
    const sid = "msg-updated-clears"
    const { plugin, shellCommands } = await initPlugin()
    await plugin.event?.({
      event: {
        type: "message.updated",
        properties: { info: { sessionID: sid, role: "user" } },
      },
    } as any)
    expect(hasDismissCmd(shellCommands, sid)).toBe(false)
  })

  it("does nothing for non-user messages", async () => {
    const sid = "msg-updated-assistant"
    const { plugin, shellCommands } = await initPlugin()
    await plugin.event?.({
      event: {
        type: "message.updated",
        properties: { info: { sessionID: sid, role: "assistant" } },
      },
    } as any)
    expect(hasDismissCmd(shellCommands, sid)).toBe(false)
  })

  it("does nothing when no sessionId", async () => {
    const { plugin, shellCommands } = await initPlugin()
    await plugin.event?.({
      event: {
        type: "message.updated",
        properties: { info: { role: "user" } },
      },
    } as any)
    expect(
      shellCommands.filter((c) => c.includes("agent-dismiss")).length,
    ).toBe(0)
  })

  it("clears dismissed state so next idle can re-notify", async () => {
    const sid = "msg-updated-reidle"
    const { plugin, shellCommands } = await initPlugin()

    await plugin.event?.({
      event: { type: "session.idle", properties: { sessionID: sid } },
    } as any)
    await wait(300)
    expect(hasDeeplinkCmd(shellCommands, sid)).toBe(true)

    await plugin.event?.({
      event: { type: "session.busy", properties: { sessionID: sid } },
    } as any)
    await wait(100)

    await plugin.event?.({
      event: {
        type: "message.updated",
        properties: { info: { sessionID: sid, role: "user" } },
      },
    } as any)

    const deeplinksBefore = shellCommands.filter(
      (c) => c.includes("agent-update") && c.includes(sid),
    ).length
    await plugin.event?.({
      event: { type: "session.idle", properties: { sessionID: sid } },
    } as any)
    await wait(300)

    const deeplinksAfter = shellCommands.filter(
      (c) => c.includes("agent-update") && c.includes(sid),
    ).length
    expect(deeplinksAfter).toBeGreaterThan(deeplinksBefore)

    await writeResponse(sid)
    await wait(200)
    await cleanupSession(sid)
  })
})

// --- question.answered / question.rejected ---

describe("question.answered / question.rejected dismiss", () => {
  it("sends dismiss deeplink on question.answered", async () => {
    const sid = "q-answered"
    const { plugin, shellCommands } = await initPlugin()
    await plugin.event?.({
      event: {
        type: "question.answered",
        properties: { sessionID: sid },
      },
    } as any)
    expect(hasDismissCmd(shellCommands, sid)).toBe(true)
  })

  it("sends dismiss deeplink on question.rejected", async () => {
    const sid = "q-rejected"
    const { plugin, shellCommands } = await initPlugin()
    await plugin.event?.({
      event: {
        type: "question.rejected",
        properties: { sessionID: sid },
      },
    } as any)
    expect(hasDismissCmd(shellCommands, sid)).toBe(true)
  })

  it("does nothing when no sessionId", async () => {
    const { plugin, shellCommands } = await initPlugin()
    await plugin.event?.({
      event: { type: "question.answered", properties: {} },
    } as any)
    expect(
      shellCommands.filter((c) => c.includes("agent-dismiss")).length,
    ).toBe(0)
  })
})

// --- permission.replied handler ---

describe("permission.replied handler", () => {
  it("sends dismiss when answered via OpenCode UI", async () => {
    const sid = "perm-replied-ui"
    const permId = "perm-ui-001"
    const { plugin, shellCommands } = await initPlugin()
    await plugin.event?.({
      event: {
        type: "permission.replied",
        properties: {
          sessionID: sid,
          requestID: permId,
          reply: "always",
        },
      },
    } as any)
    await wait(100)
    expect(hasDismissCmd(shellCommands, sid)).toBe(true)
  })

  it("does not dismiss when sessionId is unknown", async () => {
    const { plugin, shellCommands } = await initPlugin()
    await plugin.event?.({
      event: {
        type: "permission.replied",
        properties: {
          requestID: "perm-no-session",
          reply: "once",
        },
      },
    } as any)
    await wait(100)
    expect(
      shellCommands.filter((c) => c.includes("agent-dismiss")).length,
    ).toBe(0)
  })
})
