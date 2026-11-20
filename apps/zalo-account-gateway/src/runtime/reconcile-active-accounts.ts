import type { RuntimeCommand, RuntimeCommandResult } from "./ports"

type AccountRoute = { id: string; workspaceId: string; inboxId: string }

export const reconcileActiveAccounts = async (input: {
  listPage: (input: {
    afterId?: string
    limit: number
  }) => Promise<AccountRoute[]>
  reconnect: (command: RuntimeCommand) => Promise<RuntimeCommandResult>
  pageSize?: number
  max?: number
}): Promise<number> => {
  const pageSize = Math.min(Math.max(input.pageSize ?? 50, 1), 100)
  const max = Math.min(Math.max(input.max ?? 1000, 1), 10_000)
  let afterId: string | undefined
  let restored = 0

  while (restored < max) {
    const limit = Math.min(pageSize, max - restored)
    const page = await input.listPage({
      ...(afterId ? { afterId } : {}),
      limit,
    })
    if (page.length === 0) {
      break
    }
    for (const account of page) {
      await input.reconnect({
        workspaceId: account.workspaceId,
        runtime: { kind: "account", id: account.id },
        inboxId: account.inboxId,
        commandId: `startup:${account.id}`,
      })
      restored += 1
    }
    afterId = page.at(-1)?.id
    if (!afterId || page.length < limit) {
      break
    }
  }

  return restored
}
