import { mkdirSync, writeFileSync, renameSync, unlinkSync } from "fs"
import { randomUUID } from "crypto"
import { homedir } from "os"
import { join } from "path"
import { run } from "./system.js"

export interface InboxPayload {
  kind: "update" | "dismiss"
  sessionId?: string
  requestId?: string
  agent?: string
  status?: string
  summary?: string
  message?: string
  messageFile?: string
  responseFile?: string
  cwd?: string
  project?: string
  branch?: string
  title?: string
  hookPid?: number
}

let INBOX_DIR = join(
  homedir(),
  "Library/Application Support/superwhisper/agent/inbox",
)

export function __setInboxDirForTest(dir: string): void {
  INBOX_DIR = dir
}

export function writeInboxPayload(payload: InboxPayload): boolean {
  try {
    mkdirSync(INBOX_DIR, { recursive: true })
  } catch {
    return false
  }

  const base = randomUUID()
  const tmpPath = join(INBOX_DIR, `${base}.json.tmp`)
  const finalPath = join(INBOX_DIR, `${base}.json`)

  try {
    writeFileSync(tmpPath, JSON.stringify(payload))
    renameSync(tmpPath, finalPath)
    return true
  } catch {
    try {
      unlinkSync(tmpPath)
    } catch {}
    return false
  }
}

export async function isSuperwhisperRunning(): Promise<boolean> {
  return (await run("pgrep", ["-x", "superwhisper"])).code === 0
}

export async function deliverAgentPayload(
  payload: InboxPayload,
  scheme: string,
): Promise<boolean> {
  const wrote = writeInboxPayload(payload)
  if (!(await isSuperwhisperRunning())) {
    await run("open", [`${scheme}://agent-wake`])
  }
  return wrote
}
