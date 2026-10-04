import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { extractFullText, extractSummary, isEndTurn } from "./message.js"
import { pollForResponse } from "./poll.js"
import { normalizePermissionReply, normalizeQuestions, parseQuestionResponse } from "./normalize.js"
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

describe("normalizeQuestions", () => {
  it("defaults options to [] and multiSelect to false", () => {
    expect(normalizeQuestions([{ question: "Q" }])).toEqual([
      { question: "Q", header: undefined, options: [], multiSelect: false },
    ])
  })

  it("maps multiple to multiSelect", () => {
    const [q] = normalizeQuestions([{ question: "Q", multiple: true, options: [{ label: "A" }] }])
    expect(q.multiSelect).toBe(true)
    expect(q.options).toEqual([{ label: "A" }])
  })

  it("prefers explicit multiSelect", () => {
    expect(normalizeQuestions([{ question: "Q", multiSelect: false, multiple: true }])[0].multiSelect).toBe(false)
  })
})

describe("parseQuestionResponse", () => {
  it("parses structured JSON", () => {
    expect(parseQuestionResponse('{"answers":[["A"],["B","C"]]}')).toEqual([["A"], ["B", "C"]])
  })

  it("falls back to comma-separated labels", () => {
    expect(parseQuestionResponse("A, B ,,C")).toEqual([["A"], ["B"], ["C"]])
  })

  it("falls back when JSON has no answers array", () => {
    expect(parseQuestionResponse('{"x":1}')).toEqual([['{"x":1}']])
  })
})

describe("normalizePermissionReply", () => {
  it("maps labels and keywords", () => {
    expect(normalizePermissionReply("Allow")).toBe("once")
    expect(normalizePermissionReply("Always Allow")).toBe("always")
    expect(normalizePermissionReply("Bypass permissions for this session")).toBe("bypass")
    expect(normalizePermissionReply("Deny")).toBe("reject")
    expect(normalizePermissionReply("no")).toBe("reject")
    expect(normalizePermissionReply(" REJECT ")).toBe("reject")
  })
})
