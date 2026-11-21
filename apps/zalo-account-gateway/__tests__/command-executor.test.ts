import type {
  ZaloAccountCommandEnvelope,
  ZaloAccountGroup,
  ZaloAccountLabelSnapshot,
} from "@chatbotx.io/sdk"
import { ZaloAccountPreDispatchError } from "@chatbotx.io/sdk"
import { describe, expect, it, vi } from "vitest"
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

const makeHarness = (admission?: ProviderAdmissionPort) => {
  const pool = {
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
    now: () => new Date("2026-11-20T02:00:30.000Z"),
    ownerId: "owner-1",
    pool,
    stateStore,
    ownsTarget,
  })
  return { executor, ownsTarget, pool, stateStore }
}

describe("ZaloAccountCommandExecutor", () => {
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
    ).resolves.toEqual({ status: "failed", error: "Group policy changed" })
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

    await expect(executor.execute(reconnectCommand)).resolves.toEqual({
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
