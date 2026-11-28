import { encryptUtils } from "@chatbotx.io/encryption"
import type {
  ZaloAccountCommandEnvelope,
  ZaloAccountGroup,
  ZaloAccountLabelSnapshot,
} from "@chatbotx.io/sdk"
import {
  ZaloAccountPreDispatchError,
  zaloAccountNativeToolResultSchema,
} from "@chatbotx.io/sdk"
import { describe, expect, it, vi } from "vitest"
import { ZaloAccountHistoryPageError } from "../src/runtime/history-page"
import type { ZaloAccountPool } from "../src/runtime/zalo-account-pool"
import {
  commandStateKey,
  InMemoryCommandStateStore,
  ZaloAccountCommandExecutor,
} from "../src/transport/command-executor"
import type { ProviderAdmissionPort } from "../src/transport/provider-admission"

const reconnectCommand: ZaloAccountCommandEnvelope = {
  version: 1,
  commandId: "command-1",
  kind: "reconnect",
  route: {
    kind: "account",
    workspaceId: "workspace-1",
    accountId: "account-1",
    inboxId: "inbox-1",
  },
  createdAt: "2026-11-20T02:00:00.000Z",
  expiresAt: "2026-11-20T02:01:00.000Z",
}

const historyCommand = {
  ...reconnectCommand,
  kind: "fetch_history_page",
  target: { ownerId: "owner-1", fenceToken: "7" },
  history: { threadType: "user", threadId: "peer-1" },
} as const

const historyPage = {
  messages: [],
  providerRowCount: 0,
  invalidRowCount: 0,
  providerExhausted: true,
  fingerprint: "a".repeat(64),
}

const groupReadCommand = {
  ...reconnectCommand,
  kind: "read_group_administration",
  commandId: "group-read-1",
  target: { ownerId: "owner-1", fenceToken: "7" },
  groupId: "provider-group-1",
  accountPolicyEpoch: 2,
  groupPolicyEpoch: 3,
  groupRead: { kind: "overview" },
} as const

const groupAdministration = {
  kind: "overview",
  overview: { name: "Team", accessible: true, role: "owner" },
} as const

const makeHarness = (admission?: ProviderAdmissionPort) => {
  const groupManagement = {
    admit: vi.fn(async () => undefined),
    claimDispatch: vi.fn(async () => true),
    settle: vi.fn(async () => undefined),
  }
  const pool = {
    fetchHistoryPage: vi.fn<ZaloAccountPool["fetchHistoryPage"]>(
      async () => historyPage,
    ),
    getGroupMembers: vi.fn(async () => ({ members: [], complete: true })),
    readGroupAdministration: vi.fn(async () => groupAdministration),
    groupManagement: vi.fn<ZaloAccountPool["groupManagement"]>(
      async ({ operation, authorizeDispatch }) => {
        await authorizeDispatch()
        return { kind: operation.kind, outcome: "confirmed" }
      },
    ),
    nativeTool: vi.fn<ZaloAccountPool["nativeTool"]>(
      async ({ operation, authorizeDispatch }) => {
        await authorizeDispatch()
        return { kind: operation.kind, outcome: "confirmed" }
      },
    ),
    getStickerCatalog: vi.fn(async () => []),
    getStickerResources: vi.fn(async () => []),
    getLabels: vi.fn(
      async (): Promise<ZaloAccountLabelSnapshot> => ({
        labelData: [],
        version: 0,
        lastUpdateTime: 0,
      }),
    ),
    listGroups: vi.fn(async (): Promise<ZaloAccountGroup[]> => []),
    listFriends: vi.fn(async () => ({ friends: [], complete: true })),
    reconnect: vi.fn(async () => ({ status: "started" as const })),
    sendDirect: vi.fn(async () => ({
      status: "sent" as const,
      messageIds: ["provider-1"],
      sentCount: 1,
    })),
    sendGroup: vi.fn(async () => ({
      status: "sent" as const,
      messageIds: ["provider-group-1"],
      sentCount: 1,
    })),
    sendTyping: vi.fn(async () => undefined),
    startQr: vi.fn(async () => ({ status: "started" as const })),
    stop: vi.fn(async () => undefined),
    updateLabels: vi.fn(async ({ labelData, expectedVersion }) => ({
      labelData,
      version: expectedVersion + 1,
      lastUpdateTime: 1,
    })),
  }
  const stateStore = new InMemoryCommandStateStore()
  const ownsTarget = vi.fn(async () => true)
  const executor = new ZaloAccountCommandExecutor({
    admission,
    groupManagement,
    nativeTool: groupManagement,
    now: () => new Date("2026-11-20T02:00:30.000Z"),
    ownerId: "owner-1",
    pool,
    stateStore,
    ownsTarget,
  })
  return { executor, ownsTarget, pool, stateStore, groupManagement }
}

