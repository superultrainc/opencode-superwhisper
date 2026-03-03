import { EndReason } from "./types.js"

export function extractFullText(message: any): string {
  if (!message?.parts) return ""

  return message.parts
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text || "")
    .join("\n")
    .trim()
}

/**
 * Determine if a turn has truly ended. We do not want to prompt the user
 * with tool-calls that trigger session.idle.
 */
export function isEndTurn(message: any): boolean {
  if (!message?.parts) return false

  const stepFinishes = message.parts.filter(
    (p: any) => p.type === "step-finish",
  )
  if (!stepFinishes.length) return false

  const last = stepFinishes[stepFinishes.length - 1]
  return last.reason === EndReason.END_TURN || last.reason === EndReason.STOP
}

export function extractSummary(text: string): string {
  if (!text) return ""

  const maxLength = 200

  if (text.length <= maxLength) return text

  const sentenceEnd = text.substring(0, maxLength).lastIndexOf(". ")
  if (sentenceEnd > 100) return text.substring(0, sentenceEnd + 1)

  const wordEnd = text.substring(0, maxLength).lastIndexOf(" ")
  if (wordEnd > 150) return text.substring(0, wordEnd) + "..."

  return text.substring(0, maxLength) + "..."
}
