"use server"
import { ChatbotXException } from "@chatbotx.io/business/errors"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { getTranslations } from "next-intl/server"
import { workspaceActionClient } from "@/lib/safe-action"
import { canManageTranslation } from "../lib/assert-can-manage"
import { updateTranslationSettings } from "../lib/update-settings"
import { updateTranslationSettingsRequest } from "../schema/action"

export const updateTranslationSettingsAction = workspaceActionClient
  .bindArgsSchemas([zodBigintAsString()])
  .inputSchema(updateTranslationSettingsRequest)
  .action(async ({ bindArgsParsedInputs: [workspaceId], parsedInput, ctx }) => {
    if (!canManageTranslation(ctx.workspaceMember)) {
      const t = await getTranslations()
      throw new ChatbotXException(t("errors.superAdminRequired"))
    }
    return await updateTranslationSettings({
      workspaceId,
      request: parsedInput,
    })
  })
