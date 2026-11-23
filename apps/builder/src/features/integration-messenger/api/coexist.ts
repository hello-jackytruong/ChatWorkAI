import { coexistService } from "@chatbotx.io/business"
import {
  setCoexistRequestSchema,
  setCoexistResponseSchema,
} from "@/features/channel-connect/schema/coexist"
import { workspaceAuthorizedMidddleware } from "@/middlewares/auth"
import { authorizedAPI } from "@/orpc"

export const integrationMessengerCoexistAPIs = {
  setCoexistMessengerAPI: authorizedAPI
    .route({
      method: "POST",
      path: "/workspaces/{workspaceId}/integrations/messenger/{integrationId}/coexist",
      summary: "Enable or disable Messenger coexist sync",
      tags: ["Integrations"],
    })
    .input(setCoexistRequestSchema)
    .output(setCoexistResponseSchema)
    .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
    .handler(async ({ input }) => {
      const {
        workspaceId,
        integrationId,
        enabled,
        aiReadsSyncedHistory,
        skipNamelessContacts,
        resyncHistory,
      } = input
      return await (enabled
        ? coexistService.enable({
            workspaceId,
            integrationId,
            channel: "messenger",
            aiReadsSyncedHistory,
            skipNamelessContacts,
            resyncHistory,
          })
        : coexistService.disable({
            workspaceId,
            integrationId,
            channel: "messenger",
          }))
    }),
}
