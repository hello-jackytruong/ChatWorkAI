const THREAD_EVENT_JOB_PATTERN = /^zalo-thread-event-[a-f0-9]{64}$/
const GROUP_MESSAGE_JOB_PATTERN = /^zalo-group-message-[a-f0-9]+$/

import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  completeTrusted: vi.fn(),
  decryptObject: vi.fn(),
  enqueueIntegrationJob: vi.fn(),
  applyRuntime: vi.fn(),
  applyDiagnostics: vi.fn(),
  findSession: vi.fn(),
  failSession: vi.fn(),
  recordFriendActivity: vi.fn(),
  realtime: vi.fn(),
  markScanned: vi.fn(),
  publishQr: vi.fn(),
  withBlockedOwnerGuard: vi.fn(
    async (_workspaceId: string, operation: () => Promise<unknown>) =>
      await operation(),
  ),
}))
vi.mock("@chatbotx.io/business/zalo-account/runtime-state", () => ({
  zaloAccountRuntimeStateService: {
    apply: mocks.applyRuntime,
    applyDiagnostics: mocks.applyDiagnostics,
  },
}))
vi.mock("@chatbotx.io/business/zalo-account/friend-activity", () => ({
  zaloAccountFriendActivityService: { record: mocks.recordFriendActivity },
}))
vi.mock("@chatbotx.io/business/connect-session", () => ({
  connectSessionService: {
    findByIdForWorkspace: mocks.findSession,
    fail: mocks.failSession,
  },
}))

vi.mock("@chatbotx.io/business", () => ({
  withBlockedOwnerGuard: mocks.withBlockedOwnerGuard,
  queueWorkspaceRealtimeEvent: mocks.realtime,
}))
vi.mock("@chatbotx.io/connections", () => ({
  connectionService: {
    completeTrustedDeviceAuthorization: mocks.completeTrusted,
    markDeviceQrScanned: mocks.markScanned,
    publishDeviceQr: mocks.publishQr,
  },
}))
vi.mock("@chatbotx.io/encryption", () => ({
  encryptUtils: { decryptObject: mocks.decryptObject },
}))
vi.mock("@chatbotx.io/worker-config", () => ({
  IntegrationJobAction: {
    deleteIncomingMessage: "deleteIncomingMessage",
    incomingMessage: "incomingMessage",
    incomingMessageEcho: "incomingMessageEcho",
    messageStatus: "messageStatus",
    zaloAccountGroupRefresh: "zaloAccountGroupRefresh",
    zaloAccountGroupMessage: "zaloAccountGroupMessage",
    zaloAccountThreadEvent: "zaloAccountThreadEvent",
  },
  enqueueIntegrationJob: mocks.enqueueIntegrationJob,
}))

const { handleZaloAccountEvents } = await import(
  "../src/events/zalo-account/handler"
)

const DIRECT_JOB_ID_PATTERN = /^zalo-account-[a-f0-9]{64}$/
const STATUS_JOB_ID_PATTERN = /^zalo-account-status-/
const UNDO_JOB_ID_PATTERN = /^zalo-account-undo-/
const GROUP_REFRESH_JOB_ID_PATTERN = /^zalo-group-refresh-/

const secretBase = {
  version: 1 as const,
  eventId: "event-1",
  route: {
    kind: "connect_session" as const,
    workspaceId: "workspace-1",
    sessionId: "session-1",
  },
  epoch: 1,
  fenceToken: "2",
  occurredAt: "2026-11-20T02:00:00.000Z",
  kind: "secret" as const,
  aad: "zalo-account:workspace-1:session-1:command-1:1:2:event-1",
  ciphertext: {
    v: 1 as const,
    kid: "active",
    iv: "000000000000000000000000",
    text: "aa",
    tag: "00000000000000000000000000000000",
    aad: "zalo-account:workspace-1:session-1:command-1:1:2:event-1",
  },
}

