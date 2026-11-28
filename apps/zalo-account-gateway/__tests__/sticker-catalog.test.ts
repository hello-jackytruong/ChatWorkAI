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

import { zcaClientFactory } from "../src/runtime/zca-client"

const staticUrl =
  "https://zalo-api.zadn.vn/api/emoticon/sticker/webpc?eid=892&size=130&version=3"
const spriteUrl =
  "https://zpsticke.zadn.vn/api/emoticon/sprite?eid=892&size=130"

const sticker = {
  id: 892,
  cateId: 0,
  type: 7,
  text: "Hi",
  totalFrames: 10,
  duration: 160,
  version: 3,
  stickerUrl: staticUrl,
  stickerSpriteUrl: spriteUrl,
  stickerWebpUrl:
    "https://zalo-api.zadn.vn/api/emoticon/sticker/webpc?eid=892&token=private",
}

const auth = {
  authType: "custom" as const,
  cookie: [{ key: "test", value: "test" }],
  imei: "imei",
  userAgent: "agent",
  zaloUid: "uid",
}
const login = async (sdk: object) => {
  provider.login.mockResolvedValue({ listener: new EventEmitter(), ...sdk })
  return await zcaClientFactory.create().login(auth)
}

const requireReader = async (sdk: object) => {
  const client = await login(sdk)
  if (!client.getStickerCatalog) {
    throw new Error("Sticker catalog reader unavailable")
  }
  return client.getStickerCatalog
}

it("normalizes keyword results and projects approved provider previews only", async () => {
  const searchSticker = vi.fn().mockResolvedValue([
    { sticker_id: 892, cate_id: 0, type: 7 },
    { sticker_id: 892, cate_id: 0, type: 7 },
    { sticker_id: 0, cate_id: 0, type: 7 },
  ])
  const getStickersDetail = vi.fn().mockResolvedValue([sticker])
  const read = await requireReader({ searchSticker, getStickersDetail })
  await expect(
    read({ kind: "search", query: "hi", limit: 20 }),
  ).resolves.toEqual([
    {
      stickerId: "892",
      categoryId: "0",
      stickerType: 7,
      title: "Hi",
      frameCount: 10,
      frameDurationMs: 160,
      staticUrl,
      spriteUrl,
    },
  ])
  expect(searchSticker).toHaveBeenCalledExactlyOnceWith("hi", 20)
  expect(getStickersDetail).toHaveBeenCalledExactlyOnceWith([892])
})

it("can fall back to suggestion IDs without confusing them with search rows", async () => {
  const searchSticker = vi.fn().mockResolvedValue([])
  const getStickers = vi.fn().mockResolvedValue([892, 892, 400])
  const getStickersDetail = vi.fn().mockResolvedValue([sticker])
  const read = await requireReader({
    searchSticker,
    getStickers,
    getStickersDetail,
  })
  await expect(
    read({ kind: "search", query: "hello", limit: 1 }),
  ).resolves.toMatchObject([
    { stickerId: "892", categoryId: "0", stickerType: 7 },
  ])
  expect(getStickers).toHaveBeenCalledExactlyOnceWith("hello")
  expect(getStickersDetail).toHaveBeenCalledExactlyOnceWith([892])
})

it("loads a selected pack without looking up every row again", async () => {
  const getStickerCategoryDetail = vi.fn().mockResolvedValue([
    { ...sticker, cateId: 5 },
    {
      ...sticker,
      id: 893,
      cateId: 5,
      stickerUrl: "https://other.example.test",
    },
  ])
  const getStickersDetail = vi.fn()
  const read = await requireReader({
    getStickerCategoryDetail,
    getStickersDetail,
  })
  await expect(
    read({ kind: "category", categoryId: "5", limit: 1 }),
  ).resolves.toMatchObject([{ stickerId: "892", categoryId: "5" }])
  expect(getStickerCategoryDetail).toHaveBeenCalledExactlyOnceWith(5)
  expect(getStickersDetail).not.toHaveBeenCalled()
})

it("sends the selected sticker identity through the admitted native group send", async () => {
  const sendSticker = vi.fn().mockResolvedValue({ msgId: 987 })
  const admit = vi.fn(() => {
    expect(sendSticker).not.toHaveBeenCalled()
    return Promise.resolve()
  })
  const client = await login({ sendSticker })

  await expect(
    client.sendGroup(
      "group-1",
      {
        recipientId: "group-1",
        attachments: [],
        content: {
          kind: "sticker",
          stickerId: "892",
          categoryId: "0",
          stickerType: 7,
        },
      },
      admit,
    ),
  ).resolves.toEqual({ messageIds: ["987"], sentCount: 1 })
  expect(admit).toHaveBeenCalledOnce()
  expect(sendSticker).toHaveBeenCalledExactlyOnceWith(
    { id: 892, cateId: 0, type: 7 },
    "group-1",
    1,
  )
})
