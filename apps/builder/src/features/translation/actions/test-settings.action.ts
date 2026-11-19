"use server"
import { ChatbotXException } from "@chatbotx.io/business/errors"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { getTranslations } from "next-intl/server"
import { workspaceActionClient } from "@/lib/safe-action"
import { canManageTranslation } from "../lib/assert-can-manage"
import { testTranslationSettings } from "../lib/test-settings"
import { testTranslationSettingsRequest } from "../schema/action"

export const testTranslationSettingsAction = workspaceActionClient
  .bindArgsSchemas([zodBigintAsString()])
  .inputSchema(testTranslationSettingsRequest)
  .action(async ({ bindArgsParsedInputs: [workspaceId], parsedInput, ctx }) => {
    if (!canManageTranslation(ctx.workspaceMember)) {
      const t = await getTranslations()
      throw new ChatbotXException(t("errors.superAdminRequired"))
    }
    return await testTranslationSettings({
      workspaceId,
      request: parsedInput,
    })
  })
