import {
  isSameLanguage,
  isWithinChannelLimit,
  messageService,
  queueWorkspaceRealtimeEvent,
  translationService,
} from "@chatbotx.io/business"
import { validationException } from "@chatbotx.io/business/errors"
import type {
  ContactInboxModel,
  ConversationModel,
  UserModel,
} from "@chatbotx.io/database/types"
import { getChildLogger } from "@chatbotx.io/logger"
import {
  RealtimeEventType,
  routeForConversation,
} from "@chatbotx.io/realtime-protocol"
import type { TranslationApiErrorCode } from "../schema/errors"
import type { MessageTranslationResource } from "../schema/resource"
import {
  conversationTranslation,
  isTranslationEffectiveFor,
  loadTranslationContext,
} from "./availability"
import {
  OUTBOUND_TRANSLATION_TIMEOUT_MS,
  translateText,
} from "./translate-text"

const logger = getChildLogger("translation")

type CreateOutgoingArgs = Parameters<typeof messageService.createOutgoing>[0]
type OutgoingInput = CreateOutgoingArgs["input"]

/** The agent's hand-edited translation from the composer preview. */
export type EditedTranslation = { text: string; targetLanguage: string }

export type TranslatedOutgoingResult = {
  message: Awaited<ReturnType<typeof messageService.createOutgoing>>
  /** The row stored for this message; `null` when it went out as written. */
  translation: MessageTranslationResource
  /** Why the original sentence was sent instead of a translation. */
  translationFallback: { reason: TranslationApiErrorCode } | null
  /** The hand-edited translation targeted a language the conversation no longer has. */
  editedTranslationDiscarded: boolean
}

/** Fields that make a message more than plain text; translation does not apply to them. */
const NON_TEXT_FIELDS = [
  "files",
  "mediaFile",
  "mediaFileId",
  "mediaFileIds",
  "products",
  "flowId",
  "replyToMessageId",
  "isPrivateReply",
] as const

const plainTextOf = (input: OutgoingInput): string => {
  const hasOtherContent = NON_TEXT_FIELDS.some(
    (field) => field in input && input[field as keyof typeof input] != null,
  )
  const text = "text" in input ? input.text : undefined
  if (hasOtherContent || typeof text !== "string" || text.length === 0) {
    throw validationException(
      "translate",
      "`translate` only applies to a plain text message: no files, media, products, flow, reply or private reply",
    )
  }
  return text
}

/**
 * Sends an agent's text message translated into the customer's language, or as
 * written when that is not possible. It never blocks the send on translation:
 * a model that is slow (3 s), down, rate limited or returns something unsafe
 * means the original sentence goes out and the response says why.
 *
 * The message is created exactly once, with the translation as its `text` and
 * the agent's sentence as `automationText` (keyword rules keep matching what the
 * agent wrote). The agent's sentence is stored only after the send succeeded, in
 * a `MessageTranslation` row, so a failed create leaves nothing behind; the
 * channel never sees it.
 */
