import { notFoundException } from "@chatbotx.io/business/errors"
import { hasWorkspacePermission } from "@chatbotx.io/business/workspace-member/permissions"
import { zaloAccountGroupReadService } from "@chatbotx.io/business/zalo-account"
import { zaloAccountGroupRosterSchema } from "@chatbotx.io/sdk"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { possibleErrorsOnFindingResource } from "@/lib/orpc/orpc-error-helper"
import type { MemberScopeContext } from "@/lib/public-api/member-scope"
import { workspaceTokenAuthAPIForScope } from "@/orpc"
import {
  groupAdministrationInput,
  groupAdministrationMembersInput,
  groupAdministrationOutput,
  groupAdministrationRelatedInput,
  groupAdministrationRelatedOutput,
} from "../schema/group-administration"

const accountId = zodBigintAsString().describe(
  "Account ID from zaloAccounts.list",
)
const path = "/v1/zalo-accounts/{accountId}/groups/{groupId}/administration"
const api = workspaceTokenAuthAPIForScope("channels")

function workspaceForGroupAdministration(context: MemberScopeContext) {
  if (
    context.member &&
    !hasWorkspacePermission(context.member.permissions, "superAdmin")
  ) {
    throw notFoundException("Zalo group administration is unavailable")
  }
  return context.workspace.id
}

export const zaloAccountGroupAdministrationOperations = {
  getGroupAdministration: api
    .route({
      method: "GET",
      path,
      summary: "Get personal Zalo group administration details",
      description:
        "Read the current account role and known provider settings for a synchronized group. Requires the channels scope or workspace administration permission.",
      tags: ["Zalo Accounts"],
    })
    .input(groupAdministrationInput.extend({ accountId }))
    .output(groupAdministrationOutput)
    .errors(possibleErrorsOnFindingResource)
    .handler(
      async ({ context, input }) =>
        await zaloAccountGroupReadService.overview({
          ...input,
          workspaceId: workspaceForGroupAdministration(context),
        }),
    ),
  listGroupAdministrationMembers: api
    .route({
      method: "GET",
      path: `${path}/members`,
      summary: "List personal Zalo group administration members",
      description:
        "Read one bounded roster page for a synchronized group. Provider visibility rules still apply. A partial page may omit members even without a continuation cursor.",
      tags: ["Zalo Accounts"],
    })
    .input(groupAdministrationMembersInput.extend({ accountId }))
    .output(zaloAccountGroupRosterSchema)
    .errors(possibleErrorsOnFindingResource)
    .handler(
      async ({ context, input }) =>
        await zaloAccountGroupReadService.members({
          ...input,
          workspaceId: workspaceForGroupAdministration(context),
        }),
    ),
  listRelatedGroups: api
    .route({
      method: "GET",
      path: `${path}/related-groups`,
      summary: "List shared Zalo groups for verified members",
      description:
        "Read accessible synchronized groups shared with one verified friend. The provider may require a business package. Results can be partial.",
      tags: ["Zalo Accounts"],
    })
    .input(groupAdministrationRelatedInput.extend({ accountId }))
    .output(groupAdministrationRelatedOutput)
    .errors(possibleErrorsOnFindingResource)
    .handler(
      async ({ context, input }) =>
        await zaloAccountGroupReadService.related({
          ...input,
          workspaceId: workspaceForGroupAdministration(context),
        }),
    ),
}
