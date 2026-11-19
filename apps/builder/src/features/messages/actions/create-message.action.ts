"use server"
import { conversationService } from "@chatbotx.io/business"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { sendOutgoing } from "@/features/translation/lib/send-outgoing"
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

    const conversation = await conversationService.findByOrFail({
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

    return sendOutgoing({
      workspaceId,
      conversation,
      contactInbox,
      input: parsedInput,
      user: ctx.user,
      sendFrom: "inbox",
    })
  })
