import { withBlockedOwnerGuard } from "@chatbotx.io/business"
import { zaloAccountCanonicalSendService } from "@chatbotx.io/business/zalo-account/canonical-send"
import { zaloAccountGroupInboxService } from "@chatbotx.io/business/zalo-account/group-inbox"
import logger from "@chatbotx.io/logger"
import { distributedLock } from "@chatbotx.io/redis"
import { zaloAccountGroupMessageSchema } from "@chatbotx.io/sdk"
import {
  enqueueIntegrationJob,
  IntegrationJobAction,
} from "@chatbotx.io/worker-config"

/** Bounded outbox recovery, independent of BullMQ's job retention. */
export async function recoverZaloGroupInbox(): Promise<void> {
  await distributedLock.runExclusive({
    key: "schedule:zalo-group-inbox",
    timeoutInSeconds: 50,
    retryTimeoutInSeconds: 1,
    fn: recoverPending,
  })
}

async function recoverPending(): Promise<void> {
  const deadline = Date.now() + 40_000
  for (const attempt of await zaloAccountCanonicalSendService.pendingPrepared()) {
    if (Date.now() >= deadline) {
      break
    }
    await withBlockedOwnerGuard(attempt.workspaceId, async () => {
      try {
        await zaloAccountCanonicalSendService.recoverPrepared(attempt)
      } catch (err) {
        logger.warn(
          {
            err,
            workspaceId: attempt.workspaceId,
            accountId: attempt.accountId,
            attemptId: attempt.id,
          },
          "Could not recover a prepared Zalo send",
        )
      }
    })
  }
  const pending = await zaloAccountGroupInboxService.pickPending(100)
  for (const { identity, inboxId } of pending) {
    if (Date.now() >= deadline) {
      break
    }
    if (!identity.payload) {
      continue
    }
    await withBlockedOwnerGuard(identity.workspaceId, async () => {
      await enqueueIntegrationJob(
        {
          type: IntegrationJobAction.zaloAccountGroupMessage,
          data: {
            workspaceId: identity.workspaceId,
            accountId: identity.accountId,
            inboxId,
            accountPolicyEpoch: identity.accountPolicyEpoch,
            groupPolicyEpoch: identity.groupPolicyEpoch,
            message: zaloAccountGroupMessageSchema.parse(identity.payload),
          },
        },
        {
          jobId: `zalo-group-recover-${identity.id}-${Math.floor(Date.now() / 60_000)}`,
        },
      )
    })
  }
}
