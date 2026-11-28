"use server"

import { contactInboxService } from "@chatbotx.io/business"
import { notFoundException } from "@chatbotx.io/business/errors"
import { hasWorkspacePermission } from "@chatbotx.io/business/workspace-member/permissions"
import {
  zaloAccountProfileService,
  zaloAccountService,
} from "@chatbotx.io/business/zalo-account"
import { zaloAccountProfileSchema } from "@chatbotx.io/sdk"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { assertConversationAccessForCaller } from "@/lib/public-api/member-scope"
import { workspaceActionClient } from "@/lib/safe-action"

export const getZaloProfileAction = workspaceActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString().nullable()])
  .inputSchema(
    z
      .object({
        conversationId: zodBigintAsString(),
        contactInboxId: zodBigintAsString(),
        memberUid: zaloAccountProfileSchema.shape.uid.optional(),
        refresh: z.boolean().optional(),
        largeAvatar: z.boolean().optional(),
      })
      .refine((input) => !input.largeAvatar || input.refresh === true),
  )
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId, accountId],
      ctx,
      parsedInput,
    }) => {
      const conversation = await assertConversationAccessForCaller(
        {
          workspace: ctx.workspace,
          member: ctx.workspaceMember,
          user: ctx.user,
        },
        parsedInput.conversationId,
      )
      let scopedAccountId = accountId
      if (!scopedAccountId) {
        const inbox = await contactInboxService.findByIdForWorkspace({
          workspaceId,
          id: parsedInput.contactInboxId,
        })
        if (
          inbox?.channel !== "zaloAccount" ||
          inbox.contactKind !== "person" ||
          inbox.contactId !== conversation.contactId
        ) {
          throw notFoundException("Zalo contact profile not found")
        }
        scopedAccountId =
          (
            await zaloAccountService.findByInboxId({
              workspaceId,
              inboxId: inbox.inboxId,
            })
          )?.id ?? null
      }
      if (!scopedAccountId) {
        throw notFoundException("Zalo contact profile not found")
      }
      const result = await zaloAccountProfileService.get({
        workspaceId,
        accountId: scopedAccountId,
        ...parsedInput,
      })
      if (
        !result.profile ||
        hasWorkspacePermission(ctx.workspaceMember.permissions, "emailAndPhone")
      ) {
        return result
      }
      const { publicPhone: _publicPhone, ...redactedFields } =
        result.profile.fields
      const fields: typeof result.profile.fields = redactedFields
      return { ...result, profile: { ...result.profile, fields } }
    },
  )
