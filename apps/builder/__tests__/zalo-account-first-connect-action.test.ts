// @vitest-environment node

import { describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  handler: undefined as
    | ((input: { ctx: { user: { id: string } } }) => Promise<unknown>)
    | undefined,
  startDeviceSession: vi.fn(),
  createFirstWorkspace: vi.fn(),
}))

vi.mock("@/lib/safe-action", () => ({
  authActionClient: {
    action: (handler: typeof mocks.handler) => {
      mocks.handler = handler
      return handler
    },
  },
}))
vi.mock("@chatbotx.io/connections", () => ({
  connectionService: { startDeviceSession: mocks.startDeviceSession },
}))
vi.mock("@/lib/workspace/create-first-workspace", () => ({
  createFirstWorkspace: mocks.createFirstWorkspace,
}))
vi.mock("@/features/connections/lib/connect-session-resource", () => ({
  toConnectSessionResource: (session: unknown) => session,
}))

await import("@/features/zalo-accounts/actions/start-first-connect.action")

describe("startFirstZaloAccountConnectAction", () => {
  test("delegates workspace creation into the device-session transaction", async () => {
    mocks.startDeviceSession.mockImplementation(async (input) => ({
      session: {
        id: "session-1",
        workspaceId: await input
          .createWorkspace("tx", { consumed: false })
          .then((workspace: { id: string }) => workspace.id),
      },
    }))
    mocks.createFirstWorkspace.mockResolvedValue({ id: "workspace-1" })

    await expect(
      mocks.handler?.({ ctx: { user: { id: "user-1" } } }),
    ).resolves.toEqual({
      workspaceId: "workspace-1",
      session: { id: "session-1", workspaceId: "workspace-1" },
    })
    expect(mocks.startDeviceSession).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "zaloAccount",
        purpose: "connect",
        actorUserId: "user-1",
        createWorkspace: expect.any(Function),
      }),
    )
    expect(mocks.createFirstWorkspace).toHaveBeenCalledWith("user-1", "tx", {
      consumed: false,
    })
  })
})
