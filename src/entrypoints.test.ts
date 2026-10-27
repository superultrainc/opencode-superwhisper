import { describe, it, expect, beforeAll } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import * as root from "./index.js"
import serverEntry from "./server.js"
import { __setInboxDirForTest } from "./inbox.js"
import { __setRunnerForTest } from "./system.js"
import { MESSAGE_DIR } from "./types.js"

beforeAll(() => {
  rmSync("/tmp/superwhisper-test-inbox-entry", { recursive: true, force: true })
  mkdirSync(MESSAGE_DIR, { recursive: true })
  __setInboxDirForTest("/tmp/superwhisper-test-inbox-entry")
  __setRunnerForTest(async () => ({ code: 0, stdout: "main\n" }))
})

function mockInput() {
  return {
    client: {
      app: { log: async () => {} },
      session: { messages: async () => ({ data: [] }), prompt: async () => {} },
      _client: { post: async () => ({ response: { status: 200 } }), get: async () => ({ data: {} }) },
    },
    directory: "/tmp/entry-project",
    project: { id: "p" },
  } as any
}

describe("OpenCode 1.0-1.2 loader (package root)", () => {
  it("exports only functions, since every export is called as a plugin", () => {
    const exports = Object.entries(root)
    expect(exports.length).toBeGreaterThan(0)
    for (const [name, value] of exports) expect(typeof value, name).toBe("function")
  })

  it("default export returns hooks with event and tool", async () => {
    const hooks: any = await root.default(mockInput())
    expect(typeof hooks.event).toBe("function")
    expect(hooks.tool).toBeDefined()
    expect(typeof hooks.tool.superwhisper_toggle.execute).toBe("function")
  })

  it("every export can be called as a plugin and yields hooks", async () => {
    for (const fn of Object.values(root)) {
      const hooks: any = await (fn as any)(mockInput())
      expect(typeof hooks.event).toBe("function")
    }
  })
})

describe("OpenCode 1.3+ loader (server.ts default)", () => {
  it("is an object with a string id and a server function, and no tui", () => {
    const mod = serverEntry as any
    expect(typeof mod).toBe("object")
    expect(typeof mod.id).toBe("string")
    expect(mod.id).toBe("superwhisper")
    expect(typeof mod.server).toBe("function")
    expect("tui" in mod).toBe(false)
  })

  it("server returns hooks", async () => {
    const hooks: any = await serverEntry.server(mockInput())
    expect(typeof hooks.event).toBe("function")
    expect(hooks.tool.superwhisper_toggle).toBeDefined()
  })
})

describe("OpenCode 2 loader (server.ts default)", () => {
  it("is an object (not a function) with a string id and a setup function", () => {
    const mod = serverEntry as any
    expect(typeof mod).toBe("object")
    expect(typeof mod).not.toBe("function")
    expect(typeof mod.id).toBe("string")
    expect(typeof mod.setup).toBe("function")
  })
})
