"use client"

import { getZaloAccountMessageEvidence } from "@chatbotx.io/sdk"
import { useTranslations } from "next-intl"
import { zaloSendAttemptResource } from "@/features/zalo-accounts/schema/send-attempt"

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
const stateSchema = zaloSendAttemptResource.pick({
  status: true,
  reconciliation: true,
  errorInfo: true,
})
export function getZaloMessageEvidence(attributes: unknown) {
  const account = record(record(attributes)?.zaloAccount)
  if (!account) {
    return null
  }
  const unsupported =
    getZaloAccountMessageEvidence(attributes)?.unsupported ?? null
  const attempt = stateSchema.safeParse(account.sendAttempt)
  return { unsupported, attempt: attempt.success ? attempt.data : null }
}
export function canResendZaloMessage(attributes: unknown): boolean {
  const evidence = getZaloMessageEvidence(attributes)
  if (!evidence) {
    return true
  }
  const attempt = evidence.attempt
  return (
    attempt?.status === "failed" &&
    attempt.errorInfo?.safeAction === "new_attempt" &&
    attempt.reconciliation?.state !== "needs_review" &&
    ["validation", "preparation", "admission"].includes(attempt.errorInfo.phase)
  )
}

export type ZaloMessageInspect = { accountId: string; canInspect: boolean }
export function ZaloMessageEvidence({
  attributes,
  message,
}: {
  attributes: unknown
  message?: {
    id: string
    workspaceId: string
    createdAt: Date
    sendError?: string | null
  }
}) {
  const t = useTranslations("zaloAccount.evidence")
  const evidence = getZaloMessageEvidence(attributes)
  const attempt = evidence?.attempt
  if (!(evidence || attempt)) {
    return null
  }
  const unsupportedKeys = {
    unsupported_content: "unsupportedContent",
    invalid_content: "invalidContent",
    unsupported_schema: "unsupportedSchema",
  } as const
  const statusKeys = {
    pending: "pending",
    unknown: "unknown",
    failed: "failed",
    applied: "applied",
  } as const
  const state = attempt?.reconciliation?.state
  let label:
    | "needsReview"
    | "appliedPending"
    | (typeof statusKeys)[keyof typeof statusKeys]
    | null = attempt ? statusKeys[attempt.status] : null
  if (!attempt && message?.sendError) {
    label = "unknown"
  }
  if (state === "needs_review") {
    label = "needsReview"
  } else if (attempt?.status === "applied" && state === "pending") {
    label = "appliedPending"
  }
  return (
    <div className="flex flex-col gap-1 text-muted-foreground text-xs">
      {evidence?.unsupported && (
        <span>{t(unsupportedKeys[evidence.unsupported.reason])}</span>
      )}
      {label && <span role="status">{t(label)}</span>}
      {attempt?.errorInfo && <span>{t("safeFailure")}</span>}
    </div>
  )
}
