import { getChildLogger } from "@chatbotx.io/logger"

const logger = getChildLogger("zalo-account-message-integrity")
const reasons = [
  "missing_identity",
  "invalid_identity",
  "invalid_fields",
  "invalid_group_message",
  "missing_message_fields",
  "unsupported_content",
  "unknown_thread_type",
  "undo_missing_message_id",
  "saturation",
  "publish_failed",
  "unsupported_schema",
] as const
type Reason = (typeof reasons)[number]
const counts: Partial<Record<Reason, number>> = {}
let lastFlush = Date.now()
export const recordMessageDiagnostic = (input: string): void => {
  const reason = reasons.includes(input as Reason)
    ? (input as Reason)
    : "invalid_fields"
  counts[reason] = Math.min(Number.MAX_SAFE_INTEGER, (counts[reason] ?? 0) + 1)
  if (Date.now() - lastFlush < 60_000) {
    return
  }
  lastFlush = Date.now()
  logger.warn({ counts: { ...counts } }, "Zalo Account message diagnostics")
  for (const key of reasons) {
    delete counts[key]
  }
}
// Only message callbacks reserve space. Lifecycle/QR/lease work never consumes it.
export const messageBacklog = { count: 0, bytes: 0 }
export const messageBacklogReady = () =>
  messageBacklog.count < 200 && messageBacklog.bytes < 16 * 1024 * 1024
