"use server"

import { zaloAccountGroupService } from "@chatbotx.io/business/zalo-account"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { workspaceIdAndIdRequestParams } from "@/features/common/schema"
import { requireWorkspacePermission } from "@/lib/auth/require-workspace-permission"
import { workspaceActionClient } from "@/lib/safe-action"
import { zaloAccountGroupResource } from "../schema/resource"

export const updateZaloAccountGroupPolicyAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdAndIdRequestParams)
  .inputSchema(
    z.object({
      groupId: zodBigintAsString(),
      sendEnabled: z.boolean().optional(),
      receiveEnabled: z.boolean().optional(),
      automationMode: z.enum(["disabled", "mentionOnly", "all"]).optional(),
    }),
  )
  .action(
    async ({ bindArgsParsedInputs: [workspaceId, accountId], parsedInput }) => {
      await requireWorkspacePermission(workspaceId, "superAdmin")
      return zaloAccountGroupResource.parse(
        await zaloAccountGroupService.updateInboxPolicy({
          workspaceId,
          accountId,
          id: parsedInput.groupId,
          sendEnabled: parsedInput.sendEnabled,
          receiveEnabled: parsedInput.receiveEnabled,
          automationMode: parsedInput.automationMode,
        }),
      )
    },
  )
