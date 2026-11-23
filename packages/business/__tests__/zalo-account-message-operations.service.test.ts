import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  resolveTarget: vi.fn(),
  prepare: vi.fn(),
  find: vi.fn(),
  dispatch: vi.fn(),
  settle: vi.fn(),
  transaction: vi.fn(),
  record: vi.fn(),
  bindPointer: vi.fn(),
  claimDispatch: vi.fn(),
  workspaceLock: vi.fn(),
  targetLock: vi.fn(),
  group: vi.fn(),
}))
vi.mock("../src/zalo-account/message-recall.service", () => ({
  zaloAccountMessageRecallService: { resolveTarget: mocks.resolveTarget },
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  zaloAccountNativeOperationAttemptRepository: {
    prepare: mocks.prepare,
    find: mocks.find,
    settle: mocks.settle,
    transaction: mocks.transaction,
    claimDispatch: mocks.claimDispatch,
  },
  zaloAccountMessageRecallRepository: {
    record: mocks.record,
    bindPointer: mocks.bindPointer,
  },
  integrationZaloAccountGroupRepository: { findByProviderId: mocks.group },
  workspaceRepository: { lockWorkspaceForChildWrite: mocks.workspaceLock },
  lockZaloAccountMessageTarget: mocks.targetLock,
}))
vi.mock("../src/zalo-account/transport.service", () => ({
  zaloAccountCommandTransportService: {
    nativeOperationAndWait: mocks.dispatch,
  },
}))

import { zaloAccountMessageOperationsService as service } from "../src/zalo-account/message-operations.service"

const input = {
  workspaceId: "w",
  accountId: "a",
  conversationId: "c",
  messageId: "m",
  messageCreatedAt: new Date(),
  commandId: "cmd",
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.workspaceLock.mockResolvedValue(true)
  vi.stubEnv("ZALO_ACCOUNT_NATIVE_MESSAGE_OPERATIONS_ENABLED", "true")
  mocks.resolveTarget.mockResolvedValue({
    account: { inboxId: "i", zaloUid: "owner" },
    conversation: { id: "c" },
    contactInbox: { id: "ci" },
    message: {
      id: "m",
      createdAt: input.messageCreatedAt,
      messageType: "outgoing",
      contentAttributes: {
        zaloAccount: {
          providerMessageId: "p",
          clientMessageId: "cli",
          senderId: "owner",
        },
      },
    },
    target: {
      workspaceId: "w",
      accountId: "a",
      inboxId: "i",
      threadType: "user",
      threadId: "t",
      providerMessageId: "p",
    },
  })
})
it("fails closed when flag is the string false", async () => {
  vi.stubEnv("ZALO_ACCOUNT_NATIVE_MESSAGE_OPERATIONS_ENABLED", "false")
  await expect(service.recall(input)).rejects.toThrow()
  expect(mocks.dispatch).not.toHaveBeenCalled()
})
it("does not synthesize a client ID", async () => {
  const context = await mocks.resolveTarget()
  context.message.contentAttributes.zaloAccount.clientMessageId = undefined
  await expect(service.recall(input)).rejects.toThrow()
  expect(mocks.prepare).not.toHaveBeenCalled()
})
it("rejects recalling nonself targets", async () => {
  const context = await mocks.resolveTarget()
  context.message.contentAttributes.zaloAccount.senderId = "someone"
  await expect(service.recall(input)).rejects.toThrow()
  expect(mocks.dispatch).not.toHaveBeenCalled()
})
it("does not redispatch unknown outcomes", async () => {
  mocks.prepare.mockResolvedValue({
    ...input,
    id: "operation",
    operation: "undo",
    status: "unknown",
    errorCode: null,
  })
  const result = await service.recall(input)
  expect(result.status).toBe("unknown")
  expect(mocks.dispatch).not.toHaveBeenCalled()
})

it("records confirmed recall obligation in the same transaction as applied", async () => {
  const tx = { transaction: "main", execute: vi.fn() }
  mocks.transaction.mockImplementation((fn) => fn(tx))
  mocks.settle.mockResolvedValue({
    ...input,
    id: "op",
    inboxId: "i",
    contactInboxId: "ci",
    operation: "undo",
    threadType: "user",
    threadId: "t",
    providerMessageId: "p",
  })
  const command = {
    commandId: "cmd",
    route: { workspaceId: "w", accountId: "a", inboxId: "i" },
    nativeOperation: { requestHash: "h" },
    target: { fenceToken: "7" },
  } as never
  await service.gatewaySettle(command, "applied", 1)
  expect(mocks.settle).toHaveBeenCalledWith(
    expect.objectContaining({ status: "applied", tx }),
  )
  expect(mocks.record).toHaveBeenCalledWith(
    expect.objectContaining({
      transition: "recall",
      providerMessageId: "p",
      tx,
    }),
  )
  expect(mocks.bindPointer).toHaveBeenCalledWith(
    expect.objectContaining({ messageId: "m", tx }),
  )
})
it("deleteChat confirmation never hides or removes CRM messages", async () => {
  mocks.transaction.mockImplementation((fn) => fn({ execute: vi.fn() }))
  mocks.settle.mockResolvedValue({
    ...input,
    id: "op",
    operation: "deleteChat",
  })
  await service.gatewaySettle(
    {
      commandId: "cmd",
      route: { workspaceId: "w", accountId: "a" },
      nativeOperation: { requestHash: "h" },
      target: { fenceToken: "7" },
    } as never,
    "applied",
    1,
  )
  expect(mocks.record).not.toHaveBeenCalled()
  expect(mocks.bindPointer).not.toHaveBeenCalled()
})
it("refuses a command whose provider pair differs from its immutable attempt", async () => {
  mocks.find.mockResolvedValue({
    requestHash: "h",
    inboxId: "i",
    operation: "undo",
    threadType: "user",
    threadId: "t",
    providerMessageId: "p",
    providerClientMessageId: "cli",
    providerOwnerId: "owner",
  })
  await expect(
    service.gatewayClaim({
      commandId: "cmd",
      route: { workspaceId: "w", accountId: "a", inboxId: "i" },
      nativeOperation: {
        requestHash: "h",
        operation: "undo",
        threadType: "user",
        threadId: "t",
        providerMessageId: "p",
        providerClientMessageId: "wrong",
        providerOwnerId: "owner",
      },
      target: { fenceToken: "7" },
    } as never),
  ).rejects.toThrow("target conflict")
  expect(mocks.claimDispatch).not.toHaveBeenCalled()
})