export async function createOutgoingWithTranslation(props: {
  workspaceId: string
  conversation: ConversationModel
  contactInbox: ContactInboxModel
  input: OutgoingInput
  editedTranslation?: EditedTranslation
  user?: Pick<UserModel, "id">
  sendFrom: CreateOutgoingArgs["sendFrom"]
}): Promise<TranslatedOutgoingResult> {
  const { workspaceId, conversation, contactInbox, input } = props
  const original = plainTextOf(input)
  const startedAt = Date.now()

  const sendAsWritten = async (
    reason: TranslationApiErrorCode | null,
    editedTranslationDiscarded = false,
  ): Promise<TranslatedOutgoingResult> => ({
    message: await messageService.createOutgoing({
      conversation,
      contactInbox,
      input,
      ...(props.user && { user: props.user }),
      sendFrom: props.sendFrom,
    }),
    translation: null,
    translationFallback: reason ? { reason } : null,
    editedTranslationDiscarded,
  })

  const { settings, workspaceLanguage } =
    await loadTranslationContext(workspaceId)
  if (!isTranslationEffectiveFor(settings, conversation)) {
    return await sendAsWritten("disabled")
  }
  const targetLanguage = conversationTranslation(conversation)?.language
  if (!targetLanguage) {
    return await sendAsWritten("unknownLanguage")
  }
  if (isSameLanguage(targetLanguage, workspaceLanguage)) {
    // Nothing to translate: the customer reads the workspace language.
    return await sendAsWritten(null)
  }

  const { editedTranslation } = props
  const useEdited =
    editedTranslation !== undefined &&
    isSameLanguage(editedTranslation.targetLanguage, targetLanguage)
  const editedTranslationDiscarded =
    editedTranslation !== undefined && !useEdited

  let translated: string
  let modelId: string | null = null
  if (useEdited) {
    // The agent reviewed and edited this text in the preview: send it as is.
    translated = editedTranslation.text
    if (!isWithinChannelLimit(contactInbox.channel, translated)) {
      return await sendAsWritten("tooLong", editedTranslationDiscarded)
    }
  } else {
    const translateStartedAt = Date.now()
    const result = await translateText({
      workspaceId,
      modelConfig: settings?.modelConfig ?? null,
      text: original,
      targetLanguage,
      channel: contactInbox.channel,
      timeoutMs: OUTBOUND_TRANSLATION_TIMEOUT_MS,
    })
    // Where the wait of an outgoing message goes: lookups before the call, the
    // provider call itself, and everything after it (never message text).
    logger.info(
      {
        workspaceId,
        conversationId: conversation.id,
        action: "outboundTiming",
        ok: result.ok,
        reason: result.ok ? null : result.code,
        beforeTranslateMs: translateStartedAt - startedAt,
        translateMs: Date.now() - translateStartedAt,
      },
      "[translation] outgoing message translation timing",
    )
    if (!result.ok) {
      return await sendAsWritten(result.code, editedTranslationDiscarded)
    }
    translated = result.text
    modelId = result.modelId
  }

  const message = await messageService.createOutgoing({
    conversation,
    contactInbox,
    input: { ...input, text: translated, automationText: original },
    ...(props.user && { user: props.user }),
    sendFrom: props.sendFrom,
  })

  const row = await recordAgentSentence({
    workspaceId,
    conversation,
    message,
    agentText: original,
    sourceLanguage: workspaceLanguage,
    targetLanguage,
    modelId,
  })

  return {
    message,
    translation: row
      ? {
          direction: row.direction,
          status: row.status,
          displayText: row.displayText,
          sourceLanguage: row.sourceLanguage,
          targetLanguage: row.targetLanguage,
          failureCode: row.failureCode,
        }
      : null,
    translationFallback: null,
    editedTranslationDiscarded,
  }
}

/**
 * Stores what the agent typed and tells other inbox tabs. The message is
 * already sent, so a failure here is logged and never turned into a failed
 * send: the worst case is a bubble that shows the translation without the
 * agent's original sentence.
 */
async function recordAgentSentence(props: {
  workspaceId: string
  conversation: ConversationModel
  message: { id: string; createdAt: Date } | null
  agentText: string
  sourceLanguage: string
  targetLanguage: string
  modelId: string | null
}) {
  const { workspaceId, conversation, message } = props
  if (!message) {
    return null
  }
  try {
    const row = await translationService.recordOutbound({
      workspaceId,
      conversationId: conversation.id,
      message: { id: message.id, createdAt: message.createdAt },
      agentText: props.agentText,
      sourceLanguage: props.sourceLanguage,
      targetLanguage: props.targetLanguage,
      modelId: props.modelId,
    })
    if (row) {
      await queueWorkspaceRealtimeEvent(workspaceId, {
        eventType: RealtimeEventType.messageTranslationUpdated,
        data: {
          conversationId: conversation.id,
          items: [
            {
              messageId: row.messageId,
              status: row.status,
              displayText: row.displayText,
              sourceLanguage: row.sourceLanguage,
              targetLanguage: row.targetLanguage,
            },
          ],
        },
        route: routeForConversation(conversation),
      })
    }
    return row
  } catch (err) {
    logger.warn(
      {
        err,
        workspaceId,
        conversationId: conversation.id,
        messageId: message.id,
        action: "recordAgentSentence",
      },
      "[translation] could not store the agent's original sentence",
    )
    return null
  }
}
