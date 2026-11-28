"use server"

import {
  isZaloAccountHistorySyncEnabled,
  zaloAccountHistorySyncService,
} from "@chatbotx.io/business/zalo-account"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { workspaceIdAndIdRequestParams } from "@/features/common/schema"
import { requireWorkspacePermission } from "@/lib/auth/require-workspace-permission"
import {
  assertConversationAccessForCaller,
  type MemberScopeContext,
} from "@/lib/public-api/member-scope"
import { workspaceActionClient } from "@/lib/safe-action"

const scopedAccount = workspaceActionClient.bindArgsSchemas(
  workspaceIdAndIdRequestParams,
)
const target = z.object({
  conversationId: zodBigintAsString().optional(),
  contactInboxId: zodBigintAsString().optional(),
})
const completeTarget = (input: z.infer<typeof target>) =>
  Boolean(input.conversationId) === Boolean(input.contactInboxId)
const inconsistentTarget = "Select both conversation and contact inbox"
const commandId = z.string().min(1).max(200)

async function authorizeSync(
  context: MemberScopeContext,
  conversationId?: string,
) {
  if (conversationId) {
    await assertConversationAccessForCaller(context, conversationId)
  } else {
    await requireWorkspacePermission(context.workspace.id, "superAdmin")
  }
}

export const getZaloHistorySyncStatusAction = scopedAccount
  .inputSchema(target.refine(completeTarget, inconsistentTarget))
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, accountId],
      ctx,
      parsedInput,
    }) => {
      await authorizeSync(
        {
          workspace: ctx.workspace,
          member: ctx.workspaceMember,
          user: ctx.user,
        },
        parsedInput.conversationId,
      )
      return {
        enabled: isZaloAccountHistorySyncEnabled(),
        run: await zaloAccountHistorySyncService.status({
          workspaceId,
          accountId,
          ...parsedInput,
        }),
      }
    },
  )

export const startZaloHistorySyncAction = scopedAccount
  .inputSchema(
    target.extend({ commandId }).refine(completeTarget, inconsistentTarget),
  )
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, accountId],
      ctx,
      parsedInput,
    }) => {
      await authorizeSync(
        {
          workspace: ctx.workspace,
          member: ctx.workspaceMember,
          user: ctx.user,
        },
        parsedInput.conversationId,
      )
      return await zaloAccountHistorySyncService.start({
        workspaceId,
        accountId,
        ...parsedInput,
      })
    },
  )

export const resumeZaloHistorySyncAction = scopedAccount
  .inputSchema(
    target
      .extend({ commandId, runId: zodBigintAsString() })
      .refine(completeTarget, inconsistentTarget),
  )
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, accountId],
      ctx,
      parsedInput,
    }) => {
      await authorizeSync(
        {
          workspace: ctx.workspace,
          member: ctx.workspaceMember,
          user: ctx.user,
        },
        parsedInput.conversationId,
      )
      return await zaloAccountHistorySyncService.resume({
        workspaceId,
        accountId,
        ...parsedInput,
      })
    },
  )
