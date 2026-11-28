import { notFoundException } from "@chatbotx.io/business/errors"
import { hasWorkspacePermission } from "@chatbotx.io/business/workspace-member/permissions"
import { zaloAccountGroupManagementService } from "@chatbotx.io/business/zalo-account/group-management"
import {
  zaloAccountGroupInviteLinkSchema,
  zaloAccountGroupManagementOperationSchema,
  zaloAccountGroupManagementResultSchema,
} from "@chatbotx.io/sdk"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { mcpSpec } from "@/lib/orpc/mcp-annotations"
import {
  possibleErrorsOnFindingResource,
  possibleIdempotencyErrors,
} from "@/lib/orpc/orpc-error-helper"
import type { MemberScopeContext } from "@/lib/public-api/member-scope"
import { workspaceTokenAuthAPIForScope } from "@/orpc"
import {
  groupManagementAttemptInput,
  groupManagementAttemptOutput,
  groupManagementMutationInput,
  groupManagementScope,
} from "../schema/group-management"

const api = workspaceTokenAuthAPIForScope("channels")
const path = "/v1/zalo-accounts/{accountId}/group-management"
const accountId = zodBigintAsString().describe(
  "Account ID from zaloAccounts.list",
)
const tags = ["Zalo Accounts"]

function workspaceForGroupManagement(context: MemberScopeContext) {
  if (
    context.member &&
    !hasWorkspacePermission(context.member.permissions, "superAdmin")
  ) {
    throw notFoundException("Zalo group management is unavailable")
  }
  return context.workspace.id
}

const readKinds = z.enum([
  "getGroupInviteBoxList",
  "getGroupInviteBoxInfo",
  "getGroupBlockedMember",
  "getPendingGroupMembers",
  "getGroupLinkDetail",
])
const readInput = groupManagementScope.extend({
  accountId,
  kind: readKinds.describe(
    "Invitation inbox, blocked members, pending requests, or current group link state",
  ),
  invitedGroupId: z
    .string()
    .regex(/^\d{1,200}$/)
    .optional()
    .describe(
      "Provider group ID from the invitation inbox, for invitation details",
    ),
  page: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .optional()
    .describe(
      "Page number, zero-based for invitations and starting at one for blocked members",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Maximum number of records to return"),
  offset: z
    .number()
    .int()
    .min(0)
    .max(5000)
    .optional()
    .describe("Offset for a pending member list"),
})

export const zaloAccountGroupManagementOperations = {
  getGroupManagementCapability: api
    .route({
      method: "GET",
      path: `${path}/capability`,
      summary: "Get Zalo group management capability",
      tags,
      description:
        "Check whether native writes are enabled for the selected Zalo account.",
    })
    .input(z.strictObject({ accountId }))
    .output(z.strictObject({ enabled: z.boolean() }))
    .errors(possibleErrorsOnFindingResource)
    .handler(
      async ({ context, input }) =>
        await zaloAccountGroupManagementService.capabilities({
          workspaceId: workspaceForGroupManagement(context),
          ...input,
        }),
    ),
  readGroupManagement: api
    .route({
      method: "GET",
      path,
      summary: "Read Zalo group management details",
      tags,
      description:
        "Read one invitation, blocked or pending member page, or the selected group's link state. When Zalo omits records, the result remains partial.",
    })
    .input(readInput)
    .output(zaloAccountGroupManagementResultSchema)
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => {
      const {
        accountId: id,
        groupId,
        kind,
        page,
        limit,
        offset,
        invitedGroupId,
      } = input
      const candidates = {
        getGroupInviteBoxList: { kind, page, limit },
        getGroupInviteBoxInfo: { kind, invitedGroupId },
        getGroupBlockedMember: { kind, page, limit },
        getPendingGroupMembers: { kind, offset, limit },
        getGroupLinkDetail: { kind },
      }
      return await zaloAccountGroupManagementService.read({
        workspaceId: workspaceForGroupManagement(context),
        accountId: id,
        groupId,
        operation: zaloAccountGroupManagementOperationSchema.parse(
          candidates[kind],
        ),
      })
    }),
  inspectGroupLink: api
    .route({
      method: "POST",
      path: `${path}/inspect-link`,
      summary: "Inspect Zalo group invitation link",
      tags,
      description:
        "Read the group's limited public provider summary. This inspection does not join the group.",
      spec: mcpSpec({ hitlPolicy: "none", readOnlyHint: true }),
    })
    .input(
      z.strictObject({
        accountId,
        link: zaloAccountGroupInviteLinkSchema.describe(
          "Zalo group invitation URL to inspect",
        ),
      }),
    )
    .output(zaloAccountGroupManagementResultSchema)
    .errors(possibleErrorsOnFindingResource)
    .handler(
      async ({ context, input }) =>
        await zaloAccountGroupManagementService.read({
          workspaceId: workspaceForGroupManagement(context),
          accountId: input.accountId,
          operation: { kind: "getGroupLinkInfo", link: input.link },
        }),
    ),
  mutateGroupManagement: api
    .route({
      method: "POST",
      path,
      summary: "Apply native Zalo group operation",
      tags,
      description:
        "Submit one explicitly selected group operation. Inspect the returned command ID to resolve partial or unknown outcomes before submitting another write.",
      spec: mcpSpec({
        hitlPolicy: "confirm_destructive",
        destructiveHint: true,
        openWorldHint: true,
      }),
    })
    .input(groupManagementMutationInput.safeExtend({ accountId }))
    .output(groupManagementAttemptOutput)
    .errors({
      ...possibleErrorsOnFindingResource,
      ...possibleIdempotencyErrors,
    })
    .handler(
      async ({ context, input }) =>
        await zaloAccountGroupManagementService.mutate({
          ...input,
          workspaceId: workspaceForGroupManagement(context),
          actor: context.member
            ? { type: "member", id: context.member.userId }
            : { type: "token", id: context.apiToken.id },
        }),
    ),
  getGroupManagementAttempt: api
    .route({
      method: "GET",
      path: `${path}/attempts/{commandId}`,
      summary: "Get native Zalo group operation outcome",
      tags,
      description:
        "Inspect one retained command by exact scope. This operation sends no provider writes.",
    })
    .input(groupManagementAttemptInput.extend({ accountId }))
    .output(groupManagementAttemptOutput)
    .errors(possibleErrorsOnFindingResource)
    .handler(
      async ({ context, input }) =>
        await zaloAccountGroupManagementService.attempt({
          workspaceId: workspaceForGroupManagement(context),
          ...input,
        }),
    ),
}
