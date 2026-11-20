import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findByInboxId: vi.fn(),
  reconnect: vi.fn(),
}))

vi.mock("@chatbotx.io/business/zalo-account", () => ({
  zaloAccountCommandTransportService: { reconnect: mocks.reconnect },
  zaloAccountService: { findByInboxId: mocks.findByInboxId },
}))

const { activateZaloAccountRuntime } = await import(
  "../src/zalo-account-runtime"
)

describe("activateZaloAccountRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findByInboxId.mockResolvedValue({ id: "account-1" })
    mocks.reconnect.mockResolvedValue({ commandId: "command-1" })
  })

  it("enqueues the durable account runtime after the connection commits", async () => {
    const updatedAt = new Date("2026-11-20T08:00:00.000Z")
    await activateZaloAccountRuntime({
      connection: {
        id: "connection-1",
        workspaceId: "workspace-1",
        inboxId: "inbox-1",
        updatedAt,
      } as never,
    })

    expect(mocks.reconnect).toHaveBeenCalledWith({
      commandId: `activate:connection-1:${updatedAt.toISOString()}`,
      workspaceId: "workspace-1",
      accountId: "account-1",
      inboxId: "inbox-1",
      ttlMs: 30_000,
    })
  })

  it("fails closed when the connection has no account metadata", async () => {
    mocks.findByInboxId.mockResolvedValue(null)

    await expect(
      activateZaloAccountRuntime({
        connection: {
          id: "connection-1",
          workspaceId: "workspace-1",
          inboxId: "inbox-1",
        } as never,
      }),
    ).rejects.toThrow("runtime metadata")

    expect(mocks.reconnect).not.toHaveBeenCalled()
  })
})