it("dispatches an exact delete-only-me target with a scoped transport command", async () => {
  const row = {
    ...input,
    id: "op",
    operation: "deleteMessage",
    status: "pending",
    errorCode: null,
  }
  mocks.prepare.mockResolvedValue(row)
  mocks.find.mockResolvedValue({ ...row, status: "unknown" })
  await service.deleteOnZalo(input)
  expect(mocks.dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      commandId: expect.stringContaining("zalo-native-operation-"),
      nativeOperation: expect.objectContaining({
        operation: "deleteMessage",
        attemptCommandId: "cmd",
        providerMessageId: "p",
        providerClientMessageId: "cli",
        providerOwnerId: "owner",
      }),
    }),
  )
})
it("persists the selected chat boundary before dispatch without CRM deletion", async () => {
  mocks.prepare.mockImplementation((value) =>
    Promise.resolve({ ...value, id: "op", status: "pending", errorCode: null }),
  )
  mocks.find.mockResolvedValue(null)
  const outcome = await service.deleteChatOnZalo({
    ...input,
    boundaryMessageId: input.messageId,
    boundaryCreatedAt: input.messageCreatedAt,
  })
  expect(mocks.prepare).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: "deleteChat",
      messageId: "m",
      messageCreatedAt: input.messageCreatedAt,
      providerMessageId: "p",
    }),
  )
  expect(outcome.boundary).toEqual({
    messageId: "m",
    createdAt: input.messageCreatedAt.toISOString(),
  })
  expect(mocks.record).not.toHaveBeenCalled()
})
it("returns a same-command request conflict before dispatch", async () => {
  mocks.prepare.mockRejectedValue(new Error("request hash conflict"))
  await expect(service.recall(input)).rejects.toThrow("request hash conflict")
  expect(mocks.dispatch).not.toHaveBeenCalled()
})
it("reports capabilities only after target authorization", async () => {
  expect(await service.getCapabilities(input)).toEqual({
    enabled: true,
    canRecall: true,
  })
  mocks.resolveTarget.mockRejectedValue(new Error("denied"))
  await expect(service.getCapabilities(input)).rejects.toThrow("denied")
})

it("locks workspace then exact target before settling a confirmed group obligation", async () => {
  const tx = { execute: vi.fn() }
  mocks.transaction.mockImplementation((fn) => fn(tx))
  mocks.settle.mockResolvedValue({
    ...input,
    id: "op",
    inboxId: "i",
    contactInboxId: "ci",
    operation: "undo",
    threadType: "group",
    threadId: "g",
    providerMessageId: "p",
  })
  mocks.group.mockResolvedValue({
    id: "group-row",
    contactInboxId: "ci",
    conversationId: "c",
    accessible: false,
    sendEnabled: false,
  })
  await service.gatewaySettle(
    {
      commandId: "transport",
      route: { workspaceId: "w", accountId: "a", inboxId: "i" },
      nativeOperation: {
        attemptCommandId: "cmd",
        requestHash: "h",
        threadType: "group",
        threadId: "g",
        providerMessageId: "p",
      },
      target: { fenceToken: "7" },
    } as never,
    "applied",
    1,
  )
  expect(mocks.record).toHaveBeenCalledWith(
    expect.objectContaining({ threadType: "group", groupId: "group-row", tx }),
  )
  expect(mocks.workspaceLock.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.targetLock.mock.invocationCallOrder[0] ?? Number.NaN,
  )
  expect(mocks.targetLock.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.settle.mock.invocationCallOrder[0] ?? Number.NaN,
  )
  expect(mocks.group).toHaveBeenCalledWith(
    { workspaceId: "w", accountId: "a", providerGroupId: "g" },
    tx,
  )
})
it("never settles or creates an obligation after workspace purge starts", async () => {
  mocks.transaction.mockImplementation((fn) => fn({ execute: vi.fn() }))
  mocks.workspaceLock.mockResolvedValue(false)
  await expect(
    service.gatewaySettle(
      {
        route: { workspaceId: "w", accountId: "a" },
        nativeOperation: { attemptCommandId: "cmd" },
        target: { fenceToken: "7" },
      } as never,
      "applied",
      1,
    ),
  ).rejects.toThrow("purged")
  expect(mocks.settle).not.toHaveBeenCalled()
  expect(mocks.record).not.toHaveBeenCalled()
})
