// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  findSession: vi.fn(),
  advanceStep: vi.fn(),
  claimAuthorization: vi.fn(),
  cancel: vi.fn(),
  cancelDeviceAuthorization: vi.fn(),
  storeAuthorization: vi.fn(),
  fail: vi.fn(),
  findConnection: vi.fn(),
  startDeviceAuthorization: vi.fn(),
  verify: vi.fn(),
  continueAuthorization: vi.fn(),
  loggerWarn: vi.fn(),
  providerFailureStatus: vi.fn(),
  toConnectionProviderError: vi.fn((error: unknown) => error),
  transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
    callback("tx"),
  ),
  compensateWorkspaceQuota: vi.fn(),
  dispatchStagedInstalls: vi.fn(),
}))

vi.mock("@chatbotx.io/business/connect-session", () => ({
  connectSessionService: {
    create: mocks.createSession,
    findByIdForWorkspace: mocks.findSession,
    advanceStep: mocks.advanceStep,
    claimAuthorization: mocks.claimAuthorization,
    cancel: mocks.cancel,
    storeAuthorization: mocks.storeAuthorization,
    fail: mocks.fail,
  },
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  connectionRepository: { findByIdForWorkspace: mocks.findConnection },
}))
vi.mock("@chatbotx.io/database/client", () => ({
  db: { transaction: mocks.transaction },
}))
vi.mock("@chatbotx.io/business/workspace", () => ({
  compensateWorkspaceQuotaConsumption: mocks.compensateWorkspaceQuota,
}))
vi.mock("@chatbotx.io/business/template-install-dispatch", () => ({
  dispatchStagedInstalls: mocks.dispatchStagedInstalls,
}))
vi.mock("../src/internal", () => ({
  resolveAdapter: () => ({
    provider: {
      strategy: "qr_device",
      acceptsTrustedDeviceAuthorization: true,
      startDeviceAuthorization: mocks.startDeviceAuthorization,
      cancelDeviceAuthorization: mocks.cancelDeviceAuthorization,
      verify: mocks.verify,
    },
  }),
  providerFailureStatus: mocks.providerFailureStatus,
  toConnectionProviderError: mocks.toConnectionProviderError,
}))
vi.mock("../src/connect-session-flow", () => ({
  continueAuthorization: mocks.continueAuthorization,
}))
vi.mock("../src/logger", () => ({ logger: { warn: mocks.loggerWarn } }))

const {
  completeDeviceAuthorization,
  completeTrustedDeviceAuthorization,
  cancelDeviceSession,
  markDeviceQrScanned,
  publishDeviceQr,
  startDeviceSession,
} = await import("../src/device-session-flow")

const session = {
  id: "session-1",
  workspaceId: "ws-1",
  provider: "zaloAccount",
  purpose: "connect",
  status: "pending",
  step: "device_start",
  targetConnectionId: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.createSession.mockResolvedValue({
    session: { ...session, nextAction: { type: "wait" } },
  })
  mocks.findSession.mockResolvedValue(session)
  mocks.advanceStep.mockImplementation(
    async (input: Record<string, unknown>) => ({
      ...session,
      status: Array.isArray(input.statuses)
        ? input.statuses[0]
        : session.status,
      step: input.step,
      nextAction: input.nextAction,
    }),
  )
  mocks.claimAuthorization.mockResolvedValue({
    ...session,
    status: "authorized",
    step: "authorization_received",
  })
  mocks.storeAuthorization.mockResolvedValue({
    ...session,
    status: "authorized",
    step: "authorization_received",
  })
  mocks.startDeviceAuthorization.mockResolvedValue(undefined)
  mocks.cancelDeviceAuthorization.mockResolvedValue(undefined)
  mocks.cancel.mockResolvedValue({ ...session, status: "cancelled" })
  mocks.verify.mockResolvedValue({ ok: true })
  mocks.providerFailureStatus.mockReturnValue(undefined)
  mocks.continueAuthorization.mockResolvedValue({
    ...session,
    status: "awaiting_selection",
  })
})

