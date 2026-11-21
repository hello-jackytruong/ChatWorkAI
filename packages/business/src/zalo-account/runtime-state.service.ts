import {
  connectionRepository,
  integrationZaloAccountRepository,
} from "@chatbotx.io/database/repositories"
import type { ZaloAccountRuntimeOrder } from "@chatbotx.io/sdk"
import {
  connectionStateService,
  type PendingQuotaRelease,
} from "../connection/state-service"

const runtimeTransitions = {
  connected: { event: "verify.ok", reason: undefined, lastError: null },
  closed: {
    event: "refresh.transient_failure",
    reason: "refresh_failed",
    lastError: "Zalo socket closed; reconnecting",
  },
  reauthorization_required: {
    event: "auth.revoked",
    reason: "token_revoked",
    lastError: "Zalo device authorization requires renewal",
  },
} as const

export const zaloAccountRuntimeStateService = {
  async apply(input: {
    workspaceId: string
    accountId: string
    inboxId: string
    order: ZaloAccountRuntimeOrder
  }): Promise<void> {
    const pendingRelease: { current: PendingQuotaRelease | null } = {
      current: null,
    }
    await integrationZaloAccountRepository.withRuntimeFence(
      {
        workspaceId: input.workspaceId,
        id: input.accountId,
        inboxId: input.inboxId,
        order: input.order,
      },
      async (tx) => {
        const connection = await connectionRepository.findByInboxId(
          { inboxId: input.inboxId },
          tx,
        )
        if (
          !connection ||
          connection.workspaceId !== input.workspaceId ||
          connection.provider !== "zaloAccount" ||
          !["connected", "degraded"].includes(connection.status)
        ) {
          return
        }
        const transition = runtimeTransitions[input.order.state]
        await connectionStateService.transition({
          connectionId: connection.id,
          event: transition.event,
          reason: transition.reason,
          values: { lastError: transition.lastError },
          tx,
          pendingRelease,
        })
      },
    )
    await connectionStateService.releasePendingQuota(pendingRelease.current)
  },
}
