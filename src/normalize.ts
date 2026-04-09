/**
 * Parse a structured question answer response from Superwhisper.
 * Expected format: {"answers":[["label1"],["label2","label3"]]}
 * Fallback: treat as comma-separated labels, one answer per question.
 */
export function parseQuestionResponse(response: string): string[][] {
  try {
    const parsed = JSON.parse(response)
    if (Array.isArray(parsed.answers)) return parsed.answers
  } catch {
    // Not valid JSON — fall through to comma-separated fallback
  }
  const labels = response
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean)
  return labels.map((l: string) => [l])
}

/**
 * Normalize question data to Superwhisper's expected format (multiSelect, not multiple).
 */
export function normalizeQuestions(questions: any[]): any[] {
  return questions.map((q: any) => ({
    question: q.question,
    header: q.header,
    options: q.options,
    multiSelect: q.multiSelect ?? q.multiple ?? false,
  }))
}

/**
 * Normalise a raw permission reply string into the enum OpenCode expects.
 */
/**
 * Normalise a raw permission reply string into the enum OpenCode expects.
 * Accepts numeric indices (matching suggestion order), keywords, or full labels.
 * Suggestion order: 1=Allow, 2=Always Allow, 3=Bypass permissions, 4=Deny
 */
export function normalizePermissionReply(
  raw: string,
): "once" | "always" | "reject" | "bypass" {
  const s = raw.trim().toLowerCase()
  // Keyword/label matching
  if (s === "bypass" || s.includes("bypass")) return "bypass"
  if (s === "always" || s.includes("always")) return "always"
  if (
    s === "reject" ||
    s === "deny" ||
    s === "no" ||
    s.includes("deny") ||
    s.includes("reject")
  )
    return "reject"
  return "once"
}
