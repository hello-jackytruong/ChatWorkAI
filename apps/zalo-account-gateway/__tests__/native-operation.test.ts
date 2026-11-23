import { describe, expect, it, vi } from "vitest"
import { invokeNativeOperation } from "../src/runtime/zca-client"

describe("native SDK invocation", () => {
  const operation = {
    operation: "undo" as const,
    attemptCommandId: "cmd",
    requestHash: "hash",
    threadType: "group" as const,
    threadId: "thread",
    providerMessageId: "global",
    providerClientMessageId: "cli",
    providerOwnerId: "owner",
  }
  it("uses exact provider and client IDs for undo", async () => {
    const api = {
      undo: vi.fn(async () => ({ status: 1 })),
      deleteMessage: vi.fn(),
      deleteChat: vi.fn(),
    }
    await invokeNativeOperation(api, operation)
    expect(api.undo).toHaveBeenCalledWith(
      { msgId: "global", cliMsgId: "cli" },
      "thread",
      1,
    )
  })
  it("always passes onlyMe true", async () => {
    const api = {
      undo: vi.fn(),
      deleteMessage: vi.fn(async () => ({ status: 1 })),
      deleteChat: vi.fn(),
    }
    await invokeNativeOperation(api, {
      ...operation,
      operation: "deleteMessage",
    })
    expect(api.deleteMessage).toHaveBeenCalledWith(
      {
        data: { msgId: "global", cliMsgId: "cli", uidFrom: "owner" },
        threadId: "thread",
        type: 1,
      },
      true,
    )
  })
  it("passes the immutable backwards boundary", async () => {
    const api = {
      undo: vi.fn(),
      deleteMessage: vi.fn(),
      deleteChat: vi.fn(async () => ({ status: 1 })),
    }
    await invokeNativeOperation(api, { ...operation, operation: "deleteChat" })
    expect(api.deleteChat).toHaveBeenCalledWith(
      { ownerId: "owner", cliMsgId: "cli", globalMsgId: "global" },
      "thread",
      1,
    )
  })
})

import {
  InMemoryCommandStateStore,
  ZaloAccountCommandExecutor,
} from "../src/transport/command-executor"

it("does not redispatch after Redis TTL loss or on unknown provider status", async () => {
  let claimed = false
  const nativeOperation = vi.fn(async ({ beforeDispatch }) =>
    (await beforeDispatch()) ? { status: 1 } : null,
  )
  const durable = {
    claimDispatch: vi.fn(() => {
      if (claimed) {
        return Promise.resolve(false)
      }
      claimed = true
      return Promise.resolve(true)
    }),
    settle: vi.fn(async () => undefined),
    outcome: vi.fn(async () => ({ status: "unknown" as const })),
  }
  const command = {
    version: 1,
    kind: "native_operation",
    commandId: "cmd",
    createdAt: "2026-11-20T00:00:00Z",
    expiresAt: "2026-11-20T00:01:00Z",
    route: { kind: "account", workspaceId: "w", accountId: "a", inboxId: "i" },
    target: { ownerId: "owner", fenceToken: "1" },
    nativeOperation: {
      operation: "undo",
      attemptCommandId: "cmd",
      requestHash: "hash",
      threadType: "user",
      threadId: "t",
      providerMessageId: "m",
      providerClientMessageId: "c",
      providerOwnerId: "o",
    },
  }
  for (let index = 0; index < 2; index++) {
    const executor = new ZaloAccountCommandExecutor({
      ownerId: "owner",
      now: () => new Date("2026-11-20T00:00:30Z"),
      stateStore: new InMemoryCommandStateStore(),
      pool: { nativeOperation } as never,
      nativeOperations: durable,
      nativeEnabled: true,
    })
    expect(await executor.execute(command)).toEqual({ status: "unknown" })
  }
  expect(durable.claimDispatch).toHaveBeenCalledTimes(2)
  expect(durable.settle).toHaveBeenCalledTimes(1)
})

