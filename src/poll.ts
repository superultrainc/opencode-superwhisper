import { POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from "./types.js"

export async function pollForResponse(
  path: string,
  timeoutMs: number = POLL_TIMEOUT_MS,
  intervalMs: number = POLL_INTERVAL_MS,
  isCancelled?: () => boolean,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (isCancelled?.()) return null
    try {
      const file = Bun.file(path)
      if (await file.exists()) {
        const text = await file.text()
        if (text && text.trim().length > 0) return text
      }
    } catch {
      // File doesn't exist yet
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }

  return null
}
