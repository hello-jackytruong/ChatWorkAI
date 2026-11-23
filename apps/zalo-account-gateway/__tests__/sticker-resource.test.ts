import { expect, it, vi } from "vitest"
import { createStickerResourceReader } from "../src/runtime/sticker-resource"

it("bounds sticker detail reads, variants, account cache and retains animation", async () => {
  const read = vi.fn(async (ids: number[]) =>
    ids.map((id) => ({
      id,
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
      resources: [
        { animated: true },
        { animated: true },
        { role: "sprite", animated: true },
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
