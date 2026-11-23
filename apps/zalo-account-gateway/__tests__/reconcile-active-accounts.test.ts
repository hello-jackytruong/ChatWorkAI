import { describe, expect, it, vi } from "vitest"
import { reconcileActiveAccounts } from "../src/runtime/reconcile-active-accounts"

describe("reconcileActiveAccounts", () => {
  it("advances past a failed account and resumes a bounded scan from its cursor", async () => {
    const listPage = vi.fn().mockResolvedValue([
      { id: "2", workspaceId: "w", inboxId: "i" },
      { id: "3", workspaceId: "w", inboxId: "j" },
    ])
    const reconnect = vi
      .fn()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValue({ status: "started" })
    const result = await reconcileActiveAccounts({
      listPage,
      reconnect,
      afterId: "1",
      max: 2,
    })
    expect(result).toMatchObject({
      afterId: "3",
      complete: false,
      scanned: 2,
      restored: 1,
      failed: 1,
    })
    expect(listPage).toHaveBeenCalledWith({ afterId: "1", limit: 2 })
  })
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
    ).resolves.toMatchObject({ scanned: 2, restored: 2, complete: true })

    expect(listPage).toHaveBeenNthCalledWith(2, {
      afterId: "2",
      limit: 2,
    })
    expect(reconnect).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      runtime: { kind: "account", id: "1" },
      inboxId: "inbox-1",
      commandId: "startup:1",
      deadlineAt: expect.any(Number),
    })
  })
})