describe("handleZaloAccountEvents", () => {
  it("records scoped friend activity without queueing message work or connection transitions", async () => {
    mocks.enqueueIntegrationJob.mockClear()
    mocks.applyRuntime.mockClear()
    const route = {
      kind: "account" as const,
      workspaceId: "w",
      accountId: "a",
      inboxId: "i",
    }
    const activity = {
      uid: "42",
      kind: "request" as const,
      direction: "incoming" as const,
    }
    await handleZaloAccountEvents([
      {
        version: 1,
        eventId: "friend-activity",
        kind: "lifecycle",
        route,
        epoch: 1,
        fenceToken: "2",
        socketAttempt: 3,
        sequence: 4,
        occurredAt: "2026-11-20T02:00:00.000Z",
        payload: { type: "friend_activity", activity },
      },
    ])
    expect(mocks.recordFriendActivity).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "w",
      accountId: "a",
      inboxId: "i",
      eventId: "friend-activity",
      epoch: 1,
      fenceToken: "2",
      socketAttempt: 3,
      sequence: 4,
      occurredAt: "2026-11-20T02:00:00.000Z",
      activity,
    })
    expect(mocks.enqueueIntegrationJob).not.toHaveBeenCalled()
    expect(mocks.applyRuntime).not.toHaveBeenCalled()
  })
  it("keeps diagnostics separate from Connection transitions and publishes an accepted ID hint", async () => {
    mocks.applyDiagnostics.mockResolvedValueOnce(true)
    await handleZaloAccountEvents([
      {
        version: 1,
        eventId: "diagnostic",
        route: {
          kind: "account",
          workspaceId: "w",
          accountId: "a",
          inboxId: "i",
        },
        kind: "lifecycle",
        fenceToken: "4",
        epoch: 2,
        socketAttempt: 3,
        sequence: 5,
        occurredAt: new Date().toISOString(),
        payload: {
          type: "runtime_diagnostic",
          diagnostics: { phase: "backoff", reconnectCount: 1 },
        },
      },
    ])
    expect(mocks.applyDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        order: expect.objectContaining({ socketAttempt: 3, sequence: 5 }),
      }),
    )
    expect(mocks.applyRuntime).not.toHaveBeenCalled()
    expect(mocks.realtime).toHaveBeenCalledWith("w", {
      eventType: "zaloAccountStatusChanged",
      data: { accountId: "a" },
    })
  })
  it("publishes only an account ID after an accepted durable state change", async () => {
    const event = {
      version: 1 as const,
      eventId: "changed",
      kind: "lifecycle" as const,
      route: {
        kind: "account" as const,
        workspaceId: "w",
        accountId: "a",
        inboxId: "i",
      },
      fenceToken: "2",
      epoch: 1,
      socketAttempt: 1,
      sequence: 3,
      occurredAt: new Date().toISOString(),
      payload: { type: "connected" as const, zaloUid: "private-uid" },
    }
    mocks.applyRuntime.mockResolvedValueOnce(true)
    await handleZaloAccountEvents([event])
    expect(mocks.realtime).toHaveBeenCalledWith("w", {
      eventType: "zaloAccountStatusChanged",
      data: { accountId: "a" },
    })
    expect(mocks.applyRuntime).toHaveBeenCalledBefore(mocks.realtime)
    mocks.realtime.mockClear()
    mocks.applyRuntime.mockResolvedValueOnce(false)
    await handleZaloAccountEvents([event])
    expect(mocks.realtime).not.toHaveBeenCalled()
  })
  it.each([
    ["qr_declined", "provider_denied"],
    ["qr_expired", "expired"],
  ] as const)("terminalizes %s only for the scoped pending Zalo session", async (reason, errorCode) => {
    mocks.findSession.mockResolvedValue({
      id: "session-1",
      provider: "zaloAccount",
      status: "pending",
    })
    await handleZaloAccountEvents([
      {
        ...secretBase,
        kind: "lifecycle",
        payload: { type: "reauthorization_required", reason },
      },
    ])
    expect(mocks.failSession).toHaveBeenCalledWith({
      id: "session-1",
      workspaceId: "workspace-1",
      errorCode,
      statuses: ["pending"],
    })
    mocks.failSession.mockClear()
    mocks.findSession.mockResolvedValue({
      id: "session-1",
      provider: "zaloAccount",
      status: "completed",
    })
    await handleZaloAccountEvents([
      {
        ...secretBase,
        kind: "lifecycle",
        payload: { type: "reauthorization_required", reason },
      },
    ])
    expect(mocks.failSession).not.toHaveBeenCalled()
  })
  it("maps account lifecycle through the fenced durable connection service", async () => {
    await handleZaloAccountEvents([
      {
        version: 1,
        eventId: "runtime-event",
        route: {
          kind: "account",
          workspaceId: "w1",
          accountId: "a1",
          inboxId: "i1",
        },
        epoch: 3,
        fenceToken: "99",
        occurredAt: "2026-11-21T00:00:00.000Z",
        kind: "lifecycle",
        payload: { type: "closed", reason: "socket_closed" },
      },
    ])
    expect(mocks.applyRuntime).toHaveBeenCalledWith({
      workspaceId: "w1",
      accountId: "a1",
      inboxId: "i1",
      order: {
        epoch: 3,
        fenceToken: "99",
        occurredAt: "2026-11-21T00:00:00.000Z",
        state: "closed",
      },
    })
  })
  it("routes typed group bookkeeping with immutable policy epochs", async () => {
    const payload = {
      type: "reaction",
      threadType: "group",
      threadId: "g1",
      providerMessageId: "m1",
      actorId: "u1",
      reactionKey: "/-heart",
      operation: "add",
      timestampMs: 1_800_000_000_000,
      timestampSource: "provider",
    } as const
    await handleZaloAccountEvents([
      {
        version: 1,
        eventId: "state-event",
        route: {
          kind: "account",
          workspaceId: "w1",
          accountId: "a1",
          inboxId: "i1",
        },
        epoch: 1,
        fenceToken: "1",
        occurredAt: "2026-11-21T00:00:00.000Z",
        kind: "thread_event",
        accountPolicyEpoch: 2,
        groupPolicyEpoch: 3,
        payload,
      },
    ])
    expect(mocks.enqueueIntegrationJob).toHaveBeenCalledWith(
      {
        type: "zaloAccountThreadEvent",
        data: {
          workspaceId: "w1",
          accountId: "a1",
          inboxId: "i1",
          accountPolicyEpoch: 2,
          groupPolicyEpoch: 3,
          event: payload,
        },
      },
      expect.objectContaining({
        attempts: 5,
        jobId: expect.stringMatching(THREAD_EVENT_JOB_PATTERN),
      }),
    )
  })
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.realtime.mockResolvedValue(undefined)
  })
  it("routes group messages to a dedicated job with immutable policy epochs", async () => {
    await handleZaloAccountEvents([
      {
        version: 1,
        eventId: "group-event",
        route: {
          kind: "account",
          workspaceId: "w1",
          accountId: "a1",
          inboxId: "i1",
        },
        epoch: 1,
        fenceToken: "1",
        occurredAt: "2026-11-21T00:00:00.000Z",
        kind: "group_message",
        accountPolicyEpoch: 2,
        groupPolicyEpoch: 3,
        payload: {
          providerMessageId: "m1",
          threadId: "g1",
          threadType: "group",
          senderId: "member",
          timestampMs: 1,
          msgType: "webchat",
          isSelf: false,
          text: "hello",
          attachments: [],
          mentions: [],
        },
      },
    ])
    expect(mocks.enqueueIntegrationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "zaloAccountGroupMessage",
        data: expect.objectContaining({
          workspaceId: "w1",
          accountId: "a1",
          accountPolicyEpoch: 2,
          groupPolicyEpoch: 3,
        }),
      }),
      expect.objectContaining({
        jobId: expect.stringMatching(GROUP_MESSAGE_JOB_PATTERN),
      }),
    )
  })

  it.each([
    { route: { ...secretBase.route, workspaceId: "other-workspace" } },
    { route: { ...secretBase.route, sessionId: "other-session" } },
    { epoch: 2 },
    { fenceToken: "3" },
    { eventId: "other-event" },
    { socketAttempt: 1, sequence: 1 },
  ])("rejects altered secret envelope before decrypting: %j", async (change) => {
    await expect(
      handleZaloAccountEvents([
        { ...secretBase, secretKind: "qr_generated", ...change },
      ]),
    ).rejects.toThrow("encrypted event scope mismatch")
    expect(mocks.decryptObject).not.toHaveBeenCalled()
    expect(mocks.publishQr).not.toHaveBeenCalled()
    expect(mocks.completeTrusted).not.toHaveBeenCalled()
  })

  it("decrypts QR only inside the worker and publishes the session action", async () => {
    mocks.decryptObject.mockResolvedValueOnce({
      imageDataUrl: "data:image/png;base64,QUJD",
      expiresAt: "2026-11-20T02:01:00.000Z",
    })

    await handleZaloAccountEvents([
      { ...secretBase, secretKind: "qr_generated" },
    ])

    expect(mocks.decryptObject).toHaveBeenCalledWith(
      secretBase.ciphertext,
      expect.anything(),
      secretBase.aad,
    )
    expect(mocks.publishQr).toHaveBeenCalledWith({
      sessionId: "session-1",
      workspaceId: "workspace-1",
      provider: "zaloAccount",
      imageDataUrl: "data:image/png;base64,QUJD",
      expiresAt: "2026-11-20T02:01:00.000Z",
    })
  })

  it("uses the trusted completion path for gateway-verified authorization", async () => {
    const auth = {
      authType: "custom" as const,
      cookie: [{ key: "a", value: "b" }],
      imei: "imei",
      userAgent: "agent",
      zaloUid: "uid-1",
    }
    mocks.decryptObject.mockResolvedValueOnce({
      auth,
      displayName: "Jacky",
    })

    await handleZaloAccountEvents([
      {
        ...secretBase,
        eventId: "event-2",
        aad: "zalo-account:workspace-1:session-1:command-1:1:2:event-2",
        ciphertext: {
          ...secretBase.ciphertext,
          aad: "zalo-account:workspace-1:session-1:command-1:1:2:event-2",
        },
        secretKind: "authorization_obtained",
      },
    ])

    expect(mocks.completeTrusted).toHaveBeenCalledWith({
      sessionId: "session-1",
      workspaceId: "workspace-1",
      provider: "zaloAccount",
      auth,
      trustedProfile: { displayName: "Jacky", avatarUrl: undefined },
    })
  })

  it("clears the QR action after the scanned lifecycle event", async () => {
    await handleZaloAccountEvents([
      {
        version: 1,
        eventId: "event-3",
        route: secretBase.route,
        epoch: 1,
        fenceToken: "2",
        occurredAt: "2026-11-20T02:00:00.000Z",
        kind: "lifecycle",
        payload: { type: "qr_scanned", displayName: "Jacky" },
      },
    ])

    expect(mocks.markScanned).toHaveBeenCalledWith({
      sessionId: "session-1",
      workspaceId: "workspace-1",
      provider: "zaloAccount",
    })
  })

  it("bridges a direct message with its full persisted account route", async () => {
    const payload = {
      providerMessageId: "message-1",
      threadId: "peer-1",
      threadType: "user" as const,
      senderId: "peer-1",
      recipientId: "self-1",
      timestampMs: 1_763_596_800_000,
      msgType: "webchat",
      isSelf: false,
      text: "hello",
      attachments: [],
    }
    const route = {
      kind: "account" as const,
      workspaceId: "workspace-1",
      accountId: "account-1",
      inboxId: "inbox-1",
    }

    await handleZaloAccountEvents([
      {
        version: 1,
        eventId: "event-4",
        route,
        epoch: 1,
        fenceToken: "2",
        occurredAt: "2026-11-20T02:00:00.000Z",
        kind: "direct_message",
        payload,
      },
    ])

    expect(mocks.enqueueIntegrationJob).toHaveBeenCalledWith(
      {
        type: "incomingMessage",
        data: {
          integrationType: "zaloAccount",
          integrationIdentifier: "account-1",
          workspaceId: "workspace-1",
          zaloAccountRoute: route,
          payload,
        },
      },
      { jobId: expect.stringMatching(DIRECT_JOB_ID_PATTERN) },
    )
  })

  it("routes receipts and undo through canonical bookkeeping jobs", async () => {
    const route = {
      kind: "account" as const,
      workspaceId: "workspace-1",
      accountId: "account-1",
      inboxId: "inbox-1",
    }
    await handleZaloAccountEvents([
      {
        version: 1,
        eventId: "event-status",
        route,
        epoch: 1,
        fenceToken: "2",
        occurredAt: "2026-11-20T02:00:00.000Z",
        kind: "direct_status",
        payload: {
          providerMessageId: "message-1",
          threadId: "peer-1",
          status: "read",
          timestampMs: 1_763_596_800_000,
        },
      },
      {
        version: 1,
        eventId: "event-undo",
        route,
        epoch: 1,
        fenceToken: "2",
        occurredAt: "2026-11-20T02:00:00.000Z",
        kind: "direct_undo",
        payload: {
          providerMessageId: "message-1",
          threadId: "peer-1",
          timestampMs: 1_763_596_800_000,
        },
      },
    ])

    expect(mocks.enqueueIntegrationJob).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "messageStatus",
        data: expect.objectContaining({
          zaloAccountRoute: route,
          payload: expect.objectContaining({
            messageId: "za:account-1:user:peer-1:message-1",
            recipientId: "peer-1",
            status: "read",
          }),
        }),
      }),
      expect.objectContaining({
        jobId: expect.stringMatching(STATUS_JOB_ID_PATTERN),
      }),
    )
    expect(mocks.enqueueIntegrationJob).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "zaloAccountThreadEvent",
        data: expect.objectContaining({
          accountId: route.accountId,
          workspaceId: route.workspaceId,
          inboxId: route.inboxId,
          event: expect.objectContaining({
            type: "undo",
            threadType: "user",
            threadId: "peer-1",
            providerMessageId: "message-1",
            timestampSource: "observed",
          }),
        }),
      }),
      expect.objectContaining({
        jobId: expect.stringMatching(UNDO_JOB_ID_PATTERN),
      }),
    )
  })

  it("routes group activity only to the dedicated metadata refresh job", async () => {
    const route = {
      kind: "account" as const,
      workspaceId: "workspace-1",
      accountId: "account-1",
      inboxId: "inbox-1",
    }

    await handleZaloAccountEvents([
      {
        version: 1,
        eventId: "event-group",
        route,
        epoch: 1,
        fenceToken: "2",
        occurredAt: "2026-11-20T02:00:42.000Z",
        kind: "group_activity",
        payload: {
          providerGroupId: "group-1",
          providerMessageId: "message-1",
        },
      },
    ])

    expect(mocks.enqueueIntegrationJob).toHaveBeenCalledOnce()
    expect(mocks.enqueueIntegrationJob).toHaveBeenCalledWith(
      {
        type: "zaloAccountGroupRefresh",
        data: {
          workspaceId: "workspace-1",
          accountId: "account-1",
          providerGroupId: "group-1",
          commandId: expect.stringMatching(GROUP_REFRESH_JOB_ID_PATTERN),
        },
      },
      {
        jobId: expect.stringMatching(GROUP_REFRESH_JOB_ID_PATTERN),
        delay: 10_000,
      },
    )
    expect(mocks.enqueueIntegrationJob).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "incomingMessage" }),
      expect.anything(),
    )
    expect(mocks.enqueueIntegrationJob).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "channelAudienceEvent" }),
      expect.anything(),
    )
  })
})
