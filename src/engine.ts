import { existsSync, writeFileSync, unlinkSync, mkdirSync } from "fs"
import {
  MESSAGE_DIR,
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  type EngineEvent,
  type Host,
} from "./types.js"
import { deliverAgentPayload } from "./inbox.js"
import { extractSummary } from "./message.js"
import { pollForResponse } from "./poll.js"
import {
  parseQuestionResponse,
  normalizeQuestions,
  normalizePermissionReply,
} from "./normalize.js"
import { detectScheme, gitBranch } from "./system.js"

const CANCELLED = "$$CANCELLED$$"

export interface Engine {
  handle(event: EngineEvent): void
  setEnabled(sessionId: string, enabled: boolean): void
  dispose(): void
}

export async function createEngine(host: Host): Promise<Engine> {
  const scheme = await detectScheme()
  mkdirSync(MESSAGE_DIR, { recursive: true })
  const log = host.log

  log(
    "info",
    `Started (OpenCode ${host.opencodeVersion ?? "unknown"}, plugin API v${host.apiVersion}, scheme=${scheme})`,
  )

  // Keyed by sessionId, or permissionId for permission polls. The token stops an
  // older poll from deleting a newer poll's entry for the same key.
  const activePolls = new Map<string, { cancel: () => void; token: symbol }>()

  // A pending question/permission suppresses the session.idle that follows it.
  const questionActiveForSession = new Set<string>()
  const permissionActiveForSession = new Set<string>()

  // In-memory copy so disable works before the flag file lands.
  const disabledSessions = new Set<string>()

  // Permission replies we sent, so their permission.replied event doesn't dismiss.
  const repliedPermissionIds = new Set<string>()

  // Response files for permission polls, so an answer in OpenCode's UI can unblock them.
  const activePermissionResponseFiles = new Map<string, string>()

  // Permissions answered in OpenCode's UI; never reply to these ourselves.
  const answeredInOpenCode = new Set<string>()

  // The next busy event for these sessions comes from our own prompt.
  const superwhisperInjectedSessions = new Set<string>()

  const sessionTitles = new Map<string, string>()
  const subagentSessions = new Set<string>()

  // --- Session flags ---

  function isSessionDisabled(sessionId: string): boolean {
    if (disabledSessions.has(sessionId)) return true
    return existsSync(`${MESSAGE_DIR}/disabled-${sessionId}`)
  }

  function setEnabled(sessionId: string, enabled: boolean): void {
    const flagPath = `${MESSAGE_DIR}/disabled-${sessionId}`
    try {
      if (enabled) {
        disabledSessions.delete(sessionId)
        if (existsSync(flagPath)) unlinkSync(flagPath)
      } else {
        disabledSessions.add(sessionId)
        writeFileSync(flagPath, "")
      }
    } catch (err) {
      log("error", `Failed to update disabled flag for session=${sessionId}: ${err}`)
    }
    log("info", `Superwhisper ${enabled ? "enabled" : "disabled"} for session=${sessionId}`)
  }

  function shouldSkip(sessionId: string, kind: string): boolean {
    if (isSessionDisabled(sessionId)) {
      log("debug", `Skipping ${kind} for session=${sessionId} (disabled)`)
      return true
    }
    if (subagentSessions.has(sessionId)) {
      log("debug", `Skipping ${kind} for session=${sessionId} (subagent)`)
      return true
    }
    return false
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

    cancelPoll(pollKey, "superseded")

    const messageFile = `${MESSAGE_DIR}/${pollKey}-message.txt`
    const responseFile = `${MESSAGE_DIR}/${pollKey}-response.txt`

    try {
      writeFileSync(messageFile, messageContent)
    } catch (err) {
      log("error", `Failed to write message file: ${messageFile} — ${err}`)
      return null
    }

    try {
      if (existsSync(responseFile)) unlinkSync(responseFile)
    } catch {}

    try {
      await deliverAgentPayload(
        {
          kind: "update",
          agent: "opencode",
          status,
          sessionId,
          summary,
          messageFile,
          responseFile,
          cwd: host.directory,
          project: host.projectName,
          branch: await gitBranch(host.directory),
          title: sessionTitles.get(sessionId),
          hookPid: process.pid,
        },
        scheme,
      )
    } catch (err) {
      log("error", `Failed to deliver Superwhisper payload — ${err}`)
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

    if (activePolls.get(pollKey)?.token === pollToken) activePolls.delete(pollKey)

    if (cancelled) {
      log("info", `Poll cancelled for key=${pollKey}`)
      return CANCELLED
    }
    if (response === null) {
      log("info", `Poll timed out for key=${pollKey}`)
      return null
    }

    log("info", `Poll got response for key=${pollKey}: "${response.substring(0, 200)}"`)
    for (const file of [responseFile, messageFile]) {
      try {
        unlinkSync(file)
      } catch {}
    }
    return response
  }

  async function sendResponse(sessionId: string, response: string) {
    if (!response) return
    try {
      superwhisperInjectedSessions.add(sessionId)
      await host.prompt(sessionId, response)
      log("info", `Response sent back to session=${sessionId}`)
    } catch (err) {
      superwhisperInjectedSessions.delete(sessionId)
      log("error", `Failed to send response to session=${sessionId} — ${err}`)
    }
  }

  // --- Dismiss helpers ---

  function sendDismiss(sessionId: string, source: string) {
    log("debug", `Sending dismiss (${source}) for session=${sessionId}`)
    deliverAgentPayload({ kind: "dismiss", sessionId }, scheme).catch((err) =>
      log("error", `Failed to send dismiss for session=${sessionId}: ${err}`),
    )
  }

  function cancelPoll(pollKey: string, source: string): boolean {
    const poll = activePolls.get(pollKey)
    if (!poll) return false
    poll.cancel()
    activePolls.delete(pollKey)
    log("debug", `Poll cancelled for key=${pollKey} (${source})`)
    return true
  }

  function handleSessionBusy(sessionId: string) {
    // The first busy after our own prompt is that prompt starting, not the user typing.
    if (superwhisperInjectedSessions.delete(sessionId)) {
      cancelPoll(sessionId, "busy")
      return
    }

    const hasSessionPoll = activePolls.has(sessionId)
    const hasActiveQuestion = questionActiveForSession.has(sessionId)
    const hasActivePermission = permissionActiveForSession.has(sessionId)
    if (!hasSessionPoll && !hasActiveQuestion && !hasActivePermission) return

    log(
      "info",
      `Session busy=${sessionId} — poll=${hasSessionPoll}, question=${hasActiveQuestion}, permission=${hasActivePermission}`,
    )
    cancelPoll(sessionId, "busy")
    questionActiveForSession.delete(sessionId)
    permissionActiveForSession.delete(sessionId)
    sendDismiss(sessionId, "busy")
  }

  // --- Event handlers ---

  async function handleIdle(sessionId: string) {
    if (shouldSkip(sessionId, "completed")) return
    if (questionActiveForSession.has(sessionId) || permissionActiveForSession.has(sessionId)) {
      log("info", `Skipping completed for session=${sessionId} (question/permission active)`)
      return
    }

    const turn = await host.lastAssistant(sessionId)
    if (!turn?.text) {
      log("info", `Skipping empty completion for session=${sessionId}`)
      return
    }
    if (!turn.endTurn) {
      log("info", `Skipping mid-task idle for session=${sessionId} (not end of turn)`)
      return
    }

    const response = await sendNotification({
      sessionId,
      status: "completed",
      summary: extractSummary(turn.text),
      messageContent: turn.text,
    })
    if (response === CANCELLED) return

    if (questionActiveForSession.has(sessionId) || permissionActiveForSession.has(sessionId)) {
      log("info", `Discarding completed response for session=${sessionId} (question/permission became active)`)
      return
    }

    if (response) {
      await sendResponse(sessionId, response)
    } else {
      sendDismiss(sessionId, "completed-timeout")
    }
  }

  async function handleError(sessionId: string, message: string) {
    if (shouldSkip(sessionId, "error")) return

    const response = await sendNotification({
      sessionId,
      status: "error",
      summary: message.substring(0, 200),
      messageContent: message,
    })
    if (response === CANCELLED) return

    if (response) {
      await sendResponse(sessionId, response)
    } else {
      sendDismiss(sessionId, "error-timeout")
    }
  }

  async function handleQuestion(event: Extract<EngineEvent, { type: "question.asked" }>) {
    const { id, sessionId, questions } = event
    if (shouldSkip(sessionId, "question")) return
    if (!questions.length) return

    questionActiveForSession.add(sessionId)

    const data: Record<string, unknown> = { questions: normalizeQuestions(questions) }
    try {
      const turn = await host.lastAssistant(sessionId)
      if (turn?.text) data.context = turn.text
    } catch (err) {
      log("warn", `Failed to fetch context for question: ${err}`)
    }

    const summary = questions[0]?.question || "OpenCode is asking a question"
    log("info", `Question asked in session=${sessionId} requestId=${id}: ${summary}`)

    const response = await sendNotification({
      sessionId,
      status: "question",
      summary,
      messageContent: JSON.stringify(data),
    })

    questionActiveForSession.delete(sessionId)
    if (response === CANCELLED) return

    const request = { id, sessionId }
    try {
      if (response) {
        const answers = parseQuestionResponse(response)
        log("info", `Replying to question requestId=${id} with answers=${JSON.stringify(answers)}`)
        await host.replyQuestion(request, answers)
      } else {
        log("info", `Poll timed out for question in session=${sessionId} — rejecting`)
        await host.rejectQuestion(request)
      }
    } catch (err) {
      log("error", `Failed to answer question requestId=${id} — ${err}`)
    }
  }

  async function handlePermission(event: Extract<EngineEvent, { type: "permission.asked" }>) {
    const { id, sessionId, permission, patterns, toolName } = event
    if (shouldSkip(sessionId, "permission")) return

    log("info", `Permission requested: id=${id} type=${permission}`)
    const request = { id, sessionId }

    const bypassFile = `${MESSAGE_DIR}/${sessionId}-bypass-perms`
    if (existsSync(bypassFile)) {
      log("info", `Bypass-perms active for session=${sessionId}, auto-allowing ${permission}`)
      repliedPermissionIds.add(id)
      await replyPermission(request, "once")
      return
    }

    permissionActiveForSession.add(sessionId)
    const responseFile = `${MESSAGE_DIR}/${id}-response.txt`
    activePermissionResponseFiles.set(id, responseFile)

    const summary = `Permission needed: ${permission}`
    const response = await sendNotification({
      sessionId,
      status: "permission",
      summary,
      messageContent: JSON.stringify({
        permissionId: id,
        toolName: toolName || permission,
        summary,
        details: patterns.join(", "),
        suggestions: [
          { label: "Allow", behavior: "allow" },
          { label: "Always Allow", behavior: "always" },
          { label: "Bypass permissions for this session", behavior: "bypass-perms" },
          { label: "Deny", behavior: "deny" },
        ],
      }),
      pollKey: id,
    })

    activePermissionResponseFiles.delete(id)
    permissionActiveForSession.delete(sessionId)
    // Answered in OpenCode; if that happened before our poll existed, nothing dismissed yet.
    if (answeredInOpenCode.delete(id)) {
      if (response !== CANCELLED) sendDismiss(sessionId, `permission.replied(${id})`)
      return
    }
    if (response === CANCELLED) return

    if (!response) {
      sendDismiss(sessionId, `permission-timeout(${id})`)
      return
    }

    const normalized = normalizePermissionReply(response)
    if (normalized === "bypass") {
      try {
        writeFileSync(bypassFile, "")
        log("info", `Bypass-perms mode enabled for session=${sessionId}`)
      } catch (err) {
        log("error", `Failed to write bypass file: ${err}`)
      }
    }

    repliedPermissionIds.add(id)
    await replyPermission(request, normalized === "bypass" ? "once" : normalized)
  }

  async function replyPermission(request: { id: string; sessionId: string }, reply: "once" | "always" | "reject") {
    try {
      await host.replyPermission(request, reply)
      log("info", `Permission reply sent for requestId=${request.id} reply=${reply}`)
    } catch (err) {
      repliedPermissionIds.delete(request.id)
      log("error", `Failed to reply to permission requestId=${request.id} — ${err}`)
    }
  }

  function handlePermissionReplied(event: Extract<EngineEvent, { type: "permission.replied" }>) {
    const { id, sessionId } = event

    if (repliedPermissionIds.delete(id)) {
      permissionActiveForSession.delete(sessionId)
      return
    }

    // Answered in OpenCode's own UI: unblock our poll.
    if (permissionActiveForSession.has(sessionId)) answeredInOpenCode.add(id)
    const responseFile = activePermissionResponseFiles.get(id)
    if (responseFile) {
      log("info", `Permission ${id} answered via OpenCode UI (reply=${event.reply})`)
      try {
        writeFileSync(responseFile, event.reply || "once")
      } catch (err) {
        log("warn", `Failed to write unblock response for ${id}: ${err}`)
      }
    }

    permissionActiveForSession.delete(sessionId)
    cancelPoll(id, `permission.replied(${id})`)
    sendDismiss(sessionId, `permission.replied(${id})`)
  }

  function run(name: string, task: Promise<void>) {
    task.catch((err) => log("error", `${name} failed: ${err}`))
  }

  function handle(event: EngineEvent) {
    switch (event.type) {
      case "idle":
        return run("handleIdle", handleIdle(event.sessionId))
      case "busy":
        return handleSessionBusy(event.sessionId)
      case "error":
        return run("handleError", handleError(event.sessionId, event.message))
      case "permission.asked":
        return run("handlePermission", handlePermission(event))
      case "permission.replied":
        return handlePermissionReplied(event)
      case "question.asked":
        return run("handleQuestion", handleQuestion(event))
      case "question.closed":
        questionActiveForSession.delete(event.sessionId)
        cancelPoll(event.sessionId, "question.closed")
        sendDismiss(event.sessionId, "question.closed")
        return
      case "session.info":
        if (event.parentId) subagentSessions.add(event.sessionId)
        if (event.title && !event.title.startsWith("New session - ")) {
          sessionTitles.set(event.sessionId, event.title)
        }
        return
    }
  }

  function dispose() {
    for (const poll of activePolls.values()) poll.cancel()
    activePolls.clear()
  }

  return { handle, setEnabled, dispose }
}
