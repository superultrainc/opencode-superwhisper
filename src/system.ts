import { appendFileSync } from "fs"
import { execFile } from "child_process"
import { MESSAGE_DIR, type LogLevel } from "./types.js"

export interface RunResult {
  code: number
  stdout: string
}

export type Runner = (cmd: string, args: string[]) => Promise<RunResult>

// Node child_process instead of Bun's `$`: V2 plugins get no shell, and V1 only has `$` under Bun.
const execRunner: Runner = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5_000 }, (err, stdout) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0
      resolve({ code, stdout: String(stdout ?? "") })
    })
  })

let runner: Runner = execRunner

export function __setRunnerForTest(next: Runner | undefined): void {
  runner = next ?? execRunner
}

export function run(cmd: string, args: string[]): Promise<RunResult> {
  return runner(cmd, args).catch(() => ({ code: 1, stdout: "" }))
}

export async function detectScheme(): Promise<string> {
  const envScheme = process.env.SUPERWHISPER_SCHEME
  if (envScheme) return envScheme
  const result = await run("pgrep", ["-f", "DerivedData.*superwhisper.app"])
  return result.code === 0 ? "superwhisper-debug" : "superwhisper"
}

export async function gitBranch(directory: string): Promise<string | undefined> {
  const result = await run("git", ["-C", directory, "rev-parse", "--abbrev-ref", "HEAD"])
  const branch = result.stdout.trim()
  return result.code === 0 && branch ? branch : undefined
}

export function debugFileLog(level: LogLevel, message: string) {
  if (!process.env.SUPERWHISPER_DEBUG) return
  try {
    appendFileSync(`${MESSAGE_DIR}/debug.log`, `[${new Date().toISOString()}] [${level}] ${message}\n`)
  } catch {}
}
