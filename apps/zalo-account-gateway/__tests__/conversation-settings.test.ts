import { describe, expect, it, vi } from "vitest"
import { runProviderConversationSettings } from "../src/runtime/conversation-settings"

type Provider = Parameters<typeof runProviderConversationSettings>[0]
const group = { threadId: "900000000000000018", threadType: "group" as const }
const direct = { ...group, threadType: "user" as const }

function provider() {
  const getPinConversations = vi.fn(async () => ({
    conversations: [`u${group.threadId}`, "g123"],
    version: 21,
  }))
  const getMute = vi.fn(async () => ({
    chatEntries: [
      {
        id: group.threadId,
        duration: -1,
        startTime: 120,
        systemTime: 120,
        currentTime: 120,
        muteMode: 1,
      },
    ],
    groupChatEntries: [
      {
        id: group.threadId,
        duration: 3600,
        startTime: 120,
        systemTime: 120,
        currentTime: 180,
        muteMode: 1,
      },
    ],
  }))
  const getArchivedChatList = vi.fn(async () => ({
    items: [{ id: group.threadId, type: 0 }],
    version: 21,
  }))
  const getUnreadMark = vi.fn(async () => ({
    status: 0,
    data: {
      convsGroup: [
        { id: group.threadId, cliMsgId: "77", fromUid: "0", ts: 12 },
      ],
      convsUser: [
        { id: "22", cliMsgId: group.threadId, fromUid: group.threadId, ts: 12 },
      ],
    },
  }))
  const getAutoDeleteChat = vi.fn(async () => ({
    convers: [
      { destId: group.threadId, isGroup: true, ttl: 86_400_000, createdAt: 10 },
      { destId: group.threadId, isGroup: false, ttl: 0, createdAt: 10 },
    ],
  }))
  const getHiddenConversations = vi.fn(async () => ({
    pin: "secret-pin",
    threads: [{ is_group: 0, thread_id: group.threadId }],
  }))
  const setPinnedConversations = vi.fn(async () => "")
  const setMute = vi.fn(async () => "")
  const updateArchivedChatList = vi.fn(async () => ({
    needResync: true,
    version: 22,
  }))
  const addUnreadMark = vi.fn(async () => ({
    status: 0,
    data: { updateId: 25 },
  }))
  const removeUnreadMark = vi.fn(async () => ({
    status: 0,
    data: { updateId: 26 },
  }))
  const updateAutoDeleteChat = vi.fn(async () => "")
  const setHiddenConversations = vi.fn(async () => "")
  const updateHiddenConversPin = vi.fn(async () => "")
  const resetHiddenConversPin = vi.fn(async () => "")
  const authorize = vi.fn(async () => undefined)
  const methods = {
    getPinConversations,
    getMute,
    getArchivedChatList,
    getUnreadMark,
    getAutoDeleteChat,
    getHiddenConversations,
    setPinnedConversations,
    setMute,
    updateArchivedChatList,
    addUnreadMark,
    removeUnreadMark,
    updateAutoDeleteChat,
    setHiddenConversations,
    updateHiddenConversPin,
    resetHiddenConversPin,
  }
  return { ...methods, api: methods as unknown as Provider, authorize }
}

