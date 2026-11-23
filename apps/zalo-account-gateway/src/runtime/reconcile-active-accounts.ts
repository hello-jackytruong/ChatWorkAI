import type { RuntimeCommand, RuntimeCommandResult } from "./ports"

type AccountRoute = {
  id: string
  workspaceId: string
  inboxId: string
  skip?: boolean
}

export const reconcileActiveAccounts = async (input: {
  listPage: (input: {
    afterId?: string
    limit: number
  }) => Promise<AccountRoute[]>
  reconnect: (command: RuntimeCommand) => Promise<RuntimeCommandResult>
  afterId?: string
  deadlineAt?: number
  signal?: AbortSignal
  pageSize?: number
  max?: number
}): Promise<{
  afterId?: string
  complete: boolean
  scanned: number
  restored: number
  failed: number
  outcomes: Array<{ accountId: string; status: string }>
}> => {
  const pageSize = Math.min(Math.max(input.pageSize ?? 50, 1), 100)
  const max = Math.min(Math.max(input.max ?? 50, 1), 10_000)
  let afterId = input.afterId
  let restored = 0
  let scanned = 0
  let failed = 0
  let complete = false
  const outcomes: Array<{ accountId: string; status: string }> = []
  const deadlineAt = input.deadlineAt ?? Date.now() + 30_000
  const expired = () => input.signal?.aborted || Date.now() >= deadlineAt

  while (scanned < max && !expired()) {
    const limit = Math.min(pageSize, max - scanned)
    const page = await input.listPage({
      ...(afterId ? { afterId } : {}),
      limit,
    })
    if (page.length === 0) {
      complete = true
      break
    }
    for (const account of page) {
      if (expired() || scanned >= max) {
        break
      }
      if (account.skip) {
        scanned += 1
        afterId = account.id
        outcomes.push({ accountId: account.id, status: "held" })
        continue
      }
      try {
        const result = await input.reconnect({
          workspaceId: account.workspaceId,
          runtime: { kind: "account", id: account.id },
          inboxId: account.inboxId,
          commandId: `startup:${account.id}`,
          deadlineAt,
        })
        if (result.status === "started" || result.status === "coalesced") {
          restored += 1
        }
        outcomes.push({ accountId: account.id, status: result.status })
      } catch {
        failed += 1
        outcomes.push({ accountId: account.id, status: "failed" })
      }
      scanned += 1
      afterId = account.id
    }
    if (afterId === page.at(-1)?.id && page.length < limit) {
      complete = true
      break
    }
  }

  return { afterId, complete, scanned, restored, failed, outcomes }
}