describe("startDeviceSession", () => {
  it("persists the session before dispatching asynchronous QR startup", async () => {
    const order: string[] = []
    mocks.createSession.mockImplementation(() => {
      order.push("create")
      return Promise.resolve({
        session: { ...session, nextAction: { type: "wait" } },
      })
    })
    mocks.startDeviceAuthorization.mockImplementation(() => {
      order.push("dispatch")
      return Promise.resolve()
    })

    const result = await startDeviceSession({
      workspaceId: "ws-1",
      provider: "zaloAccount",
      purpose: "connect",
      actorUserId: "user-1",
    })

    expect(order).toEqual(["create", "dispatch"])
    expect(result.nextAction).toEqual({ type: "wait" })
    expect(mocks.startDeviceAuthorization).toHaveBeenCalledWith({
      sessionId: "session-1",
      workspaceId: "ws-1",
      purpose: "connect",
      targetConnectionId: null,
    })
  })

  it("creates the first workspace and device session in one transaction", async () => {
    const createWorkspace = vi.fn(async () => ({ id: "ws-1" }))

    await startDeviceSession({
      createWorkspace,
      provider: "zaloAccount",
      purpose: "connect",
      actorUserId: "user-1",
    })

    expect(createWorkspace).toHaveBeenCalledWith("tx", { consumed: false })
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1" }),
      "tx",
    )
    expect(mocks.dispatchStagedInstalls).toHaveBeenCalledWith("ws-1")
  })

  it("fails the durable session when QR dispatch fails", async () => {
    const error = new Error("gateway unavailable")
    mocks.startDeviceAuthorization.mockRejectedValueOnce(error)

    await expect(
      startDeviceSession({
        workspaceId: "ws-1",
        provider: "zaloAccount",
        purpose: "connect",
        actorTokenId: "token-1",
      }),
    ).rejects.toMatchObject({ code: "connectionCredentialsRejected" })
    expect(mocks.fail).toHaveBeenCalledWith({
      id: "session-1",
      workspaceId: "ws-1",
      errorCode: "provider_error",
      statuses: ["pending"],
    })
  })
})

