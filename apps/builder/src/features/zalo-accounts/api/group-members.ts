import { zaloAccountGroupService } from "@chatbotx.io/business/zalo-account"
import { zaloAccountGroupMembersResultSchema } from "@chatbotx.io/sdk"
import { possibleErrorsOnFindingResource } from "@/lib/orpc/orpc-error-helper"
import { assertConversationAccessForCaller } from "@/lib/public-api/member-scope"
import { workspaceTokenAuthAPIForScope } from "@/orpc"
import { zaloAccountGroupMembersInput } from "../schema/group-members"

export const zaloAccountGroupMemberOperations = {
  listGroupMembers: workspaceTokenAuthAPIForScope("inbox")
    .route({
      method: "GET",
      path: "/v1/zalo-accounts/{accountId}/groups/{groupId}/members",
      summary: "List mentionable Zalo group members",
      description:
        "Returns provider UIDs and available display names from the selected group's authorized Inbox. The provider can give an incomplete group member result. Use the returned UIDs when composing group mentions.",
      tags: ["Zalo Accounts"],
    })
    .input(zaloAccountGroupMembersInput)
    .output(zaloAccountGroupMembersResultSchema)
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => {
      await assertConversationAccessForCaller(context, input.conversationId)
      return await zaloAccountGroupService.listMembers({
        ...input,
        workspaceId: context.workspace.id,
      })
    }),
}
