import { expect, it, vi } from "vitest"
import { createStickerResourceReader } from "../src/runtime/sticker-resource"

it("bounds sticker detail reads, variants, account cache and retains animation", async () => {
  const read = vi.fn(async (ids: number[]) =>
    ids.map((id) => ({
      id,
      cateId: 8,
      type: 7,
      version: 2,
      stickerUrl: "https://cdn.example.test/static.png",
      stickerWebpUrl: "https://cdn.example.test/animated.webp",
      stickerSpriteUrl: "https://cdn.example.test/sprite.png",
      totalFrames: 10,
      duration: 300,
    })),
  )
  const account = createStickerResourceReader(read)
  expect(await account(["1"])).toMatchObject([
    {
      stickerId: "1",
      categoryId: "8",
      stickerType: 7,
      frameCount: 10,
      frameDurationMs: 300,
      resources: [
        { slot: "static", animated: false },
        { animated: true },
        { role: "sprite", animated: true, frameCount: 10, durationMs: 300 },
      ],
    },
  ])
  await account(["1"])
  expect(read).toHaveBeenCalledTimes(1)
  await createStickerResourceReader(read)(["1"])
  expect(read).toHaveBeenCalledTimes(2)
  await expect(
    account(Array.from({ length: 21 }, (_, i) => String(i))),
  ).rejects.toThrow()
  await expect(account(["not-an-id"])).rejects.toThrow()
})

it("reads repeated IDs once per account and refreshes expired detail", async () => {
  let now = 10
  const read = vi.fn(async (ids: number[]) => ids.map((id) => ({ id })))
  const first = createStickerResourceReader(read, () => now)
  const second = createStickerResourceReader(read, () => now)

  await expect(first(["7", "7", "8"])).resolves.toMatchObject([
    { stickerId: "7" },
    { stickerId: "8" },
  ])
  expect(read).toHaveBeenNthCalledWith(1, [7, 8])
  await first(["7"])
  expect(read).toHaveBeenCalledTimes(1)
  await second(["7"])
  expect(read).toHaveBeenNthCalledWith(2, [7])
  now += 15 * 60 * 1000
  await first(["7"])
  expect(read).toHaveBeenNthCalledWith(3, [7])
})

it("returns an older cached sticker alongside a miss that evicts it", async () => {
  const read = vi.fn(async (ids: number[]) => ids.map((id) => ({ id })))
  const account = createStickerResourceReader(read)
  for (let start = 1; start <= 1000; start += 20) {
    await account(
      Array.from({ length: 20 }, (_, index) => String(start + index)),
    )
  }

  await expect(account(["1", "1001"])).resolves.toMatchObject([
    { stickerId: "1" },
    { stickerId: "1001" },
  ])
  expect(read).toHaveBeenLastCalledWith([1001])
  await account(["1"])
  expect(read).toHaveBeenLastCalledWith([1])
})
