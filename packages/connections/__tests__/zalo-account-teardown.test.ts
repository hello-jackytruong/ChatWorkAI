import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findByInboxId: vi.fn(),
  stopAndWait: vi.fn(),
}))

vi.mock("@chatbotx.io/business/zalo-account", () => ({
  zaloAccountCommandTransportService: { stopAndWait: mocks.stopAndWait },
  zaloAccountService: { findByInboxId: mocks.findByInboxId },
}))

const { zaloAccountConnectionTeardownHook } = await import(
  "../src/zalo-account-teardown"
)

describe("zaloAccountConnectionTeardownHook", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findByInboxId.mockResolvedValue({ id: "account-1" })
    mocks.stopAndWait.mockResolvedValue({
      status: "applied",
      result: { status: "stopped" },
    })
  })

  it("confirms exact runtime stop before allowing local disconnect", async () => {
    const result = await zaloAccountConnectionTeardownHook({
      connection: {
        id: "connection-1",
        workspaceId: "workspace-1",
        inboxId: "inbox-1",
      } as never,
      auth: { authType: "none" },
    })

    expect(mocks.stopAndWait).toHaveBeenCalledWith({
      commandId: "disconnect:connection-1",
      workspaceId: "workspace-1",
      accountId: "account-1",
      inboxId: "inbox-1",
      ttlMs: 30_000,
      waitTimeoutMs: 10_000,
    })
    expect(result).toMatchObject({
      remoteErrors: [],
      skipGenericRemoteTeardown: true,
    })
  })
})
