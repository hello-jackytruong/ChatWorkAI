import { zaloAccountGroupService } from "@chatbotx.io/business/zalo-account"
import baseLogger from "@chatbotx.io/logger"
import type { ActionExecutionContext, ActionExecutionOutcome } from "../types"
import { resolveTriggerActionHandler } from "./actions/registry"
import { createTriggerActionScope } from "./actions/scope"
import { skipped, type TriggerActionScope } from "./actions/types"

export class ActionExecutor {
  /**
   * `scope` memoizes the conversation and contact inbox across the actions of
   * one run; callers that run several actions for one contact create it once.
   */
  async execute(
    context: ActionExecutionContext,
    scope: TriggerActionScope = createTriggerActionScope(context),
  ): Promise<ActionExecutionOutcome> {
    const conversation = await scope.getConversation()
    if (!conversation) {
      baseLogger.warn(`No conversation found for contact ${context.contactId}`)
      return skipped("noConversation")
    }
    // Group anchors carry a reserved conversation source. Ordinary
    // field/tag actions keep their lazy contact-inbox lookup.
    if (
      conversation.sourceId?.startsWith("za:group:") ||
      context.groupAudience
    ) {
      const inbox = await scope.getContactInbox()
      const audience = context.groupAudience
      if (
        !audience ||
        audience.workspaceId !== context.workspaceId ||
        audience.contactInboxId !== inbox?.id ||
        (context.conversationId &&
          audience.conversationId !== context.conversationId) ||
        !(await zaloAccountGroupService.validateAudience(audience))
      ) {
        return skipped("inactiveGroupAudience")
      }
      if (
        ![
          "addTag",
          "removeTag",
          "startAnotherFlow",
          "startExternalStep",
        ].includes(String(context.action.type))
      ) {
        return skipped("unsupportedGroupAction")
      }
    }
    if (
      context.groupAudience &&
      conversation.id !== context.groupAudience.conversationId
    ) {
      return skipped("groupConversationMismatch")
    }

    const handler = resolveTriggerActionHandler(context.action.type)
    if (!handler) {
      baseLogger.warn(`Unknown action type: ${String(context.action.type)}`)
      return skipped("unknownAction")
    }

    return await handler({ context, conversation, scope })
  }
}
