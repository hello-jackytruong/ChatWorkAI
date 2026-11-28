import { hasWorkspacePermission } from "@chatbotx.io/business/workspace-member/permissions"
import { zaloAccountProfileService } from "@chatbotx.io/business/zalo-account"
import { zaloAccountProfileFieldSchema } from "@chatbotx.io/sdk"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { possibleErrorsOnFindingResource } from "@/lib/orpc/orpc-error-helper"
import { assertConversationAccessForCaller } from "@/lib/public-api/member-scope"
import { workspaceTokenAuthAPIForScope } from "@/orpc"
import { zaloMessageScope } from "../schema/message-operations"

export const zaloAccountProfileOperations = {
  getContactProfile: workspaceTokenAuthAPIForScope("inbox")
    .route({
      method: "GET",
      path: "/v1/zalo-accounts/{accountId}/conversations/{conversationId}/contact-profile",
      summary: "Get Zalo contact profile",
      description:
        "Read the provider profile linked to this conversation, or a verified sender in a group. An optional refresh reads the provider without changing CRM contact fields. A public phone number does not imply verification.",
      tags: ["Zalo Accounts"],
    })
    .input(
      zaloMessageScope.extend({
        contactInboxId: zodBigintAsString().describe(
          "Selected ContactInbox ID from conversations.get",
        ),
        memberUid: z
          .string()
          .regex(/^\d{1,100}$/)
          .optional()
          .describe("Optional verified sender UID from the group timeline"),
        refresh: z
          .boolean()
          .optional()
          .describe("Refresh the provider profile within its rate limits"),
        largeAvatar: z
          .boolean()
          .optional()
          .describe("Request a larger avatar when refreshing one profile"),
      }),
    )
    .output(
      z.object({
        profile: z
          .object({
            uid: z.string(),
            fields: z.partialRecord(
              zaloAccountProfileFieldSchema,
              z.union([z.string(), z.number(), z.boolean()]),
            ),
          })
          .nullable(),
        staleness: z.enum(["fresh", "stale", "unavailable"]),
        observedAt: z.number().optional(),
      }),
    )
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => {
      await assertConversationAccessForCaller(context, input.conversationId)
      const result = await zaloAccountProfileService.get({
        ...input,
        workspaceId: context.workspace.id,
      })
      const mayViewPhone = context.member
        ? hasWorkspacePermission(context.member.permissions, "emailAndPhone")
        : !(
            context.apiToken?.scopes &&
            !context.apiToken.scopes.includes("contacts")
          )
      if (mayViewPhone || !result.profile) {
        return result
      }
      const { publicPhone: _publicPhone, ...fields } = result.profile.fields
      return { ...result, profile: { ...result.profile, fields } }
    }),
}