describe("native Zalo conversation settings adapter", () => {
  it("reads each field once and projects only exact typed thread values for group and direct chat", async () => {
    const mock = provider()
    await expect(
      runProviderConversationSettings(
        mock.api,
        group,
        { kind: "readConversationSettings" },
        mock.authorize,
      ),
    ).resolves.toEqual({
      kind: "readConversationSettings",
      outcome: "confirmed",
      conversation: {
        pinned: false,
        muteSeconds: 3600,
        archived: false,
        unread: true,
        autoDeleteMs: 86_400_000,
        hidden: false,
      },
    })
    for (const read of [
      mock.getPinConversations,
      mock.getMute,
      mock.getArchivedChatList,
      mock.getUnreadMark,
      mock.getAutoDeleteChat,
      mock.getHiddenConversations,
    ]) {
      expect(read).toHaveBeenCalledOnce()
    }
    const result = await runProviderConversationSettings(
      mock.api,
      direct,
      { kind: "readConversationSettings" },
      mock.authorize,
    )
    expect(result).toEqual({
      kind: "readConversationSettings",
      outcome: "confirmed",
      conversation: {
        pinned: true,
        muteSeconds: -1,
        archived: true,
        unread: false,
        autoDeleteMs: 0,
        hidden: true,
      },
    })
    expect(JSON.stringify(result)).not.toContain("secret-pin")
    expect(JSON.stringify(result)).not.toContain(group.threadId)
    expect(mock.authorize).not.toHaveBeenCalled()
  })

  it("leaves malformed archive, ambiguous pins and failed mute reads unknown without discarding other fields", async () => {
    const mock = provider()
    mock.getPinConversations.mockResolvedValueOnce({
      conversations: [group.threadId],
      version: 20,
    })
    mock.getArchivedChatList.mockResolvedValueOnce({
      items: [{ otherId: "123", type: 0 } as never],
      version: 21,
    })
    mock.getMute.mockRejectedValueOnce(new Error("provider details"))
    const result = await runProviderConversationSettings(
      mock.api,
      group,
      { kind: "readConversationSettings" },
      mock.authorize,
    )
    expect(result).toEqual({
      kind: "readConversationSettings",
      outcome: "partial",
      conversation: { unread: true, autoDeleteMs: 86_400_000, hidden: false },
    })
    expect(JSON.stringify(result)).not.toContain("provider details")
  })

  it("limits an opened panel to three concurrent provider reads", async () => {
    const mock = provider()
    const archive = Promise.withResolvers<{
      items: { id: string; type: number }[]
      version: number
    }>()
    mock.getArchivedChatList.mockReturnValueOnce(archive.promise)
    const result = runProviderConversationSettings(
      mock.api,
      group,
      { kind: "readConversationSettings" },
      mock.authorize,
    )
    expect(mock.getPinConversations).toHaveBeenCalledOnce()
    expect(mock.getMute).toHaveBeenCalledOnce()
    expect(mock.getArchivedChatList).toHaveBeenCalledOnce()
    expect(mock.getUnreadMark).not.toHaveBeenCalled()
    expect(mock.getAutoDeleteChat).not.toHaveBeenCalled()
    expect(mock.getHiddenConversations).not.toHaveBeenCalled()
    archive.resolve({ items: [], version: 2 })
    await expect(result).resolves.toMatchObject({ outcome: "confirmed" })
    expect(mock.getUnreadMark).toHaveBeenCalledOnce()
    expect(mock.getAutoDeleteChat).toHaveBeenCalledOnce()
    expect(mock.getHiddenConversations).toHaveBeenCalledOnce()
  })

  it("does not confuse an unsafe numeric unread ID with an exact large provider UID", async () => {
    const mock = provider()
    mock.getUnreadMark.mockResolvedValueOnce({
      status: 0,
      data: {
        convsGroup: [
          {
            id: Number(group.threadId) as never,
            cliMsgId: "77",
            fromUid: "0",
            ts: 12,
          },
        ],
        convsUser: [],
      },
    })
    const result = await runProviderConversationSettings(
      mock.api,
      group,
      { kind: "readConversationSettings" },
      mock.authorize,
    )
    expect(result.outcome).toBe("partial")
    expect(result.conversation).not.toHaveProperty("unread")
  })

  it("projects hidden threads without ever reading the PIN property", async () => {
    const mock = provider()
    const readPin = vi.fn(() => "secret-pin")
    const hiddenResponse = {
      pin: "",
      threads: [{ is_group: 1, thread_id: group.threadId }],
    }
    Object.defineProperty(hiddenResponse, "pin", { get: readPin })
    mock.getHiddenConversations.mockResolvedValueOnce(hiddenResponse)
    await expect(
      runProviderConversationSettings(
        mock.api,
        group,
        { kind: "readConversationSettings" },
        mock.authorize,
      ),
    ).resolves.toMatchObject({
      conversation: { hidden: true },
    })
    expect(readPin).not.toHaveBeenCalled()
  })

  it("writes archive once on needResync and confirms only a fresh typed readback", async () => {
    const mock = provider()
    mock.getArchivedChatList.mockResolvedValueOnce({
      items: [{ id: group.threadId, type: 1 }],
      version: 22,
    })
    await expect(
      runProviderConversationSettings(
        mock.api,
        group,
        { kind: "setArchived", enabled: true },
        mock.authorize,
      ),
    ).resolves.toEqual({
      kind: "setArchived",
      outcome: "confirmed",
      conversation: { archived: true },
    })
    expect(mock.updateArchivedChatList).toHaveBeenCalledExactlyOnceWith(true, {
      id: group.threadId,
      type: 1,
    })
    expect(mock.getArchivedChatList).toHaveBeenCalledOnce()
    expect(mock.authorize).toHaveBeenCalledBefore(mock.updateArchivedChatList)
    expect(mock.updateArchivedChatList).toHaveBeenCalledBefore(
      mock.getArchivedChatList,
    )
    expect(mock.getPinConversations).not.toHaveBeenCalled()
    expect(mock.getHiddenConversations).not.toHaveBeenCalled()
  })

  it("does not confirm an archive response from an older provider version or a failed write", async () => {
    const mock = provider()
    mock.getArchivedChatList.mockResolvedValueOnce({
      items: [{ id: group.threadId, type: 1 }],
      version: 20,
    })
    await expect(
      runProviderConversationSettings(
        mock.api,
        group,
        { kind: "setArchived", enabled: true },
        mock.authorize,
      ),
    ).resolves.toEqual({ kind: "setArchived", outcome: "unknown" })
    mock.updateArchivedChatList.mockRejectedValueOnce(
      new Error("sensitive timeout"),
    )
    await expect(
      runProviderConversationSettings(
        mock.api,
        group,
        { kind: "setArchived", enabled: true },
        mock.authorize,
      ),
    ).resolves.toEqual({ kind: "setArchived", outcome: "unknown" })
    expect(mock.updateArchivedChatList).toHaveBeenCalledTimes(2)
    expect(mock.getArchivedChatList).toHaveBeenCalledOnce()
  })

  it("sends mute seconds and native auto-delete milliseconds without substituting CRM status", async () => {
    const mock = provider()
    await expect(
      runProviderConversationSettings(
        mock.api,
        group,
        { kind: "setMute", durationSeconds: 3600 },
        mock.authorize,
      ),
    ).resolves.toEqual({
      kind: "setMute",
      outcome: "confirmed",
      conversation: { muteSeconds: 3600 },
    })
    expect(mock.setMute).toHaveBeenCalledExactlyOnceWith(
      { action: 1, duration: 3600 },
      group.threadId,
      1,
    )
    await expect(
      runProviderConversationSettings(
        mock.api,
        group,
        { kind: "setAutoDelete", ttlMs: 86_400_000 },
        mock.authorize,
      ),
    ).resolves.toEqual({
      kind: "setAutoDelete",
      outcome: "confirmed",
      conversation: { autoDeleteMs: 86_400_000 },
    })
    expect(mock.updateAutoDeleteChat).toHaveBeenCalledExactlyOnceWith(
      86_400_000,
      group.threadId,
      1,
    )
  })

  it("writes the exact type for pin and unread changes and only reads back their own setting", async () => {
    const mock = provider()
    mock.getPinConversations.mockResolvedValueOnce({
      conversations: [`g${group.threadId}`],
      version: 23,
    })
    await expect(
      runProviderConversationSettings(
        mock.api,
        group,
        { kind: "setPinned", enabled: true },
        mock.authorize,
      ),
    ).resolves.toEqual({
      kind: "setPinned",
      outcome: "confirmed",
      conversation: { pinned: true },
    })
    mock.getUnreadMark.mockResolvedValueOnce({
      status: 0,
      data: {
        convsGroup: [],
        convsUser: [
          { id: group.threadId, cliMsgId: "77", fromUid: "0", ts: 12 },
        ],
      },
    })
    await expect(
      runProviderConversationSettings(
        mock.api,
        group,
        { kind: "setUnread", enabled: false },
        mock.authorize,
      ),
    ).resolves.toEqual({
      kind: "setUnread",
      outcome: "confirmed",
      conversation: { unread: false },
    })
    expect(mock.setPinnedConversations).toHaveBeenCalledExactlyOnceWith(
      true,
      group.threadId,
      1,
    )
    expect(mock.removeUnreadMark).toHaveBeenCalledExactlyOnceWith(
      group.threadId,
      1,
    )
    expect(mock.addUnreadMark).not.toHaveBeenCalled()
    expect(mock.getPinConversations).toHaveBeenCalledOnce()
    expect(mock.getUnreadMark).toHaveBeenCalledOnce()
    expect(mock.getMute).not.toHaveBeenCalled()
  })

  it("does not call a write when the exact conversation loses authorization at dispatch", async () => {
    const mock = provider()
    mock.authorize.mockRejectedValueOnce(new Error("stale scope"))
    await expect(
      runProviderConversationSettings(
        mock.api,
        group,
        { kind: "setHidden", enabled: true },
        mock.authorize,
      ),
    ).rejects.toThrow("stale scope")
    expect(mock.setHiddenConversations).not.toHaveBeenCalled()
    expect(mock.getHiddenConversations).not.toHaveBeenCalled()
    expect(mock.updateHiddenConversPin).not.toHaveBeenCalled()
    expect(mock.resetHiddenConversPin).not.toHaveBeenCalled()
  })
})