describe("device session events", () => {
  it("stops provider authorization before cancelling the durable session", async () => {
    await cancelDeviceSession({
      sessionId: "session-1",
      workspaceId: "ws-1",
    })

    expect(mocks.cancelDeviceAuthorization).toHaveBeenCalledWith({
      sessionId: "session-1",
      workspaceId: "ws-1",
    })
    expect(
      mocks.cancelDeviceAuthorization.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.cancel.mock.invocationCallOrder[0] ?? 0)
  })

  it("publishes QR only from the start/ready steps with provider scope", async () => {
    await publishDeviceQr({
      sessionId: "session-1",
      workspaceId: "ws-1",
      provider: "zaloAccount",
      imageDataUrl: "data:image/png;base64,QUJD",
      expiresAt: "2026-11-19T09:00:00.000Z",
    })

    expect(mocks.advanceStep).toHaveBeenCalledWith({
      id: "session-1",
      workspaceId: "ws-1",
      provider: "zaloAccount",
      statuses: ["pending"],
      expectedSteps: ["device_start", "qr_ready"],
      step: "qr_ready",
      nextAction: {
        type: "show_qr",
        imageDataUrl: "data:image/png;base64,QUJD",
        expiresAt: "2026-11-19T09:00:00.000Z",
      },
    })
  })

  it("clears the QR action when the code is scanned", async () => {
    await markDeviceQrScanned({
      sessionId: "session-1",
      workspaceId: "ws-1",
      provider: "zaloAccount",
    })

    expect(mocks.advanceStep).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSteps: ["qr_ready"],
        step: "qr_scanned",
        nextAction: { type: "wait" },
      }),
    )
  })

  it("verifies authorization before continuing the shared authorization flow", async () => {
    const auth = {
      authType: "custom" as const,
      cookie: [{ key: "a", value: "b" }],
      imei: "imei",
      userAgent: "agent",
      zaloUid: "uid-1",
    }

    await completeDeviceAuthorization({
      sessionId: "session-1",
      workspaceId: "ws-1",
      provider: "zaloAccount",
      auth,
    })

    expect(mocks.verify).toHaveBeenCalledWith({ auth })
    expect(mocks.continueAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-1", status: "authorized" }),
      auth,
    )
  })

  it("accepts a gateway-verified authorization without opening a second provider session", async () => {
    const auth = {
      authType: "custom" as const,
      cookie: [{ key: "a", value: "b" }],
      imei: "imei",
      userAgent: "agent",
      zaloUid: "uid-1",
    }

    await completeTrustedDeviceAuthorization({
      sessionId: "session-1",
      workspaceId: "ws-1",
      provider: "zaloAccount",
      auth,
    })

    expect(mocks.verify).not.toHaveBeenCalled()
    expect(mocks.continueAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-1", status: "authorized" }),
      auth,
    )
  })

  it("carries only gateway-trusted Zalo profile metadata to candidate authorization", async () => {
    const auth = {
      authType: "custom" as const,
      cookie: [],
      imei: "imei",
      userAgent: "agent",
      zaloUid: "uid-1",
    }
    const trustedProfile = {
      displayName: "Jacky",
      avatarUrl: "https://a.zdn.vn/avatar",
    }
    await completeTrustedDeviceAuthorization({
      sessionId: "session-1",
      workspaceId: "ws-1",
      provider: "zaloAccount",
      auth,
      trustedProfile,
    })
    expect(mocks.continueAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-1" }),
      auth,
      trustedProfile,
    )
  })

  it("accepts authorization when the scanned event is still queued", async () => {
    await completeDeviceAuthorization({
      sessionId: "session-1",
      workspaceId: "ws-1",
      provider: "zaloAccount",
      auth: {
        authType: "custom",
        cookie: [{ key: "a", value: "b" }],
        imei: "imei",
        userAgent: "agent",
        zaloUid: "uid-1",
      },
    })

    expect(mocks.advanceStep).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSteps: ["qr_ready", "qr_scanned"] }),
    )
  })

  it("fails the session and returns a safe error when provider verification rejects", async () => {
    mocks.verify.mockRejectedValueOnce(new Error("secret upstream failure"))

    await expect(
      completeDeviceAuthorization({
        sessionId: "session-1",
        workspaceId: "ws-1",
        provider: "zaloAccount",
        auth: {
          authType: "custom",
          cookie: [{ key: "a", value: "b" }],
          imei: "imei",
          userAgent: "agent",
          zaloUid: "uid-1",
        },
      }),
    ).rejects.toMatchObject({ code: "connectionCredentialsRejected" })
    expect(mocks.fail).toHaveBeenCalledWith({
      id: "session-1",
      workspaceId: "ws-1",
      errorCode: "provider_error",
      statuses: ["authorized"],
    })
  })

  it("does not verify or continue a duplicate authorization already being processed", async () => {
    const authorized = {
      ...session,
      status: "authorized",
    }
    mocks.findSession.mockResolvedValueOnce(authorized)

    await expect(
      completeDeviceAuthorization({
        sessionId: "session-1",
        workspaceId: "ws-1",
        provider: "zaloAccount",
        auth: {
          authType: "custom",
          cookie: [{ key: "a", value: "b" }],
          imei: "imei",
          userAgent: "agent",
          zaloUid: "uid-1",
        },
      }),
    ).resolves.toEqual(authorized)
    expect(mocks.verify).not.toHaveBeenCalled()
    expect(mocks.continueAuthorization).not.toHaveBeenCalled()
  })
})
