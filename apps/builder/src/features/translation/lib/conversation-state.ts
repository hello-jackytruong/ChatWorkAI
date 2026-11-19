import {
  conversationService,
  inboxTranslationSettingsService,
  normalizeLanguageCode,
  queueWorkspaceRealtimeEvent,
} from "@chatbotx.io/business"
import { validationException } from "@chatbotx.io/business/errors"
import type { ConversationModel } from "@chatbotx.io/database/types"
import {
  RealtimeEventType,
  routeForConversation,
} from "@chatbotx.io/realtime-protocol"
import type { UpdateConversationTranslationStateRequest } from "../schema/action"
import type { ConversationTranslationStateResource } from "../schema/resource"
import { toConversationStateResource } from "./availability"

export async function getConversationTranslationState(props: {
  workspaceId: string
  conversation: Pick<ConversationModel, "additionalAttributes">
}): Promise<ConversationTranslationStateResource> {
  const settings = await inboxTranslationSettingsService.get(props.workspaceId)
  return toConversationStateResource(settings, props.conversation)
}

/**
 * Changes a conversation's translation state: the per-conversation off switch
 * and/or the customer language an agent sets by hand. `true` clears the
 * override, since an override can only turn translation off. A changed language
 * is broadcast so other open inboxes update their chip and badge.
 */
export async function updateConversationTranslationState(props: {
  workspaceId: string
  conversation: ConversationModel
  request: UpdateConversationTranslationStateRequest
}): Promise<ConversationTranslationStateResource> {
  const { workspaceId, request } = props
  let conversation = props.conversation
  if (request.enabledOverride === undefined && request.language === undefined) {
    throw validationException(
      "enabledOverride",
      "Pass `enabledOverride` or `language`",
    )
  }

  if (request.enabledOverride !== undefined) {
    const updated = await conversationService.setTranslationOverride({
      workspaceId,
      conversationId: conversation.id,
      enabledOverride: request.enabledOverride === false ? false : null,
    })
    conversation = updated ?? conversation
  }
  if (request.language !== undefined) {
    // Stored in the canonical form (`es`, `zh-Hans`) that detection also writes.
    const language = normalizeLanguageCode(request.language)
    if (!language) {
      throw validationException("language", "Unknown language code")
    }
    const updated = await conversationService.setTranslationLanguage({
      workspaceId,
      conversationId: conversation.id,
      language,
    })
    conversation = updated ?? conversation
    await queueWorkspaceRealtimeEvent(workspaceId, {
      eventType: RealtimeEventType.messageTranslationUpdated,
      data: {
        conversationId: conversation.id,
        conversationLanguage:
          conversation.additionalAttributes?.translation?.language,
        items: [],
      },
      route: routeForConversation(conversation),
    })
  }

  return await getConversationTranslationState({ workspaceId, conversation })
}
