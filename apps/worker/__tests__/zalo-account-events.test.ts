const THREAD_EVENT_JOB_PATTERN = /^zalo-thread-event-[a-f0-9]{64}$/
const GROUP_MESSAGE_JOB_PATTERN = /^zalo-group-message-[a-f0-9]+$/

import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  completeTrusted: vi.fn(),
  decryptObject: vi.fn(),
  enqueueIntegrationJob: vi.fn(),
  applyRuntime: vi.fn(),
  markScanned: vi.fn(),
  publishQr: vi.fn(),
  withBlockedOwnerGuard: vi.fn(
    async (_workspaceId: string, operation: () => Promise<unknown>) =>
      await operation(),
  ),
}))
vi.mock("@chatbotx.io/business/zalo-account/runtime-state", () => ({
  zaloAccountRuntimeStateService: { apply: mocks.applyRuntime },
}))

vi.mock("@chatbotx.io/business", () => ({
  withBlockedOwnerGuard: mocks.withBlockedOwnerGuard,
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
  aad: "aad-1",
  ciphertext: {
    v: 1 as const,
    kid: "active",
    iv: "000000000000000000000000",
    text: "aa",
    tag: "00000000000000000000000000000000",
    aad: "aad-1",
  },
}

describe("handleZaloAccountEvents", () => {
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
  beforeEach(() => vi.clearAllMocks())
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
      "aad-1",
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
        secretKind: "authorization_obtained",
      },
    ])

    expect(mocks.completeTrusted).toHaveBeenCalledWith({
      sessionId: "session-1",
      workspaceId: "workspace-1",
      provider: "zaloAccount",
      auth,
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
        type: "deleteIncomingMessage",
        data: expect.objectContaining({
          messageId: "za:account-1:user:peer-1:message-1",
          retryIfMissing: true,
          zaloAccountRoute: route,
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
