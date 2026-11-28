"use server"

import {
  isZaloAccountRichSendEnabled,
  zaloAccountGroupService,
  zaloAccountGroupTagService,
  zaloAccountMessageStateService,
  zaloAccountService,
} from "@chatbotx.io/business/zalo-account"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { workspaceIdAndIdRequestParams } from "@/features/common/schema"
import { requireContactsAccess } from "@/lib/auth/require-workspace-permission"
import { workspaceActionClient } from "@/lib/safe-action"
import { zaloAccountGroupResource } from "../schema/resource"

export const getZaloGroupInboxAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdAndIdRequestParams)
  .inputSchema(z.object({ groupId: zodBigintAsString() }))
  .action(
    async ({ bindArgsParsedInputs: [workspaceId, accountId], parsedInput }) => {
      const scope = await requireContactsAccess(workspaceId)
      const group = zaloAccountGroupResource.parse(
        await zaloAccountGroupService.requireInboxAccess({
          workspaceId,
          accountId,
          id: parsedInput.groupId,
          ...scope,
        }),
      )
      const account = await zaloAccountService.status({
        workspaceId,
        accountId,
      })
      return {
        group,
        richSendEnabled: isZaloAccountRichSendEnabled(accountId),
        status: account.status,
        gatewayAvailable: account.gatewayAvailable,
        canSend:
          account.status === "connected" &&
          account.gatewayAvailable &&
          account.groupMessagingEnabled &&
          group.accessible &&
          group.sendEnabled,
        tags: await zaloAccountGroupTagService.list({
          workspaceId,
          accountId,
          groupId: group.id,
        }),
      }
    },
  )

export const updateZaloGroupTagAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdAndIdRequestParams)
  .inputSchema(
    z.object({
      groupId: zodBigintAsString(),
      tagId: zodBigintAsString(),
      assigned: z.boolean(),
      commandId: z.string().min(1).max(200),
    }),
  )
  .action(
    async ({ bindArgsParsedInputs: [workspaceId, accountId], parsedInput }) => {
      const scope = await requireContactsAccess(workspaceId)
      await zaloAccountGroupService.requireInboxAccess({
        workspaceId,
        accountId,
        id: parsedInput.groupId,
        ...scope,
      })
      await zaloAccountGroupTagService.update({
        workspaceId,
        accountId,
        groupId: parsedInput.groupId,
        tagIds: [parsedInput.tagId],
        assigned: parsedInput.assigned,
      })
      return await zaloAccountGroupTagService.list({
        workspaceId,
        accountId,
        groupId: parsedInput.groupId,
      })
    },
  )

export const getZaloGroupMessageStateAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdAndIdRequestParams)
  .inputSchema(
    z.object({
      groupId: zodBigintAsString(),
      providerMessageIds: z.array(z.string().min(1).max(200)).max(50),
    }),
  )
  .action(
    async ({ bindArgsParsedInputs: [workspaceId, accountId], parsedInput }) => {
      const scope = await requireContactsAccess(workspaceId)
      await zaloAccountGroupService.requireInboxAccess({
        workspaceId,
        accountId,
        id: parsedInput.groupId,
        ...scope,
      })
      return await zaloAccountMessageStateService.get({
        workspaceId,
        accountId,
        ...parsedInput,
      })
    },
  )

export const sendZaloGroupTypingAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdAndIdRequestParams)
  .inputSchema(
    z.object({
      groupId: zodBigintAsString(),
      commandId: z.string().min(1).max(200),
    }),
  )
  .action(
    async ({ bindArgsParsedInputs: [workspaceId, accountId], parsedInput }) => {
      const scope = await requireContactsAccess(workspaceId)
      await zaloAccountGroupService.requireInboxAccess({
        workspaceId,
        accountId,
        id: parsedInput.groupId,
        ...scope,
      })
      return await zaloAccountMessageStateService.sendTyping({
        workspaceId,
        accountId,
        ...parsedInput,
      })
    },
  )
