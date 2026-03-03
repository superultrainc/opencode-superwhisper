import type { DeeplinkParams } from "./types.js"

export function buildDeeplinkUrl(
  scheme: string,
  params: DeeplinkParams,
): string {
  const base = `${scheme}://agent-update`
  const entries = Object.entries(params).filter(
    ([_, v]) => v !== undefined && v !== "",
  )
  const query = entries
    .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
    .join("&")
  return `${base}?${query}`
}
