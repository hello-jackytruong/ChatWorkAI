"use server"

import { zaloAccountGroupService } from "@chatbotx.io/business/zalo-account"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { assertConversationAccessForCaller } from "@/lib/public-api/member-scope"
import { workspaceActionClient } from "@/lib/safe-action"
import { zaloAccountGroupMembersInput } from "../schema/group-members"

export const listZaloGroupMembersAction = workspaceActionClient
  .bindArgsSchemas([zodBigintAsString()])
  .inputSchema(zaloAccountGroupMembersInput)
  .action(async ({ bindArgsParsedInputs: [workspaceId], parsedInput, ctx }) => {
    await assertConversationAccessForCaller(
      { workspace: ctx.workspace, member: ctx.workspaceMember, user: ctx.user },
      parsedInput.conversationId,
    )
    return await zaloAccountGroupService.listMembers({
      ...parsedInput,
      workspaceId,
    })
  })
