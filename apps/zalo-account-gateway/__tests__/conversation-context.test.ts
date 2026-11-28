import { EventEmitter } from "node:events"
import { expect, it, vi } from "vitest"

const provider = vi.hoisted(() => ({ login: vi.fn() }))

vi.mock("@chatbotx.io/business", () => ({ assertPublicUrl: vi.fn() }))
vi.mock("zca-js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("zca-js")>()),
  Zalo: class {
    login = provider.login
  },
}))

import { normalizeProviderMessage } from "../src/runtime/provider-message"
import { zcaClientFactory } from "../src/runtime/zca-client"

const accountUid = "1001"
const groupId = "group-1"
const photoUrl = "https://cdn.example.test/photo.jpg"
const auth = {
  authType: "custom" as const,
  cookie: [{ key: "test", value: "test" }],
  imei: "imei",
  userAgent: "agent",
  zaloUid: accountUid,
}

const messageData = {
  msgId: "100",
  cliMsgId: "200",
  uidFrom: "2001",
  idTo: groupId,
  dName: "Customer",
  ts: "1763596800000",
}
const normalizeGroup = (data: object) =>
  normalizeProviderMessage(
    {
      type: 1,
      isSelf: false,
      threadId: groupId,
      data: { ...messageData, ...data },
    },
    { ownUid: accountUid, messageIntegrityEnabled: true },
  )

it("carries only explicit album identity and photo order into the normalized group message", () => {
  const result = normalizeGroup({
    msgType: "chat.photo",
    content: {
      href: photoUrl,
      desc: "caption",
      params: JSON.stringify({
        groupLayoutId: "provider-album",
        idInGroup: "1",
        totalItemInGroup: "3",
      }),
    },
  })

  expect(result).toMatchObject({
    kind: "group",
    providerMessageId: "100",
    message: {
      album: { layoutId: "provider-album", index: 1, itemCount: 3 },
      text: "caption",
    },
  })
})

it("ignores conflicting album layout IDs and leaves an image available independently", () => {
  const result = normalizeGroup({
    msgType: "chat.photo",
    content: {
      href: photoUrl,
      groupLayoutId: "conflicting-layout",
      idInGroup: 0,
      totalItemInGroup: 3,
    },
    propertyExt: {
      ext: JSON.stringify({
        groupMediaMsg: { groupLayoutId: "other-layout" },
      }),
    },
  })

  expect(result).toMatchObject({
    kind: "group",
    message: { attachments: [{ kind: "image", url: photoUrl }] },
  })
  expect(result).not.toHaveProperty("message.album")
})

it("uses the provider's quote type and bounded sender evidence without storing the raw attachment", () => {
  const result = normalizeGroup({
    msgType: "webchat",
    content: "reply",
    quote: {
      globalMsgId: 75,
      cliMsgId: 76,
      ownerId: "2002",
      senderName: "Mai",
      cliMsgType: 36,
      ts: "1763596800000",
      attach: '{ "privateUrl": "DO NOT PERSIST" }',
    },
  })
  expect(result).toMatchObject({
    kind: "group",
    message: {
      quote: {
        providerMessageId: "75",
        clientMessageId: "76",
        senderId: "2002",
        senderName: "Mai",
        msgType: "36",
        contentKind: "sticker",
      },
    },
  })
  expect(JSON.stringify(result)).not.toContain("DO NOT PERSIST")
})

const makeGroup = (
  setting: { lockSendMsg?: number; lockViewMember?: number } = {},
) => ({
  groupId,
  creatorId: "2001",
  adminIds: [],
  memberIds: [accountUid, "2001", "2002"],
  currentMems: [
    { id: "2001", dName: "Mai" },
    { id: "2002", dName: "Mai" },
    { id: "3001", dName: "Foreign profile" },
  ],
  hasMoreMember: 1,
  totalMember: 30,
  setting,
})

const login = async (group = makeGroup()) => {
  const sendMessage = vi.fn().mockResolvedValue({
    message: { msgId: "provider-sent" },
    attachment: [],
  })
  const getGroupInfo = vi.fn().mockResolvedValue({
    gridInfoMap: { [groupId]: group },
  })
  provider.login.mockResolvedValue({
    listener: new EventEmitter(),
    getOwnId: () => accountUid,
    sendMessage,
    getGroupInfo,
  })
  const client = await zcaClientFactory.create().login(auth)
  return { client, sendMessage, getGroupInfo }
}

it("uses UTF-16 mention offsets and checks the member against the current group", async () => {
  const { client, sendMessage, getGroupInfo } = await login()
  const text = "👩‍💻 ê @Mai, @Mai"
  const offset = text.lastIndexOf("@Mai")
  const content = {
    kind: "text" as const,
    text,
    mentions: [{ uid: "2002", offset, length: 4 }],
    styles: [{ start: 0, len: 5, st: "b" as const }],
  }
  const message = { recipientId: groupId, attachments: [], content }
  const admit = vi.fn().mockResolvedValue(undefined)

  await expect(client.sendGroup(groupId, message, admit)).resolves.toEqual({
    messageIds: ["provider-sent"],
    sentCount: 1,
  })
  expect(getGroupInfo).toHaveBeenCalledExactlyOnceWith(groupId)
  expect(admit).toHaveBeenCalledOnce()
  expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
    {
      msg: text,
      styles: content.styles,
      mentions: [{ uid: "2002", pos: offset, len: 4 }],
    },
    groupId,
    1,
  )
})

it.each([
  { uid: "3001", setting: {}, reason: "member" },
  { uid: "2002", setting: { lockSendMsg: 1 }, reason: "locked" },
  { uid: "-1", setting: {}, reason: "mention" },
])("rejects a $reason attempt before dispatch", async ({ uid, setting }) => {
  const { client, sendMessage } = await login(makeGroup(setting))
  const content = {
    kind: "text" as const,
    text: "@Mai",
    mentions: [{ uid, offset: 0, length: 4 }],
  }
  const message = { recipientId: groupId, attachments: [], content }
  await expect(client.sendGroup(groupId, message)).rejects.toMatchObject({
    name: "ZaloAccountPreDispatchError",
  })
  expect(sendMessage).not.toHaveBeenCalled()
})

it("returns an honest bounded roster for the selected group and excludes unrelated profiles", async () => {
  const { client, getGroupInfo } = await login()
  const read = client.getGroupMembers
  if (!read) {
    throw new Error("Group members reader unavailable")
  }
  await expect(read(groupId, { query: "mai", limit: 1 })).resolves.toEqual({
    members: [{ uid: "2001", name: "Mai" }],
    complete: false,
  })
  expect(getGroupInfo).toHaveBeenCalledExactlyOnceWith(groupId)
})
