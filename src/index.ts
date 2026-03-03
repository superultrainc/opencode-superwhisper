import type { Plugin } from "@opencode-ai/plugin"
import { LOG_PREFIX, MESSAGE_DIR, POLL_TIMEOUT_MS, POLL_INTERVAL_MS } from "./types.js"
import type { DeeplinkParams } from "./types.js"
import { buildDeeplinkUrl } from "./deeplink.js"
import { extractFullText, isEndTurn, extractSummary } from "./message.js"
import { pollForResponse } from "./poll.js"
import {
  parseQuestionResponse,
  normalizeQuestions,
  normalizePermissionReply,
} from "./normalize.js"

export {
  buildDeeplinkUrl,
  extractFullText,
  isEndTurn,
  extractSummary,
  pollForResponse,
  parseQuestionResponse,
  normalizeQuestions,
  normalizePermissionReply,
}
export type { DeeplinkParams }

const CANCELLED = "$$CANCELLED$$"

async function detectScheme($: any): Promise<string> {
  const envScheme = process.env.SUPERWHISPER_SCHEME
  if (envScheme) return envScheme

  try {
    const result = await $`pgrep -f "DerivedData.*superwhisper.app"`.quiet()
    if (result.exitCode === 0) return "superwhisper-debug"
  } catch {
    // pgrep failed or not found
  }

  return "superwhisper"
}

