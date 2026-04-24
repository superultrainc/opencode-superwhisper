import { mkdirSync, writeFileSync, renameSync, unlinkSync } from "fs"
import { randomUUID } from "crypto"
import { homedir } from "os"
import { join } from "path"

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

export function getInboxDir(): string {
  const override = process.env.SUPERWHISPER_INBOX_DIR
  if (override) return override
  return join(
    homedir(),
    "Library/Application Support/superwhisper/agent/inbox",
  )
}

export function writeInboxPayload(payload: InboxPayload): boolean {
  const dir = getInboxDir()
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return false
  }

  const base = randomUUID()
  const tmpPath = join(dir, `${base}.json.tmp`)
  const finalPath = join(dir, `${base}.json`)

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

export async function isSuperwhisperRunning($: any): Promise<boolean> {
  try {
    const result = await $`pgrep -x superwhisper`.quiet()
    return result.exitCode === 0
  } catch {
    return false
  }
}

export async function fireAgentWake(scheme: string, $: any): Promise<void> {
  const url = `${scheme}://agent-wake`
  try {
    await $`open ${url}`.quiet()
  } catch {
    // wake is best-effort
  }
}

export async function deliverAgentPayload(
  payload: InboxPayload,
  scheme: string,
  $: any,
): Promise<boolean> {
  const wrote = writeInboxPayload(payload)
  const running = await isSuperwhisperRunning($)
  if (!running) {
    await fireAgentWake(scheme, $)
  }
  return wrote
}
