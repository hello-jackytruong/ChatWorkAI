export type RecallProjection = {
  id: string
  lifecycleRevision: number
  recallReceivedAt?: Date | string | null
  localHiddenAt?: Date | string | null
  providerDeletedForMeAt?: Date | string | null
  originalObservedAt?: Date | string | null
}
export type ZaloAccountLifecycle = {
  version: 1
  recallId: string
  lifecycleRevision: number
  recalled: boolean
  placeholder: boolean
  originalObserved: boolean
  localHiddenAt: string | null
  providerDeletedForMeAt: string | null
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const iso = (value: Date | string | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null
export const lifecycleOfRecall = (
  recall: RecallProjection,
): ZaloAccountLifecycle => ({
  version: 1,
  recallId: recall.id,
  lifecycleRevision: recall.lifecycleRevision,
  recalled: Boolean(recall.recallReceivedAt),
  placeholder: !recall.originalObservedAt,
  originalObserved: Boolean(recall.originalObservedAt),
  localHiddenAt: iso(recall.localHiddenAt),
  providerDeletedForMeAt: iso(recall.providerDeletedForMeAt),
})
export function parseZaloAccountSourceId(sourceId: unknown) {
  if (typeof sourceId !== "string") {
    return null
  }
  const parts = sourceId.split(":")
  if (
    parts.length !== 5 ||
    parts[0] !== "za" ||
    !["user", "group"].includes(parts[2] ?? "")
  ) {
    return null
  }
  try {
    const accountId = decodeURIComponent(parts[1] ?? "")
    const threadType = parts[2] as "user" | "group"
    const threadId = decodeURIComponent(parts[3] ?? "")
    const providerMessageId = decodeURIComponent(parts[4] ?? "")
    return accountId && threadId && providerMessageId
      ? { accountId, threadType, threadId, providerMessageId }
      : null
  } catch {
    return null
  }
}
/** Only the safe marker crosses the ordinary inbox boundary; retained bytes stay in storage. */
export function projectZaloAccountRetainedMessage<T>(
  message: T,
  recall?: RecallProjection | null,
): T {
  const row = object(message)
  if (!parseZaloAccountSourceId(row.sourceId)) {
    return message
  }
  const attrs = object(row.contentAttributes)
  const lifecycle = recall
    ? lifecycleOfRecall(recall)
    : object(object(attrs.zaloAccount).lifecycle)
  if (!(lifecycle.recalled || lifecycle.localHiddenAt || row.deletedAt)) {
    return message
  }
  return {
    ...row,
    text: null,
    attachments: [],
    attachmentCount: 0,
    contentAttributes: {
      zaloAccount: {
        lifecycle:
          row.deletedAt && !lifecycle.recalled && !lifecycle.localHiddenAt
            ? { ...lifecycle, legacyDeleted: true }
            : lifecycle,
      },
    },
    ...(row.translation === undefined ? {} : { translation: null }),
    ...(row.translations === undefined ? {} : { translations: [] }),
    ...(row.replyTo === undefined ? {} : { replyTo: null }),
  } as T
}
