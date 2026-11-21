import { withBlockedOwnerGuard } from "@chatbotx.io/business"
import {
  zaloAccountFriendSyncService,
  zaloAccountService,
} from "@chatbotx.io/business/zalo-account"
import { distributedLock, distributedStore } from "@chatbotx.io/redis"
import { DefaultJobAction, defaultQueue } from "@chatbotx.io/worker-config"

const CURSOR = "schedule:zalo-labels:cursor"
export async function reconcileZaloLabels(): Promise<void> {
  await distributedLock.runExclusive({
    key: "schedule:zalo-labels",
    timeoutInSeconds: 30,
    retryTimeoutInSeconds: 1,
    fn: async () => {
      const afterId = await distributedStore.get<string>(CURSOR)
      const accounts = await zaloAccountService.listActiveRuntimeAccounts({
        ...(afterId ? { afterId } : {}),
        limit: 10,
      })
      for (const account of accounts) {
        await withBlockedOwnerGuard(account.workspaceId, async () => {
          await zaloAccountFriendSyncService.recoverCaches({
            workspaceId: account.workspaceId,
            accountId: account.id,
          })
          await defaultQueue.add(
            DefaultJobAction.syncChannelLabels,
            {
              type: DefaultJobAction.syncChannelLabels,
              data: {
                workspaceId: account.workspaceId,
                channelType: "zaloAccount",
                integrationId: account.id,
              },
            },
            {
              jobId: `zalo-label-reconcile-${account.id}-${Math.floor(Date.now() / 300_000)}`,
            },
          )
        })
      }
      await distributedStore.put(
        CURSOR,
        accounts.length === 10 ? accounts.at(-1)?.id : null,
      )
    },
  })
}
