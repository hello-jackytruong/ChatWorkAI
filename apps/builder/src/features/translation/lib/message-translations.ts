import {
  inboxTranslationSettingsService,
  translationService,
} from "@chatbotx.io/business"
import type { MessageTranslationModel } from "@chatbotx.io/database/types"
import type { MessageTranslationResource } from "../schema/resource"

export const toMessageTranslationResource = (
  row: MessageTranslationModel,
): NonNullable<MessageTranslationResource> => ({
  direction: row.direction,
  status: row.status,
  displayText: row.displayText,
  sourceLanguage: row.sourceLanguage,
  targetLanguage: row.targetLanguage,
  failureCode: row.failureCode,
})

/**
 * Adds a `translation` field (`null` when the message has none) to messages a
 * member or an API caller reads.
 *
 * Only for those readers: an outgoing message's `displayText` is the agent's
 * own sentence, so the guest webchat history must never call this. A workspace
 * that never switched translation on costs no query at all (the settings read
 * is cached), because `listMessages` runs on every conversation open.
 */
export async function withMessageTranslations<TMessage extends { id: string }>(
  workspaceId: string,
  messages: TMessage[],
): Promise<(TMessage & { translation: MessageTranslationResource })[]> {
  if (
    messages.length === 0 ||
    !(await inboxTranslationSettingsService.hasEverBeenEnabled(workspaceId))
  ) {
    return messages.map((message) => ({ ...message, translation: null }))
  }
  const rows = await translationService.findTranslations(
    workspaceId,
    messages.map((message) => message.id),
  )
  const byMessageId = new Map(rows.map((row) => [row.messageId, row]))
  return messages.map((message) => {
    const row = byMessageId.get(message.id)
    return {
      ...message,
      translation: row ? toMessageTranslationResource(row) : null,
    }
  })
}
