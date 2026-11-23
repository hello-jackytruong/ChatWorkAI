import { createReadStream } from "node:fs"
import { chmod, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sharp from "sharp"
import {
  MediaDownloadError,
  type SpooledMedia,
  spoolMedia,
} from "./bounded-download"

/** One still preview, bounded decoded pixels and dimensions. Original bytes are never written. */
export async function generateMediaPreview(
  original: SpooledMedia,
  signal?: AbortSignal,
): Promise<SpooledMedia> {
  if (!original.mime.startsWith("image/")) {
    throw new MediaDownloadError("mime_mismatch")
  }
  signal?.throwIfAborted()
  const dir = await mkdtemp(join(tmpdir(), "chatbotx-zalo-media-"))
  const output = join(dir, "preview.webp")
  const encoder = sharp(original.path, {
    limitInputPixels: 16_000_000,
    sequentialRead: true,
    animated: false,
  })
    .rotate()
    .resize({
      width: 1024,
      height: 1024,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 75, effort: 2 })
    .timeout({ seconds: 10 })
  const abort = () => encoder.destroy(new MediaDownloadError("timeout", true))
  signal?.addEventListener("abort", abort, { once: true })
  try {
    await encoder.toFile(output)
    signal?.throwIfAborted()
    await chmod(output, 0o600)
    if ((await stat(output)).size > 2 * 1024 * 1024) {
      throw new MediaDownloadError("size_limit")
    }
    return await spoolMedia(createReadStream(output), "preview", signal)
  } finally {
    signal?.removeEventListener("abort", abort)
    encoder.destroy()
    await rm(dir, { recursive: true, force: true })
  }
}