describe("ZaloAccountCommandExecutor", () => {
  it.each([
    "groupManagement",
    "nativeTool",
  ] as const)("does not dispatch %s after claiming if account ownership was lost", async (kind) => {
    const { executor, ownsTarget, pool, groupManagement } = makeHarness()
    const providerWrite = vi.fn()
    let owned = true
    ownsTarget.mockImplementation(() => Promise.resolve(owned))
    groupManagement.claimDispatch.mockImplementation(() => {
      owned = false
      return Promise.resolve(true)
    })
    if (kind === "groupManagement") {
      pool.groupManagement.mockImplementation(
        async ({ operation, authorizeDispatch }) => {
          await authorizeDispatch()
          providerWrite()
          return { kind: operation.kind, outcome: "confirmed" }
        },
      )
    } else {
      pool.nativeTool.mockImplementation(
        async ({ operation, authorizeDispatch }) => {
          await authorizeDispatch()
          providerWrite()
          return { kind: operation.kind, outcome: "confirmed" }
        },
      )
    }
    const base = {
      ...reconnectCommand,
      target: { ownerId: "owner-1", fenceToken: "7" },
      accountPolicyEpoch: 2,
      attemptCommandId: "1795140030000:f9cc28e5-7124-412c-a54c-d6871987c73e",
    }
    const command =
      kind === "groupManagement"
        ? {
            ...base,
            kind: "group_management" as const,
            groupId: "known-group",
            providerGroupId: "99",
            groupPolicyEpoch: 3,
            groupManagement: {
              kind: "changeGroupName" as const,
              name: "Updated",
            },
          }
        : {
            ...base,
            kind: "native_tool" as const,
            conversationId: "conversation",
            contactInboxId: "anchor",
            thread: { threadType: "user" as const, threadId: "42" },
            nativeTool: { kind: "setUnread" as const, enabled: true },
          }
    const outcome = await executor.execute(command)
    expect(providerWrite).not.toHaveBeenCalled()
    expect(outcome.status).toBe("applied")
    if (outcome.status !== "applied") {
      throw new Error("Expected an applied result envelope")
    }
    if (kind === "groupManagement") {
      expect(outcome.result.groupManagement).toMatchObject({
        outcome: "unknown",
      })
    } else {
      const ciphertext = outcome.result.nativeToolCiphertext
      if (!ciphertext) {
        throw new Error("Expected an encrypted native tool result")
      }
      expect(outcome.result).not.toHaveProperty("nativeTool")
      await expect(
        encryptUtils.decryptObject(
          ciphertext,
          zaloAccountNativeToolResultSchema,
        ),
      ).resolves.toMatchObject({
        kind: "setUnread",
        outcome: "unknown",
      })
    }
    expect(groupManagement.settle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ dispatched: true }),
      expect.objectContaining({ outcome: "unknown" }),
    )
    await executor.execute(command)
    expect(groupManagement.claimDispatch).toHaveBeenCalledOnce()
  })
  it("uses the scoped durable claim before a group write and keeps uncertain writes inspectable", async () => {
    const { executor, groupManagement, pool } = makeHarness()
    const input = {
      ...reconnectCommand,
      kind: "group_management",
      commandId: "scoped-redis-id",
      target: { ownerId: "owner-1", fenceToken: "7" },
      accountPolicyEpoch: 1,
      attemptCommandId: "1795140000000:8e250019-f49e-4d18-99fb-5d7ff7b7f047",
      groupManagement: {
        kind: "createGroup",
        name: "Support",
        memberUids: ["1"],
      },
    } as const
    pool.groupManagement.mockImplementationOnce(
      async ({ authorizeDispatch }) => {
        await authorizeDispatch()
        throw new Error("Provider response interrupted")
      },
    )
    const outcome = await executor.execute(input)
    expect(outcome).toMatchObject({
      status: "applied",
      result: { groupManagement: { kind: "createGroup", outcome: "unknown" } },
    })
    expect(groupManagement.claimDispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        commandId: input.attemptCommandId,
        fenceToken: "7",
      }),
    )
    expect(groupManagement.settle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        commandId: input.attemptCommandId,
        dispatched: true,
      }),
      expect.objectContaining({ outcome: "unknown" }),
    )
    await expect(executor.execute(input)).resolves.toEqual(outcome)
    expect(pool.groupManagement).toHaveBeenCalledOnce()
  })
  it("routes a fenced group administration read with the scoped group policy", async () => {
    const { executor, pool } = makeHarness()

    await expect(executor.execute(groupReadCommand)).resolves.toEqual({
      status: "applied",
      result: { status: "synced", groupAdministration },
    })
    expect(pool.readGroupAdministration).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        inboxId: "inbox-1",
        groupId: "provider-group-1",
        accountPolicyEpoch: 2,
        groupPolicyEpoch: 3,
        groupRead: { kind: "overview" },
      }),
    )
  })

  it("does not read group administration from a stale account lease", async () => {
    const { executor, ownsTarget, pool } = makeHarness()
    ownsTarget.mockResolvedValue(false)

    await expect(executor.execute(groupReadCommand)).resolves.toEqual({
      status: "rejected_stale",
    })
    expect(pool.readGroupAdministration).not.toHaveBeenCalled()
  })
  it("returns a history page only after the targeted lease is rechecked", async () => {
    const { executor, ownsTarget, pool } = makeHarness()
    pool.fetchHistoryPage.mockImplementation(async ({ authorizeLease }) => {
      await authorizeLease()
      await authorizeLease()
      return historyPage
    })

    await expect(executor.execute(historyCommand)).resolves.toEqual({
      status: "applied",
      result: { status: "synced", historyPage },
    })
    expect(ownsTarget).toHaveBeenCalledTimes(3)
    expect(pool.fetchHistoryPage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        inboxId: "inbox-1",
        history: historyCommand.history,
      }),
    )
  })

  it("returns the safe history failure code and never retries a timed-out socket request", async () => {
    const { executor, pool } = makeHarness()
    pool.fetchHistoryPage.mockRejectedValueOnce(
      new ZaloAccountHistoryPageError("history_timeout"),
    )

    await expect(executor.execute(historyCommand)).resolves.toMatchObject({
      status: "failed",
      error: "history_timeout",
    })
    expect(pool.fetchHistoryPage).toHaveBeenCalledTimes(1)
  })

  it("rejects group history with no policy epochs or a synthetic cursor", async () => {
    const { executor, pool } = makeHarness()
    await expect(
      executor.execute({
        ...historyCommand,
        history: { threadType: "group", threadId: "group-1" },
      }),
    ).rejects.toThrow()
    await expect(
      executor.execute({
        ...historyCommand,
        history: {
          threadType: "group",
          threadId: "group-1",
          accountPolicyEpoch: 1,
          groupPolicyEpoch: 2,
          cursor: "unused-action-id",
        },
      }),
    ).rejects.toThrow()
    expect(pool.fetchHistoryPage).not.toHaveBeenCalled()
  })

  it("dispatches a catalog read for the targeted account and sticker pack", async () => {
    const { executor, pool } = makeHarness()
    const stickerCatalogQuery = {
      kind: "category" as const,
      categoryId: "40",
      limit: 5,
    }
    await expect(
      executor.execute({
        ...reconnectCommand,
        kind: "get_sticker_catalog",
        target: { ownerId: "owner-1", fenceToken: "1" },
        stickerCatalogQuery,
      }),
    ).resolves.toEqual({
      status: "applied",
      result: { status: "synced", stickerCatalog: [] },
    })
    expect(pool.getStickerCatalog).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        inboxId: "inbox-1",
        runtime: { kind: "account", id: "account-1" },
        query: stickerCatalogQuery,
      }),
    )
  })

  it("dispatches best-effort typing with the exact group policy context", async () => {
    const { executor, pool } = makeHarness()
    await expect(
      executor.execute({
        ...reconnectCommand,
        commandId: "typing-1",
        kind: "send_typing",
        threadType: "group",
        threadId: "g1",
        accountPolicyEpoch: 1,
        groupPolicyEpoch: 2,
        target: { ownerId: "owner-1", fenceToken: "7" },
      }),
    ).resolves.toMatchObject({ status: "applied" })
    expect(pool.sendTyping).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "g1",
        threadType: "group",
        accountPolicyEpoch: 1,
        groupPolicyEpoch: 2,
      }),
    )
  })
  it("classifies a fenced group admission rejection as failed rather than unknown", async () => {
    const admission = {
      check: () => 0,
      recordFailure: vi.fn(),
      recordSuccess: vi.fn(),
    }
    const { executor, pool } = makeHarness(admission)
    pool.sendGroup.mockRejectedValueOnce(
      new ZaloAccountPreDispatchError("Group policy changed"),
    )
    await expect(
      executor.execute({
        ...reconnectCommand,
        commandId: "stale-group",
        kind: "send_group",
        groupId: "g1",
        accountPolicyEpoch: 1,
        groupPolicyEpoch: 2,
        target: { ownerId: "owner-1", fenceToken: "7" },
        message: { recipientId: "g1", text: "hello", attachments: [] },
      }),
    ).resolves.toMatchObject({
      status: "failed",
      errorInfo: { code: "pre_dispatch_failed" },
    })
    expect(pool.sendGroup).toHaveBeenCalledWith(
      expect.objectContaining({ accountPolicyEpoch: 1, groupPolicyEpoch: 2 }),
    )
    expect(admission.recordFailure).not.toHaveBeenCalled()
  })
  it("dispatches a scoped reconnect to the account pool", async () => {
    const { executor, pool } = makeHarness()

    await expect(executor.execute(reconnectCommand)).resolves.toMatchObject({
      status: "applied",
      result: { status: "started" },
    })
    expect(pool.reconnect).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      runtime: { kind: "account", id: "account-1" },
      inboxId: "inbox-1",
      commandId: "command-1",
    })
  })

  it("does not execute the same command twice", async () => {
    const { executor, pool } = makeHarness()

    await executor.execute(reconnectCommand)
    await expect(executor.execute(reconnectCommand)).resolves.toMatchObject({
      status: "applied",
    })
    expect(pool.reconnect).toHaveBeenCalledTimes(1)
  })

  it("rejects a mailbox command targeting another owner", async () => {
    const { executor, pool } = makeHarness()

    await expect(
      executor.execute({
        ...reconnectCommand,
        target: { ownerId: "owner-2", epoch: 1, fenceToken: "3" },
      }),
    ).resolves.toMatchObject({ status: "rejected_stale" })
    expect(pool.reconnect).not.toHaveBeenCalled()
  })

  it("stops a fenced temporary connect-session runtime", async () => {
    const { executor, pool } = makeHarness()

    await expect(
      executor.execute({
        ...reconnectCommand,
        commandId: "cancel-session-1",
        kind: "stop",
        route: {
          kind: "connect_session",
          workspaceId: "workspace-1",
          sessionId: "session-1",
        },
        target: { ownerId: "owner-1", fenceToken: "4" },
      }),
    ).resolves.toMatchObject({
      status: "applied",
      result: { status: "stopped" },
    })
    expect(pool.stop).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      runtime: { kind: "connect_session", id: "session-1" },
      commandId: "cancel-session-1",
    })
  })

  it("rejects a command whose owner matches but whose fence is stale", async () => {
    const { executor, ownsTarget, pool } = makeHarness()
    ownsTarget.mockResolvedValueOnce(false)

    await expect(
      executor.execute({
        ...reconnectCommand,
        target: { ownerId: "owner-1", epoch: 2, fenceToken: "7" },
      }),
    ).resolves.toMatchObject({ status: "rejected_stale" })

    expect(ownsTarget).toHaveBeenCalledWith(
      expect.objectContaining({ commandId: "command-1" }),
    )
    expect(pool.reconnect).not.toHaveBeenCalled()
  })

  it("turns a previously claimed command into unknown instead of replaying it", async () => {
    const { executor, pool, stateStore } = makeHarness()
    await stateStore.claim(commandStateKey(reconnectCommand), 60_000)

    await expect(executor.execute(reconnectCommand)).resolves.toMatchObject({
      status: "unknown",
    })
    expect(pool.reconnect).not.toHaveBeenCalled()
  })

  it("rejects work before provider invocation while admission is paused", async () => {
    const admission: ProviderAdmissionPort = {
      check: vi.fn(() => 15_000),
      recordFailure: vi.fn(),
      recordSuccess: vi.fn(),
    }
    const { executor, pool } = makeHarness(admission)

    await expect(executor.execute(reconnectCommand)).resolves.toMatchObject({
      status: "failed",
      error: "Zalo Account provider admission is paused; retry after 15000ms",
    })

    expect(pool.reconnect).not.toHaveBeenCalled()
    expect(admission.recordFailure).not.toHaveBeenCalled()
  })

  it("dispatches a fenced direct send exactly once", async () => {
    const { executor, pool } = makeHarness()
    const command: ZaloAccountCommandEnvelope = {
      ...reconnectCommand,
      commandId: "client-send-1",
      kind: "send_direct",
      target: { ownerId: "owner-1", fenceToken: "7" },
      message: {
        recipientId: "peer-1",
        text: "hello",
        attachments: [],
      },
    }

    await expect(executor.execute(command)).resolves.toMatchObject({
      status: "applied",
      result: {
        status: "sent",
        messageIds: ["provider-1"],
        sentCount: 1,
      },
    })
    await executor.execute(command)

    expect(pool.sendDirect).toHaveBeenCalledTimes(1)
    expect(pool.sendDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: { kind: "account", id: "account-1" },
        message: expect.objectContaining({ recipientId: "peer-1" }),
      }),
    )
  })

  it("records a provider send failure as ambiguous and never replays it", async () => {
    const { executor, pool } = makeHarness()
    const command: ZaloAccountCommandEnvelope = {
      ...reconnectCommand,
      commandId: "client-send-ambiguous",
      kind: "send_direct",
      target: { ownerId: "owner-1", fenceToken: "7" },
      message: {
        recipientId: "peer-1",
        text: "hello",
        attachments: [],
      },
    }
    pool.sendDirect.mockRejectedValueOnce(new Error("connection reset"))

    await expect(executor.execute(command)).resolves.toEqual({
      status: "unknown",
    })
    await expect(executor.execute(command)).resolves.toEqual({
      status: "unknown",
    })

    expect(pool.sendDirect).toHaveBeenCalledTimes(1)
  })

  it("discovers groups through the fenced account runtime", async () => {
    const { executor, pool } = makeHarness()
    pool.listGroups.mockResolvedValueOnce([
      {
        providerGroupId: "group-1",
        name: "Operators",
        memberCount: 3,
      },
    ])

    await expect(
      executor.execute({
        ...reconnectCommand,
        commandId: "sync-groups-1",
        kind: "sync_groups",
        target: { ownerId: "owner-1", fenceToken: "7" },
      }),
    ).resolves.toMatchObject({
      status: "applied",
      result: {
        groups: [{ providerGroupId: "group-1", name: "Operators" }],
      },
    })
    expect(pool.listGroups).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: { kind: "account", id: "account-1" },
      }),
    )
  })

  it("sends to an explicit group through the fenced account runtime", async () => {
    const { executor, pool } = makeHarness()

    await expect(
      executor.execute({
        ...reconnectCommand,
        commandId: "send-group-1",
        kind: "send_group",
        accountPolicyEpoch: 1,
        groupPolicyEpoch: 2,
        groupId: "group-1",
        target: { ownerId: "owner-1", fenceToken: "7" },
        message: {
          recipientId: "group-1",
          text: "hello group",
          attachments: [],
        },
      }),
    ).resolves.toMatchObject({
      status: "applied",
      result: {
        status: "sent",
        messageIds: ["provider-group-1"],
        sentCount: 1,
      },
    })
    expect(pool.sendGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: "group-1",
        runtime: { kind: "account", id: "account-1" },
      }),
    )
  })

  it("reads and updates the complete label document through the fenced runtime", async () => {
    const { executor, pool } = makeHarness()
    const label = {
      id: 1,
      text: "Priority",
      textKey: "priority",
      conversations: ["user-1"],
      color: "#0068FF",
      offset: 0,
      emoji: "",
      createTime: 1,
    }
    pool.getLabels.mockResolvedValueOnce({
      labelData: [label],
      version: 4,
      lastUpdateTime: 10,
    })

    await expect(
      executor.execute({
        ...reconnectCommand,
        commandId: "labels-read-1",
        kind: "get_labels",
        target: { ownerId: "owner-1", fenceToken: "7" },
      }),
    ).resolves.toMatchObject({
      status: "applied",
      result: { labels: { version: 4, labelData: [label] } },
    })

    await executor.execute({
      ...reconnectCommand,
      commandId: "labels-write-1",
      kind: "update_labels",
      target: { ownerId: "owner-1", fenceToken: "7" },
      expectedVersion: 4,
      labelData: [label],
    })
    expect(pool.updateLabels).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: 4, labelData: [label] }),
    )
  })
})

