import { describe, expect, it, vi } from "vitest"
import { reconcileActiveAccounts } from "../src/runtime/reconcile-active-accounts"

describe("reconcileActiveAccounts", () => {
  it("restores bounded pages of active durable runtimes", async () => {
    const listPage = vi
      .fn()
      .mockResolvedValueOnce([
        { id: "1", workspaceId: "workspace-1", inboxId: "inbox-1" },
        { id: "2", workspaceId: "workspace-2", inboxId: "inbox-2" },
      ])
      .mockResolvedValueOnce([])
    const reconnect = vi.fn(async () => ({ status: "started" as const }))

    await expect(
      reconcileActiveAccounts({ listPage, reconnect, pageSize: 2, max: 10 }),
    ).resolves.toBe(2)

    expect(listPage).toHaveBeenNthCalledWith(2, {
      afterId: "2",
      limit: 2,
    })
    expect(reconnect).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      runtime: { kind: "account", id: "1" },
      inboxId: "inbox-1",
      commandId: "startup:1",
    })
  })
})
