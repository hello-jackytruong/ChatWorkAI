import type { ZaloAccountHistoryRun } from "@chatbotx.io/database/schema"

const MAX_HISTORY_PAGES = 10

export function advanceZaloHistoryRun(
  run: ZaloAccountHistoryRun,
  page: {
    fingerprint: string
    providerExhausted: boolean
    oldestProviderMessageId?: string
    messages: number
    mediaQueued: number
    skipped: number
  },
): ZaloAccountHistoryRun {
  if (run.fingerprints.includes(page.fingerprint)) {
    return {
      ...run,
      status: "partial",
      error: "repeated_page",
      canResume: false,
    }
  }

  const candidate =
    run.scope.threadType === "user" && !page.providerExhausted
      ? page.oldestProviderMessageId
      : undefined
  const repeatedCursor = Boolean(candidate && run.cursors.includes(candidate))
  const pages = run.pages + 1
  const skipped = run.skipped + page.skipped
  const canResume = Boolean(
    candidate && !repeatedCursor && pages < MAX_HISTORY_PAGES,
  )
  return {
    ...run,
    status: page.providerExhausted && skipped === 0 ? "complete" : "partial",
    error: repeatedCursor ? "repeated_cursor" : undefined,
    cursor: canResume ? candidate : undefined,
    fingerprints: [...run.fingerprints, page.fingerprint],
    cursors: candidate ? [...run.cursors, candidate] : run.cursors,
    pages,
    messages: run.messages + page.messages,
    mediaQueued: run.mediaQueued + page.mediaQueued,
    skipped,
    canResume,
  }
}
