"use server"

import { zaloAccountTimelineService } from "@chatbotx.io/business/zalo-account"
import { zodBigintAsString } from "@chatbotx.io/utils"
import {
  searchZaloTimeline,
  zaloTimelineQuoteInput,
  zaloTimelineSearchInput,
} from "@/features/zalo-accounts/api/timeline"
import { assertConversationAccessForCaller } from "@/lib/public-api/member-scope"
import { workspaceActionClient } from "@/lib/safe-action"

const workspaceConversation = workspaceActionClient.bindArgsSchemas([
  zodBigintAsString(),
  zodBigintAsString(),
])

export const searchZaloTimelineAction = workspaceConversation
  .inputSchema(zaloTimelineSearchInput)
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, conversationId],
      ctx,
      parsedInput,
    }) => {
      await assertConversationAccessForCaller(
        {
          workspace: ctx.workspace,
          member: ctx.workspaceMember,
          user: ctx.user,
        },
        conversationId,
      )
      return await searchZaloTimeline({
        ...parsedInput,
        workspaceId,
        conversationId,
      })
    },
  )

export const lookupZaloQuoteAction = workspaceConversation
  .inputSchema(zaloTimelineQuoteInput)
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, conversationId],
      ctx,
      parsedInput,
    }) => {
      await assertConversationAccessForCaller(
        {
          workspace: ctx.workspace,
          member: ctx.workspaceMember,
          user: ctx.user,
        },
        conversationId,
      )
      return await zaloAccountTimelineService.locate({
        ...parsedInput,
        workspaceId,
        conversationId,
      })
    },
  )
