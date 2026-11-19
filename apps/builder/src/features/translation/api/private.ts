import { conversationService } from "@chatbotx.io/business"
import { notFoundException } from "@chatbotx.io/business/errors"
import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"
import { possibleErrorsOnFindingResource } from "@/lib/orpc/orpc-error-helper"
import { workspaceAuthorizedMidddleware } from "@/middlewares/auth"
import { authorizedAPI } from "@/orpc"
import { toSettingsResource } from "../lib/availability"
import { getConversationTranslationState } from "../lib/conversation-state"
import {
  conversationTranslationStateResource,
  translationSettingsResource,
} from "../schema/resource"

/**
 * Session reads the Inbox UI polls through TanStack Query. Mutations go through
 * server actions, which call the same `lib/` functions as the public API.
 * Settings are readable by every member: each agent's Inbox needs the state and
 * the read-only settings card needs the configuration.
 */
const workspaceIdRequest = z.object({ workspaceId: zodBigintAsString() })

export const translationAuthenticatedAPI = {
  getSettings: authorizedAPI
    .route({
      method: "GET",
      path: "/workspaces/{workspaceId}/translation/settings",
      summary: "Get Inbox translation settings",
      tags: ["Translation"],
    })
    .input(workspaceIdRequest)
    .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
    .output(translationSettingsResource)
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ input }) => await toSettingsResource(input.workspaceId)),

  getConversationState: authorizedAPI
    .route({
      method: "GET",
      path: "/workspaces/{workspaceId}/conversations/{conversationId}/translation",
      summary: "Get a conversation's translation state",
      tags: ["Translation"],
    })
    .input(
      workspaceIdRequest.and(z.object({ conversationId: zodBigintAsString() })),
    )
    .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
    .output(conversationTranslationStateResource)
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ input }) => {
      const conversation = await conversationService.findBy({
        where: { id: input.conversationId, workspaceId: input.workspaceId },
      })
      if (!conversation) {
        throw notFoundException("Conversation not found")
      }
      return await getConversationTranslationState({
        workspaceId: input.workspaceId,
        conversation,
      })
    }),
}
