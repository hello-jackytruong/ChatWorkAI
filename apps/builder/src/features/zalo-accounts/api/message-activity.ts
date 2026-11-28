import { zaloAccountMessageActivityService } from "@chatbotx.io/business/zalo-account"
import { zaloAccountReactionChoiceSchema } from "@chatbotx.io/sdk"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { mcpSpec } from "@/lib/orpc/mcp-annotations"
import {
  possibleErrorsOnFindingResource,
  possibleErrorsOnMutatingResource,
} from "@/lib/orpc/orpc-error-helper"
import {
  assertConversationAccessForCaller,
  conversationScopeForCaller,
} from "@/lib/public-api/member-scope"
import { workspaceTokenAuthAPIForScope } from "@/orpc"
import { zaloMessageCommand } from "../schema/message-operations"

const inbox = workspaceTokenAuthAPIForScope("inbox")
const channels = workspaceTokenAuthAPIForScope("channels")
const prefix =
  "/v1/zalo-accounts/{accountId}/conversations/{conversationId}/messages/{messageId}"
const outcome = z.object({
  accepted: z
    .boolean()
    .describe(
      "The gateway accepted the SDK request. A provider event is authoritative. An uncertain result must be inspected before resending.",
    ),
})
const errors = {
  ...possibleErrorsOnFindingResource,
  ...possibleErrorsOnMutatingResource,
}

export const zaloAccountMessageActivityOperations = {
  setReaction: inbox
    .route({
      method: "POST",
      path: `${prefix}/reaction`,
      summary: "Set Zalo message reaction",
      description:
        "Use the exact Message id and createdAt from messages.list. Select an icon to add or change the reaction. Use null to remove it.",
      tags: ["Zalo Accounts"],
      spec: mcpSpec({ hitlPolicy: "confirm_outbound" }),
    })
    .input(
      zaloMessageCommand.extend({
        reaction: zaloAccountReactionChoiceSchema
          .nullable()
          .describe(
            "Reaction to set, or null to remove the connected account's reaction",
          ),
      }),
    )
    .output(outcome)
    .errors(errors)
    .handler(async ({ context, input }) => {
      await assertConversationAccessForCaller(context, input.conversationId)
      return await zaloAccountMessageActivityService.setReaction({
        ...input,
        workspaceId: context.workspace.id,
        messageCreatedAt: input.createdAt,
        scope: await conversationScopeForCaller(context),
      })
    }),
  sendSeen: inbox
    .route({
      method: "POST",
      path: `${prefix}/send-seen`,
      summary: "Send Zalo seen receipt",
      description:
        "Requires explicit outbound receipt enrollment and provider fields from the original message. CRM read state does not send this receipt.",
      tags: ["Zalo Accounts"],
      spec: mcpSpec({ hitlPolicy: "confirm_outbound" }),
    })
    .input(zaloMessageCommand)
    .output(outcome)
    .errors(errors)
    .handler(async ({ context, input }) => {
      await assertConversationAccessForCaller(context, input.conversationId)
      return await zaloAccountMessageActivityService.sendSeen({
        ...input,
        workspaceId: context.workspace.id,
        messageCreatedAt: input.createdAt,
        scope: await conversationScopeForCaller(context),
      })
    }),
  sendDelivered: inbox
    .route({
      method: "POST",
      path: `${prefix}/send-delivered`,
      summary: "Send Zalo delivery receipt",
      description:
        "Requires explicit outbound receipt enrollment and provider fields from the original message. This sends only delivery.",
      tags: ["Zalo Accounts"],
      spec: mcpSpec({ hitlPolicy: "confirm_outbound" }),
    })
    .input(zaloMessageCommand)
    .output(outcome)
    .errors(errors)
    .handler(async ({ context, input }) => {
      await assertConversationAccessForCaller(context, input.conversationId)
      return await zaloAccountMessageActivityService.sendDelivered({
        ...input,
        workspaceId: context.workspace.id,
        messageCreatedAt: input.createdAt,
        scope: await conversationScopeForCaller(context),
      })
    }),
  requestReactionHistory: channels
    .route({
      method: "POST",
      path: "/v1/zalo-accounts/{accountId}/reaction-history",
      summary: "Request one page of retained Zalo reaction evidence",
      description:
        "Select the direct or group stream for one account. The provider response arrives asynchronously, at most one request per stream per day.",
      tags: ["Zalo Accounts"],
      spec: mcpSpec({ hitlPolicy: "confirm_outbound" }),
    })
    .input(
      z.object({
        accountId: zodBigintAsString().describe(
          "Account ID from zaloAccounts.list",
        ),
        commandId: z
          .string()
          .min(1)
          .max(200)
          .describe("Stable caller request ID"),
        threadType: z
          .enum(["user", "group"])
          .describe("Provider stream scope for this account"),
      }),
    )
    .output(outcome)
    .errors(errors)
    .handler(
      async ({ context, input }) =>
        await zaloAccountMessageActivityService.requestReactionHistory({
          ...input,
          workspaceId: context.workspace.id,
        }),
    ),
}