it("keeps the provider disabled without the explicit gate", async () => {
  const nativeOperation = vi.fn()
  const claimDispatch = vi.fn()
  const executor = new ZaloAccountCommandExecutor({
    ownerId: "owner",
    now: () => new Date("2026-11-20T00:00:30Z"),
    stateStore: new InMemoryCommandStateStore(),
    pool: { nativeOperation } as never,
    nativeOperations: { claimDispatch, settle: vi.fn(), outcome: vi.fn() },
  })
  const outcome = await executor.execute({
    version: 1,
    kind: "native_operation",
    commandId: "cmd",
    createdAt: "2026-11-20T00:00:00Z",
    expiresAt: "2026-11-20T00:01:00Z",
    route: { kind: "account", workspaceId: "w", accountId: "a", inboxId: "i" },
    target: { ownerId: "owner", fenceToken: "1" },
    nativeOperation: {
      operation: "undo",
      attemptCommandId: "cmd",
      requestHash: "hash",
      threadType: "user",
      threadId: "t",
      providerMessageId: "m",
      providerClientMessageId: "c",
      providerOwnerId: "o",
    },
  })
  expect(outcome).toEqual({
    status: "failed",
    error: "native_operations_unavailable",
  })
  expect(claimDispatch).not.toHaveBeenCalled()
  expect(nativeOperation).not.toHaveBeenCalled()
})

it("rechecks expiry after waiting for the account serializer before claiming dispatch", async () => {
  let now = new Date("2026-11-20T00:00:30Z")
  const claimDispatch = vi.fn(async () => true)
  const nativeOperation = vi.fn(async ({ beforeDispatch }) => {
    now = new Date("2026-11-20T00:02:00Z")
    return (await beforeDispatch()) ? { status: 1 } : null
  })
  const executor = new ZaloAccountCommandExecutor({
    ownerId: "owner",
    now: () => now,
    stateStore: new InMemoryCommandStateStore(),
    pool: { nativeOperation } as never,
    nativeEnabled: true,
    nativeOperations: { claimDispatch, settle: vi.fn(), outcome: vi.fn() },
  })
  const outcome = await executor.execute({
    version: 1,
    kind: "native_operation",
    commandId: "cmd",
    createdAt: "2026-11-20T00:00:00Z",
    expiresAt: "2026-11-20T00:01:00Z",
    route: { kind: "account", workspaceId: "w", accountId: "a", inboxId: "i" },
    target: { ownerId: "owner", fenceToken: "1" },
    nativeOperation: {
      operation: "undo",
      attemptCommandId: "cmd",
      requestHash: "hash",
      threadType: "user",
      threadId: "t",
      providerMessageId: "m",
      providerClientMessageId: "c",
      providerOwnerId: "o",
    },
  })
  expect(outcome.status).toBe("failed")
  expect(claimDispatch).not.toHaveBeenCalled()
})

it("rechecks lease ownership at the durable dispatch boundary", async () => {
  const claimDispatch = vi.fn(async () => true)
  const ownsTarget = vi
    .fn()
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false)
  const nativeOperation = vi.fn(async ({ beforeDispatch }) =>
    (await beforeDispatch()) ? { status: 1 } : null,
  )
  const executor = new ZaloAccountCommandExecutor({
    ownerId: "owner",
    now: () => new Date("2026-11-20T00:00:30Z"),
    stateStore: new InMemoryCommandStateStore(),
    pool: { nativeOperation } as never,
    nativeEnabled: true,
    ownsTarget,
    nativeOperations: { claimDispatch, settle: vi.fn(), outcome: vi.fn() },
  })
  const outcome = await executor.execute({
    version: 1,
    kind: "native_operation",
    commandId: "cmd",
    createdAt: "2026-11-20T00:00:00Z",
    expiresAt: "2026-11-20T00:01:00Z",
    route: { kind: "account", workspaceId: "w", accountId: "a", inboxId: "i" },
    target: { ownerId: "owner", fenceToken: "1" },
    nativeOperation: {
      operation: "undo",
      attemptCommandId: "cmd",
      requestHash: "hash",
      threadType: "user",
      threadId: "t",
      providerMessageId: "m",
      providerClientMessageId: "c",
      providerOwnerId: "o",
    },
  })
  expect(outcome.status).toBe("failed")
  expect(claimDispatch).not.toHaveBeenCalled()
})