it("dispatches bounded sticker reads through the owned account runtime", async () => {
  const { executor, pool } = makeHarness()
  const command = {
    ...reconnectCommand,
    kind: "get_sticker_resources",
    stickerIds: ["123"],
    target: { ownerId: "owner-1", epoch: 1, fenceToken: "1" },
  }
  expect(await executor.execute(command)).toEqual({
    status: "applied",
    result: { status: "synced", stickerResources: [] },
  })
  expect(pool.getStickerResources).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "workspace-1",
      runtime: { kind: "account", id: "account-1" },
      stickerIds: ["123"],
    }),
  )
})

it("retries pure reads once within the same claim and rechecks ownership", async () => {
  const { executor, pool, ownsTarget } = makeHarness()
  pool.listGroups.mockRejectedValueOnce(new Error("network secret"))
  const command = {
    ...reconnectCommand,
    kind: "sync_groups",
    target: { ownerId: "owner-1", fenceToken: "1" },
  }
  expect(await executor.execute(command)).toMatchObject({ status: "applied" })
  expect(pool.listGroups).toHaveBeenCalledTimes(2)
  expect(ownsTarget).toHaveBeenCalledTimes(2)
})
it("keeps stop available while provider admission is paused", async () => {
  const { executor, pool } = makeHarness({
    check: () => 15_000,
    recordFailure: vi.fn(),
    recordSuccess: vi.fn(),
  })
  expect(
    await executor.execute({
      ...reconnectCommand,
      kind: "stop",
      target: { ownerId: "owner-1", fenceToken: "1" },
    }),
  ).toMatchObject({ status: "applied" })
  expect(pool.stop).toHaveBeenCalledOnce()
})

it("retries sticker resource reads within the bounded read policy", async () => {
  const { executor, pool } = makeHarness()
  pool.getStickerResources.mockRejectedValueOnce(new Error("network"))
  expect(
    await executor.execute({
      ...reconnectCommand,
      kind: "get_sticker_resources",
      stickerIds: ["123"],
      target: { ownerId: "owner-1", fenceToken: "1" },
    }),
  ).toMatchObject({ status: "applied" })
  expect(pool.getStickerResources).toHaveBeenCalledTimes(2)
})
