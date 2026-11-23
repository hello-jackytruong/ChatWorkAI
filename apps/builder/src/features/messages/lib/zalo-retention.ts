import {
  parseZaloAccountSourceId,
  projectZaloAccountRetainedMessage,
} from "@chatbotx.io/business/zalo-account/message-projection"

type Row = {
  id?: string
  workspaceId?: string
  conversationId?: string
  contactInboxId?: string
  createdAt?: Date | string
  sourceId?: string | null
  contentAttributes?: unknown
}
export type ZaloRetentionEvent = {
  sourceId: string
  lifecycle: Record<string, unknown>
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const lifecycleOf = (row: Row) =>
  object(object(object(row.contentAttributes).zaloAccount).lifecycle)
const hasLifecycle = (lifecycle: Record<string, unknown>) =>
  lifecycle.version === 1 || lifecycle.legacyDeleted === true
const hidden = (lifecycle: Record<string, unknown>) =>
  !!(lifecycle.recalled || lifecycle.localHiddenAt || lifecycle.legacyDeleted)
const mergeLifecycle = (
  current: Record<string, unknown>,
  next: Record<string, unknown>,
) => {
  const latest =
    Number(current.lifecycleRevision ?? 0) > Number(next.lifecycleRevision ?? 0)
      ? current
      : next
  return {
    ...latest,
    recalled: !!(current.recalled || next.recalled),
    localHiddenAt: current.localHiddenAt ?? next.localHiddenAt ?? null,
    providerDeletedForMeAt:
      current.providerDeletedForMeAt ?? next.providerDeletedForMeAt ?? null,
    originalObserved: !!(current.originalObserved || next.originalObserved),
    ...(current.legacyDeleted || next.legacyDeleted
      ? { legacyDeleted: true }
      : {}),
  }
}
const identity = (row: Row) =>
  JSON.stringify([
    row.workspaceId,
    row.conversationId,
    row.contactInboxId,
    row.id,
    row.createdAt ? new Date(row.createdAt).toISOString() : null,
  ])
const sourceKey = (row: Row, sourceId: string) =>
  JSON.stringify([row.workspaceId, row.conversationId, sourceId])
const quoteSource = (row: Row): string | null => {
  const ref = parseZaloAccountSourceId(row.sourceId)
  if (!ref) {
    return null
  }
  const attrs = object(row.contentAttributes)
  const za = object(attrs.zaloAccount)
  const quote = object(
    za.quote ?? object(za.group).quote ?? attrs.zaloAccountQuote ?? attrs.quote,
  )
  if (parseZaloAccountSourceId(quote.sourceId)) {
    return quote.sourceId as string
  }
  const providerMessageId = quote.providerMessageId
  return typeof providerMessageId === "string" && providerMessageId
    ? `za:${encodeURIComponent(ref.accountId)}:${ref.threadType}:${encodeURIComponent(ref.threadId)}:${encodeURIComponent(providerMessageId)}`
    : null
}

/** Fences contain metadata from loaded rows only; retained originals never enter this cache. */
export function retainZaloMessages<T extends Row>(
  rows: readonly T[],
  previousRows: readonly Row[] = [],
  event?: ZaloRetentionEvent,
): T[] {
  const previous = new Map(previousRows.map((row) => [identity(row), row]))
  const fences = new Map<string, Record<string, unknown>>()
  for (const row of [...previousRows, ...rows]) {
    if (!parseZaloAccountSourceId(row.sourceId)) {
      continue
    }
    const lifecycle = lifecycleOf(row)
    if (hasLifecycle(lifecycle)) {
      const key = sourceKey(row, row.sourceId as string)
      fences.set(key, mergeLifecycle(fences.get(key) ?? {}, lifecycle))
    }
    const retainedQuote = object(
      object(object(row.contentAttributes).zaloAccount).retainedQuote,
    )
    if (
      typeof retainedQuote.sourceId === "string" &&
      hasLifecycle(object(retainedQuote.lifecycle))
    ) {
      fences.set(
        sourceKey(row, retainedQuote.sourceId),
        object(retainedQuote.lifecycle),
      )
    }
  }
  let changed = false
  const result = rows.map((row) => {
    if (!parseZaloAccountSourceId(row.sourceId)) {
      return row
    }
    let next: T = row
    const current = previous.get(identity(row))
    const lifecycle = mergeLifecycle(
      lifecycleOf(current ?? {}),
      lifecycleOf(row),
    )
    const fence = fences.get(sourceKey(row, row.sourceId as string))
    const ownEvent =
      event && event.sourceId === row.sourceId ? event.lifecycle : undefined
    const merged = mergeLifecycle(lifecycle, ownEvent ?? fence ?? {})
    if (hasLifecycle(merged)) {
      const attrs = object(row.contentAttributes)
      const za = object(attrs.zaloAccount)
      next = {
        ...row,
        contentAttributes: {
          ...attrs,
          zaloAccount: { ...za, lifecycle: merged },
        },
      }
      next = projectZaloAccountRetainedMessage(next)
    }
    const currentQuote = object(
      object(object(current?.contentAttributes).zaloAccount).retainedQuote,
    )
    const target =
      quoteSource(row) ??
      (typeof currentQuote.sourceId === "string" ? currentQuote.sourceId : null)
    let quoteFence: Record<string, unknown> | null = null
    if (target) {
      quoteFence =
        event?.sourceId === target
          ? event.lifecycle
          : (fences.get(sourceKey(row, target)) ??
            object(currentQuote.lifecycle))
    }
    if (target && quoteFence && hidden(quoteFence)) {
      const attrs = object(next.contentAttributes)
      const za = object(attrs.zaloAccount)
      const { quote: _quote, zaloAccountQuote: _zaQuote, ...safeAttrs } = attrs
      const { quote: _providerQuote, group, ...safeZa } = za
      const { quote: _groupQuote, ...safeGroup } = object(group)
      next = {
        ...next,
        contentAttributes: {
          ...safeAttrs,
          zaloAccount: {
            ...safeZa,
            ...(group ? { group: safeGroup } : {}),
            retainedQuote: { sourceId: target, lifecycle: quoteFence },
          },
        },
      }
    }
    if (next !== row) {
      changed = true
    }
    return next
  })
  return changed ? result : (rows as T[])
}
