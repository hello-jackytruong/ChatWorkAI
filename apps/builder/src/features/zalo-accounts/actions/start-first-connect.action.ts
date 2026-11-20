"use server"

import type { WorkspaceQuotaConsumption } from "@chatbotx.io/business"
import { connectionService } from "@chatbotx.io/connections"
import type { DatabaseClient } from "@chatbotx.io/database/client"
import { toConnectSessionResource } from "@/features/connections/lib/connect-session-resource"
import { authActionClient } from "@/lib/safe-action"
import { createFirstWorkspace } from "@/lib/workspace/create-first-workspace"

export const startFirstZaloAccountConnectAction = authActionClient.action(
  async ({ ctx }) => {
    const { session } = await connectionService.startDeviceSession({
      provider: "zaloAccount",
      purpose: "connect",
      actorUserId: ctx.user.id,
      createWorkspace: (
        tx: DatabaseClient,
        quotaConsumption: WorkspaceQuotaConsumption,
      ) => createFirstWorkspace(ctx.user.id, tx, quotaConsumption),
    })
    return {
      workspaceId: session.workspaceId,
      session: toConnectSessionResource(session),
    }
  },
)
