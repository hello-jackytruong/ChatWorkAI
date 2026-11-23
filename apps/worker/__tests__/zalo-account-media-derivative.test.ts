import { createReadStream } from "node:fs"
import { Readable } from "node:stream"
import sharp from "sharp"
import { expect, it, vi } from "vitest"

vi.mock("@chatbotx.io/filesystem", () => ({ uploader: {} }))

import { spoolMedia } from "../src/zalo-account-media/bounded-download"
import { generateMediaPreview } from "../src/zalo-account-media/derivative"

it("makes a separate bounded preview while retaining exact original SHA", async () => {
  const original = await sharp({
    create: { width: 1600, height: 1200, channels: 3, background: "red" },
  })
    .png()
    .toBuffer()
  const staged = await spoolMedia(Readable.from([original]), "image")
  const preview = await generateMediaPreview(staged)
  expect(preview.path).not.toBe(staged.path)
  expect(preview.mime).toBe("image/webp")
  expect(preview.size).toBeLessThanOrEqual(2 * 1024 * 1024)
  const meta = await sharp(preview.path).metadata()
  expect(meta.width).toBeLessThanOrEqual(1024)
  const rehashed = await spoolMedia(createReadStream(staged.path), "image")
  expect(rehashed.sha256).toBe(staged.sha256)
  await Promise.all([preview.cleanup(), staged.cleanup(), rehashed.cleanup()])
})