export const SuperWhisperPlugin: Plugin = async ({
  client,
  $,
  directory,
  project,
  serverUrl,
}) => {
  const scheme = await detectScheme($)
  await $`mkdir -p ${MESSAGE_DIR}`

  // --- Internal state ---

  // Active polls keyed by sessionId (or permissionId for permission polls).
  // Each entry has a cancel function and a unique token so overlapping polls
  // for the same session don't accidentally delete each other's entries.
  const activePolls = new Map<string, { cancel: () => void; token: symbol }>()

  // Sessions with an active question notification (suppress subsequent session.idle)
  const questionActiveForSession = new Set<string>()

  // Sessions with an active permission request (suppress subsequent session.idle)
  const permissionActiveForSession = new Set<string>()

  // Sessions the user dismissed (pressed Escape). Don't re-notify until
  // a new user message arrives. Maps sessionId -> dismiss timestamp.
  const dismissedSessions = new Map<string, number>()

  // Permission IDs that WE replied to (via SuperWhisper), so we don't dismiss
  // SuperWhisper when the permission.replied event comes back.
  const repliedPermissionIds = new Set<string>()

  // Response file paths for active permission polls, keyed by permissionId.
  // When OpenCode's UI answers a permission instead of SuperWhisper, we write
  // the response file ourselves to unblock the hanging poll.
  const activePermissionResponseFiles = new Map<string, string>()

  // Sessions where we're about to inject a SuperWhisper response.
  // message.updated events for these are from SuperWhisper, not direct typing.
  const superwhisperInjectedSessions = new Set<string>()

  // Cache session titles from session.updated events (LLM-generated)
  const sessionTitles = new Map<string, string>()

  // --- Logging ---

  const LOG_FILE = `${MESSAGE_DIR}/debug.log`
  const { appendFileSync } = await import("fs")

  try {
    const internalClient = (client as any)._client
    const hasPost = !!internalClient?.post
    appendFileSync(
      LOG_FILE,
      `[${new Date().toISOString()}] [info] ${LOG_PREFIX} Plugin initialized, serverUrl=${serverUrl?.toString() ?? "UNDEFINED"}, hasInternalPost=${hasPost}\n`,
    )
  } catch {}

  function log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
  ) {
    client.app.log({
      body: {
        service: "superwhisper",
        level,
        message: `${LOG_PREFIX} ${message}`,
      },
    })
    try {
      appendFileSync(
        LOG_FILE,
        `[${new Date().toISOString()}] [${level}] ${message}\n`,
      )
    } catch {}
  }

  // --- Helpers ---

  async function getGitBranch(): Promise<string | undefined> {
    try {
      return (
        await $`git -C ${directory} rev-parse --abbrev-ref HEAD`.text()
      ).trim()
    } catch {
      return undefined
    }
  }

  async function internalPost(url: string, body?: any): Promise<any> {
    const internalClient = (client as any)._client
    if (!internalClient?.post) {
      throw new Error("No internal client.post available")
    }
    return internalClient.post({
      url,
      ...(body
        ? { body, headers: { "Content-Type": "application/json" } }
        : {}),
    })
  }

  async function getLastAssistantMessage(
    sessionId: string,
  ): Promise<any | undefined> {
    const messagesResponse = await client.session.messages({
      path: { id: sessionId },
    })
    const messages = messagesResponse.data || []
    return messages.filter((m: any) => m.info?.role === "assistant").pop()
  }

  // --- Notification ---

  async function sendNotification(params: {
    sessionId: string
    status: string
    summary: string
    messageContent: string
    pollKey?: string
  }): Promise<string | null> {
    const { sessionId, status, summary, messageContent } = params
    const pollKey = params.pollKey || sessionId

    const existing = activePolls.get(pollKey)
    if (existing) {
      log("info", `Cancelling existing poll for key=${pollKey}`)
      existing.cancel()
      activePolls.delete(pollKey)
    }

    const messageFile = `${MESSAGE_DIR}/${pollKey}-message.txt`
    const responseFile = `${MESSAGE_DIR}/${pollKey}-response.txt`

    try {
      await Bun.write(messageFile, messageContent)
    } catch (err) {
      log("error", `Failed to write message file: ${messageFile} — ${err}`)
      return null
    }

    // Remove any stale response file
    try {
      const rf = Bun.file(responseFile)
      if (await rf.exists()) {
        log("info", `Removing stale response file for session=${sessionId}`)
        await $`rm ${responseFile}`.quiet()
      }
    } catch {}

    const branch = await getGitBranch()
    const projectName = directory.split("/").pop() || project?.id || ""
    const title = sessionTitles.get(sessionId)

    if (title) {
      log("info", `Using cached session title for ${sessionId}: "${title}"`)
    }

    const url = buildDeeplinkUrl(scheme, {
      agent: "opencode",
      status,
      sessionId,
      summary,
      messageFile,
      responseFile,
      cwd: directory,
      project: projectName,
      branch,
      title,
    })

    try {
      await $`open ${url}`
    } catch (err) {
      log(
        "error",
        `Failed to open SuperWhisper deeplink. Is SuperWhisper installed? — ${err}`,
      )
      return null
    }

    log("info", `Notification sent: status=${status} session=${sessionId}`)

    let cancelled = false
    const pollToken = Symbol()
    activePolls.set(pollKey, {
      cancel: () => {
        cancelled = true
      },
      token: pollToken,
    })

    const response = await pollForResponse(
      responseFile,
      POLL_TIMEOUT_MS,
      POLL_INTERVAL_MS,
      () => cancelled,
    )

    const current = activePolls.get(pollKey)
    if (current && current.token === pollToken) {
      activePolls.delete(pollKey)
    }

    if (cancelled) {
      log("info", `Poll cancelled for key=${pollKey}`)
      return CANCELLED
    }

    if (response === null) {
      log("info", `Poll timed out for session=${sessionId}`)
      return null
    }

    log(
      "info",
      `Poll got response for session=${sessionId}: "${response.substring(0, 200)}"`,
    )

    try {
      await $`rm -f ${responseFile} ${messageFile}`.quiet()
    } catch {}

    return response
  }

  // --- Response senders ---

  async function sendResponseToOpenCode(sessionId: string, response: string) {
    if (!response) return
    try {
      superwhisperInjectedSessions.add(sessionId)
      await client.session.prompt({
        path: { id: sessionId },
        body: { parts: [{ type: "text", text: response }] },
      })
      log("info", `Response sent back to session=${sessionId}`)
    } catch (err) {
      log("error", `Failed to send response to session=${sessionId} — ${err}`)
    }
  }

  async function replyToQuestion(requestId: string, answers: string[][]) {
    try {
      const result = await internalPost(`/question/${requestId}/reply`, {
        answers,
      })
      const status = result?.response?.status ?? result?.data ?? "unknown"
      log("info", `Question reply sent for requestId=${requestId} (${status})`)
    } catch (err) {
      log("error", `Failed to reply to question requestId=${requestId} — ${err}`)
    }
  }

  async function rejectQuestion(requestId: string) {
    try {
      const result = await internalPost(`/question/${requestId}/reject`)
      const status = result?.response?.status ?? result?.data ?? "unknown"
      log("info", `Question rejected for requestId=${requestId} (${status})`)
    } catch (err) {
      log("error", `Failed to reject question requestId=${requestId} — ${err}`)
    }
  }

  async function replyToPermission(
    requestId: string,
    reply: "once" | "always" | "reject",
  ) {
    try {
      const result = await internalPost(`/permission/${requestId}/reply`, {
        reply,
      })
      const status = result?.response?.status ?? result?.data ?? "unknown"
      log(
        "info",
        `Permission reply sent for requestId=${requestId} reply=${reply} (${status})`,
      )
    } catch (err) {
      log("error", `Failed to reply to permission requestId=${requestId} — ${err}`)
    }
  }

  // --- Dismiss helpers ---

  function sendDismiss(sessionId: string, source: string) {
    const dismissUrl = `${scheme}://agent-dismiss?sessionId=${encodeURIComponent(sessionId)}`
    log("debug", `Sending dismiss deeplink (${source}): ${dismissUrl}`)
    $`open -g ${dismissUrl}`.quiet().catch((err: any) => {
      log("error", `Failed to send dismiss deeplink for session=${sessionId}: ${err}`)
    })
  }

  function cancelPoll(pollKey: string, source: string): boolean {
    const poll = activePolls.get(pollKey)
    if (poll) {
      poll.cancel()
      activePolls.delete(pollKey)
      log("debug", `Poll cancelled for key=${pollKey} (${source})`)
      return true
    }
    return false
  }

  function handleSessionBusy(sessionId: string, source: string) {
    const hasSessionPoll = activePolls.has(sessionId)
    const hasActiveQuestion = questionActiveForSession.has(sessionId)
    const hasActivePermission = permissionActiveForSession.has(sessionId)

    if (!hasSessionPoll && !hasActiveQuestion && !hasActivePermission) return

    if (superwhisperInjectedSessions.has(sessionId)) {
      cancelPoll(sessionId, source)
      superwhisperInjectedSessions.delete(sessionId)
      return
    }

    log(
      "info",
      `${source} for session=${sessionId} — poll=${hasSessionPoll}, question=${hasActiveQuestion}, permission=${hasActivePermission}`,
    )
    cancelPoll(sessionId, source)
    questionActiveForSession.delete(sessionId)
    permissionActiveForSession.delete(sessionId)
    sendDismiss(sessionId, source)
  }

  // --- Event handlers ---

  async function handleCompleted(event: any) {
    const sessionId = event.properties?.sessionID
    if (!sessionId) return

    if (dismissedSessions.has(sessionId)) {
      log("info", `Skipping completed for session=${sessionId} (dismissed)`)
      return
    }

    if (questionActiveForSession.has(sessionId)) {
      log("info", `Skipping completed for session=${sessionId} (question active)`)
      return
    }
    if (permissionActiveForSession.has(sessionId)) {
      log("info", `Skipping completed for session=${sessionId} (permission active)`)
      return
    }

    const lastAssistant = await getLastAssistantMessage(sessionId)
    const fullMessage = extractFullText(lastAssistant)

    if (!fullMessage) {
      log("info", `Skipping empty completion for session=${sessionId}`)
      return
    }

    if (!isEndTurn(lastAssistant)) {
      log("info", `Skipping mid-task idle for session=${sessionId} (not end_turn)`)
      return
    }

    const summary = extractSummary(fullMessage)

    const response = await sendNotification({
      sessionId,
      status: "completed",
      summary,
      messageContent: fullMessage,
    })

    if (response === CANCELLED) return

    if (
      questionActiveForSession.has(sessionId) ||
      permissionActiveForSession.has(sessionId)
    ) {
      log("info", `Discarding completed response for session=${sessionId} (question/permission became active)`)
      return
    }

    if (response) {
      dismissedSessions.delete(sessionId)
      await sendResponseToOpenCode(sessionId, response)
    } else {
      log("info", `Poll timed out for session=${sessionId} — will re-notify on next idle`)
    }
  }

  async function handleError(event: any) {
    const sessionId = event.properties?.sessionID || "unknown"
    const errorMessage = event.properties?.error || "An error occurred"

    const response = await sendNotification({
      sessionId,
      status: "error",
      summary: errorMessage.substring(0, 200),
      messageContent: errorMessage,
    })

    if (response) {
      await sendResponseToOpenCode(sessionId, response)
    }
  }

  async function handleQuestionAsked(event: any) {
    const props = event.properties || event
    const sessionId = props.sessionID
    if (!sessionId) return

    const requestId = props.id
    if (!requestId) {
      log("error", `Question event missing id for session=${sessionId}`)
      return
    }

    const questions = props.questions || []
    if (!questions.length) return

    questionActiveForSession.add(sessionId)

    let context: string | undefined
    try {
      const lastAssistant = await getLastAssistantMessage(sessionId)
      const text = extractFullText(lastAssistant)
      if (text) {
        context = text
        log("info", `Extracted context (${text.length} chars) for question in session=${sessionId}`)
      }
    } catch (err) {
      log("warn", `Failed to fetch context for question: ${err}`)
    }

    const normalized = normalizeQuestions(questions)
    const elicitationData: Record<string, any> = { questions: normalized }
    if (context) elicitationData.context = context

    const firstQuestion =
      questions[0]?.question || "OpenCode is asking a question"

    log("info", `Question asked in session=${sessionId} requestId=${requestId}: ${firstQuestion}`)

    const response = await sendNotification({
      sessionId,
      status: "question",
      summary: firstQuestion,
      messageContent: JSON.stringify(elicitationData),
    })

    questionActiveForSession.delete(sessionId)

    if (response === CANCELLED) return

    if (response) {
      dismissedSessions.delete(sessionId)
      const answers = parseQuestionResponse(response)
      log("info", `Replying to question requestId=${requestId} with answers=${JSON.stringify(answers)}`)
      await replyToQuestion(requestId, answers)
    } else {
      log("info", `Poll timed out for question in session=${sessionId} — rejecting`)
      await rejectQuestion(requestId)
    }
  }

  async function handlePermission(event: any) {
    const props = event.properties || event
    const sessionId = props.sessionID || "unknown"
    const permissionId = props.id
    const permissionType = props.permission || "unknown"
    const patterns = props.patterns || []
    const toolInfo = props.tool || {}

    if (!permissionId) {
      log("error", `Permission event missing id for session=${sessionId}`)
      return
    }

    log("info", `Permission requested: id=${permissionId} type=${permissionType}`)

    permissionActiveForSession.add(sessionId)

    const responseFile = `${MESSAGE_DIR}/${permissionId}-response.txt`
    activePermissionResponseFiles.set(permissionId, responseFile)

    const summary = `Permission needed: ${permissionType}`
    const permissionPayload = JSON.stringify({
      permissionId,
      toolName: toolInfo.tool || permissionType,
      summary,
      details: patterns.join(", "),
      suggestions: [
        { label: "Allow", behavior: "allow" },
        { label: "Always Allow", behavior: "always" },
        { label: "Deny", behavior: "deny" },
      ],
    })

    const response = await sendNotification({
      sessionId,
      status: "permission",
      summary,
      messageContent: permissionPayload,
      pollKey: permissionId,
    })

    activePermissionResponseFiles.delete(permissionId)
    permissionActiveForSession.delete(sessionId)

    if (response === CANCELLED) return

    if (!response) {
      log("info", `Poll timed out for permission ${permissionId}`)
      return
    }

    dismissedSessions.delete(sessionId)
    const normalized = normalizePermissionReply(response)
    log("info", `Replying to permission ${permissionId} with "${normalized}"`)
    repliedPermissionIds.add(permissionId)
    await replyToPermission(permissionId, normalized)
  }

  // --- Event router ---

  return {
    event: async ({ event }) => {
      // Cast to any — OpenCode's type definitions don't include all event
      // types we handle (permission.asked, question.asked, etc.)
      const e = event as any

      log(
        "debug",
        `Event: ${e.type} ${JSON.stringify(e.properties || {}).substring(0, 300)}`,
      )

      switch (e.type as string) {
        case "session.idle":
          handleCompleted(e).catch((err: any) =>
            log("error", `handleCompleted failed: ${err}`),
          )
          break

        case "session.busy": {
          const sessionId = e.properties?.sessionID
          if (sessionId) handleSessionBusy(sessionId, "session.busy")
          break
        }

        case "session.status": {
          const props = e.properties || {}
          const statusType = props.status?.type
          const sessionId = props.sessionID
          if (statusType === "busy" && sessionId) {
            handleSessionBusy(sessionId, "session.status(busy)")
          }
          break
        }

        case "session.error":
          handleError(e).catch((err: any) =>
            log("error", `handleError failed: ${err}`),
          )
          break

        case "permission.asked":
          handlePermission(e).catch((err: any) =>
            log("error", `handlePermission failed: ${err}`),
          )
          break

        case "question.asked":
          handleQuestionAsked(e).catch((err: any) =>
            log("error", `handleQuestionAsked failed: ${err}`),
          )
          break

        case "question.replied":
        case "question.rejected":
        case "question.answered": {
          const sessionId = e.properties?.sessionID
          if (sessionId) {
            log("info", `Question ${e.type} for session=${sessionId}`)
            questionActiveForSession.delete(sessionId)
            cancelPoll(sessionId, `question.${e.type}`)
            sendDismiss(sessionId, `question.${e.type}`)
          }
          break
        }

        case "permission.replied": {
          const props = e.properties || e
          const sessionId = props.sessionID || "unknown"
          const permissionId = props.requestID || props.id

          if (permissionId && repliedPermissionIds.has(permissionId)) {
            log("info", `Permission ${permissionId} replied (we replied via SuperWhisper)`)
            repliedPermissionIds.delete(permissionId)
            permissionActiveForSession.delete(sessionId)
            return
          }

          // Answered through OpenCode's UI — unblock any hanging poll
          if (
            permissionId &&
            activePermissionResponseFiles.has(permissionId)
          ) {
            const respFile = activePermissionResponseFiles.get(permissionId)!
            const reply = (props.reply as string) || "allow"
            log("info", `Permission ${permissionId} answered via OpenCode UI (reply=${reply})`)
            try {
              await Bun.write(respFile, reply)
            } catch (err) {
              log("warn", `Failed to write unblock response for ${permissionId}: ${err}`)
            }
          }

          if (permissionId && sessionId && sessionId !== "unknown") {
            permissionActiveForSession.delete(sessionId)
            cancelPoll(permissionId, `permission.replied(${permissionId})`)
            sendDismiss(sessionId, `permission.replied(${permissionId})`)
          }
          break
        }

        case "session.updated": {
          const props = e.properties || {}
          const sessionId = props.info?.id
          const title = props.info?.title
          if (sessionId && title && typeof title === "string") {
            const isDefault = title.startsWith("New session - ")
            if (!isDefault && sessionTitles.get(sessionId) !== title) {
              log("info", `Cached session title for ${sessionId}: "${title}"`)
              sessionTitles.set(sessionId, title)
            }
          }
          break
        }

        case "message.updated": {
          const props = e.properties || {}
          const sessionId = props.info?.sessionID
          const role = props.info?.role
          if (sessionId && role === "user") {
            dismissedSessions.delete(sessionId)
          }
          break
        }
      }
    },
  }
}

export default SuperWhisperPlugin
