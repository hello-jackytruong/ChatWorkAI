"use server"
import { conversationService } from "@chatbotx.io/business"
import { validationException } from "@chatbotx.io/business/errors"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { TranslationNotSentException } from "@/features/translation/lib/errors"
import { sendOutgoing } from "@/features/translation/lib/send-outgoing"
import { assertConversationAccessForCaller } from "@/lib/public-api/member-scope"
import { workspaceActionClient } from "@/lib/safe-action"
import { createMessageWithRoutingBypassRequest } from "../schema/mutation"
export const createMessageAction = workspaceActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .inputSchema(createMessageWithRoutingBypassRequest)
  .action(async (props) => {
    const {
      bindArgsParsedInputs: [workspaceId, conversationId],
      parsedInput,
      ctx,
    } = props

    // A translated send spends a model call, so it is member-scoped like every
    // other translation action: an agent limited to assigned conversations
    // gets a 404 elsewhere. A plain send keeps its behavior.
    const richZaloSend =
      parsedInput.zaloAccountContent ||
      parsedInput.zaloAccountUpload ||
      parsedInput.zaloAccountForward
    const memberScope = {
      workspace: ctx.workspace,
      member: ctx.workspaceMember,
      user: ctx.user,
    }
    const conversation =
      parsedInput.translate === true || richZaloSend
        ? await assertConversationAccessForCaller(memberScope, conversationId)
        : await conversationService.findByOrFail({
            where: {
              id: conversationId,
              workspaceId,
            },
          })

    const contactInbox =
      await conversationService.resolveContactInboxForConversation({
        conversation,
        workspaceId,
        inboxId: parsedInput.inboxId,
      })

    if (richZaloSend && contactInbox.channel !== "zaloAccount") {
      throw validationException(
        "zaloAccountContent",
        "Rich Zalo Account content requires a Zalo Account inbox.",
      )
    }
    if (parsedInput.zaloAccountForward) {
      await assertConversationAccessForCaller(
        memberScope,
        parsedInput.zaloAccountForward.conversationId,
      )
    }

    try {
      return await sendOutgoing({
        workspaceId,
        conversation,
        contactInbox,
        input: parsedInput,
        user: ctx.user,
        sendFrom: "inbox",
      })
    } catch (error) {
      // Not a failed request: the composer marks the message "Translation
      // failed" (and, when translation was turned off, says so) instead of
      // showing a generic error.
      if (error instanceof TranslationNotSentException) {
        return {
          translationNotSent: {
            reason: error.reason,
            conversationTranslation: error.conversationTranslation,
          },
        }
      }
      throw error
    }
  })
