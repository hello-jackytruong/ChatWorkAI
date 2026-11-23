import { parseZaloAccountSourceId } from "@chatbotx.io/business/zalo-account/message-projection"
export function zaloMessageLabel(message: {
  sourceId?: string | null
  contentAttributes?: unknown
}) {
  if (!parseZaloAccountSourceId(message.sourceId)) {
    return null
  }
  const attrs = message.contentAttributes as {
    zaloAccount?: {
      lifecycle?: { recalled?: boolean; localHiddenAt?: string | null }
    }
  } | null
  const lifecycle = attrs?.zaloAccount?.lifecycle
  if (lifecycle?.recalled) {
    return "recalled"
  }
  if (lifecycle?.localHiddenAt) {
    return "hiddenLocally"
  }
  return null
}

export function zaloMessageDeletedForMe(message: {
  sourceId?: string | null
  contentAttributes?: unknown
}) {
  if (!parseZaloAccountSourceId(message.sourceId)) {
    return false
  }
  const attrs = message.contentAttributes as {
    zaloAccount?: { lifecycle?: { providerDeletedForMeAt?: string | null } }
  } | null
  return Boolean(attrs?.zaloAccount?.lifecycle?.providerDeletedForMeAt)
}

export function zaloRetainedQuoteLabel(message: {
  sourceId?: string | null
  contentAttributes?: unknown
}) {
  if (!parseZaloAccountSourceId(message.sourceId)) {
    return null
  }
  const attrs = message.contentAttributes as {
    zaloAccount?: { retainedQuote?: { sourceId?: string; lifecycle?: unknown } }
  } | null
  const quote = attrs?.zaloAccount?.retainedQuote
  return quote?.sourceId
    ? zaloMessageLabel({
        sourceId: quote.sourceId,
        contentAttributes: { zaloAccount: { lifecycle: quote.lifecycle } },
      })
    : null
}
