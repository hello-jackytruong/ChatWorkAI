import { createHash } from "node:crypto"
import { lookup } from "node:dns/promises"
import { createWriteStream } from "node:fs"
import { mkdtemp, opendir, rm, stat } from "node:fs/promises"
import { request } from "node:https"
import { BlockList, isIP } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { uploader } from "@chatbotx.io/filesystem"

export type MediaKind =
  | "image"
  | "gif"
  | "file"
  | "video"
  | "audio"
  | "avatar"
  | "cover"
  | "thumbnail"
  | "poster"
  | "preview"
  | "sticker"
const MiB = 1024 * 1024
export const MEDIA_BYTE_LIMITS: Record<MediaKind, number> = {
  image: 10 * MiB,
  gif: 10 * MiB,
  file: 25 * MiB,
  video: 64 * MiB,
  audio: 16 * MiB,
  avatar: 2 * MiB,
  cover: 2 * MiB,
  thumbnail: 2 * MiB,
  poster: 2 * MiB,
  preview: 2 * MiB,
  sticker: 8 * MiB,
}
export class MediaDownloadError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly retryAfterMs?: number
  constructor(code: string, retryable = false, retryAfterMs?: number) {
    super(`Zalo media transport: ${code}`)
    this.name = "MediaDownloadError"
    this.code = code
    this.retryable = retryable
    this.retryAfterMs = retryAfterMs
  }
}
const blocked = new BlockList()
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) {
  blocked.addSubnet(address, prefix, "ipv4")
}
const globalV6 = new BlockList()
globalV6.addSubnet("2000::", 3, "ipv6")
blocked.addSubnet("2001::", 23, "ipv6")
blocked.addSubnet("2001:db8::", 32, "ipv6")
blocked.addSubnet("2002::", 16, "ipv6")
blocked.addSubnet("3fff::", 20, "ipv6")
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    return !blocked.check(address, "ipv4")
  }
  return (
    family === 6 &&
    globalV6.check(address, "ipv6") &&
    !blocked.check(address, "ipv6")
  )
}

// Unknown provider hosts are rejected until fixtures have established their ownership.
export function validateProviderUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new MediaDownloadError("unsafe_url")
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.hash ||
    !(url.hostname === "zdn.vn" || url.hostname.endsWith(".zdn.vn"))
  ) {
    throw new MediaDownloadError("unsafe_url")
  }
  return url
}

export function sniffMedia(bytes: Buffer): { mime: string; extension: string } {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return { mime: "image/png", extension: "png" }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", extension: "jpg" }
  }
  if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) {
    return { mime: "image/gif", extension: "gif" }
  }
  if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { mime: "image/webp", extension: "webp" }
  }
  if (bytes.toString("ascii", 4, 8) === "ftyp") {
    const audio = ["M4A ", "M4B "].includes(bytes.toString("ascii", 8, 12))
    return {
      mime: audio ? "audio/mp4" : "video/mp4",
      extension: audio ? "m4a" : "mp4",
    }
  }
  if (bytes.toString("ascii", 0, 4) === "OggS") {
    return { mime: "audio/ogg", extension: "ogg" }
  }
  if (
    bytes.toString("ascii", 0, 3) === "ID3" ||
    (bytes[0] === 0xff && (bytes[1] ?? 0) >= 0xe0)
  ) {
    return { mime: "audio/mpeg", extension: "mp3" }
  }
  if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WAVE"
  ) {
    return { mime: "audio/wav", extension: "wav" }
  }
  if (bytes.toString("ascii", 0, 5) === "%PDF-") {
    return { mime: "application/pdf", extension: "pdf" }
  }
  if (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 3 &&
    bytes[3] === 4
  ) {
    return { mime: "application/zip", extension: "zip" }
  }
  return { mime: "application/octet-stream", extension: "bin" }
}
export type SpooledMedia = {
  path: string
  size: number
  sha256: string
  mime: string
  extension: string
  cleanup: () => Promise<void>
}
export async function spoolMedia(
  stream: Readable,
  kind: MediaKind,
  signal?: AbortSignal,
  contentLength?: number,
): Promise<SpooledMedia> {
  const limit = MEDIA_BYTE_LIMITS[kind]
  if (
    !limit ||
    (contentLength !== undefined &&
      (!Number.isSafeInteger(contentLength) ||
        contentLength < 0 ||
        contentLength > limit))
  ) {
    stream.destroy()
    throw new MediaDownloadError("size_limit")
  }
  const dir = await mkdtemp(join(tmpdir(), "chatbotx-zalo-media-"))
  const path = join(dir, "original")
  const cleanup = () => rm(dir, { recursive: true, force: true })
  let size = 0
  let prefix = Buffer.alloc(0)
  const hash = createHash("sha256")
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length
      if (size > limit) {
        callback(new MediaDownloadError("size_limit"))
        return
      }
      hash.update(chunk)
      if (prefix.length < 512) {
        prefix = Buffer.concat([prefix, chunk.subarray(0, 512 - prefix.length)])
      }
      callback(null, chunk)
    },
  })
  try {
    await pipeline(
      stream,
      meter,
      createWriteStream(path, { mode: 0o600, flags: "wx" }),
      { signal },
    )
    if (!size) {
      throw new MediaDownloadError("empty_body", true)
    }
    if (contentLength !== undefined && size !== contentLength) {
      throw new MediaDownloadError("truncated_body", true)
    }
    const detected = sniffMedia(prefix)
    let family: string | undefined = "image/"
    if (kind === "file") {
      family = undefined
    }
    if (kind === "audio") {
      family = "audio/"
    }
    if (kind === "video") {
      family = "video/"
    }
    if (family && !detected.mime.startsWith(family)) {
      throw new MediaDownloadError("mime_mismatch")
    }
    return { path, size, sha256: hash.digest("hex"), ...detected, cleanup }
  } catch (error) {
    stream.destroy()
    await cleanup()
    throw error
  }
}

async function providerStream(
  value: string,
  signal: AbortSignal,
  redirects = 0,
): Promise<{ stream: Readable; contentLength?: number }> {
  const url = validateProviderUrl(value)
  const addresses = await withMediaDeadline(
    lookup(url.hostname, { all: true, verbatim: true }),
    signal,
  )
  signal.throwIfAborted()
  if (
    !addresses.length ||
    addresses.some(({ address }) => !isPublicAddress(address))
  ) {
    throw new MediaDownloadError("unsafe_dns")
  }
  const pinned = addresses[0]
  const response = await new Promise<import("node:http").IncomingMessage>(
    (resolve, reject) => {
      const req = request(
        url,
        {
          signal,
          agent: false,
          family: pinned.family,
          headers: { "Accept-Encoding": "identity" },
          lookup: (_hostname, _options, callback) =>
            callback(null, pinned.address, pinned.family),
        },
        resolve,
      )
      const connectDeadline = setTimeout(
        () => req.destroy(new MediaDownloadError("timeout", true)),
        10_000,
      )
      connectDeadline.unref()
      req.once("socket", (socket) =>
        socket.once("secureConnect", () => clearTimeout(connectDeadline)),
      )
      req.once("response", () => clearTimeout(connectDeadline))
      req.once("error", () => clearTimeout(connectDeadline))
      req.setTimeout(10_000, () =>
        req.destroy(new MediaDownloadError("timeout", true)),
      )
      req.on("error", reject)
      req.end()
    },
  )
  const status = response.statusCode ?? 0
  if ([301, 302, 303, 307, 308].includes(status)) {
    response.destroy()
    if (redirects >= 3 || !response.headers.location) {
      throw new MediaDownloadError("unsafe_redirect")
    }
    return providerStream(
      new URL(response.headers.location, url).href,
      signal,
      redirects + 1,
    )
  }
  if (status < 200 || status >= 300) {
    response.destroy()
    const retry = status === 408 || status === 429 || status >= 500
    const raw = response.headers["retry-after"]
    const seconds = raw ? Number(raw) : Number.NaN
    let delay: number | undefined
    if (raw) {
      delay = Number.isFinite(seconds)
        ? seconds * 1000
        : Date.parse(raw) - Date.now()
    }
    let code = "http_error"
    if (status === 403) {
      code = "forbidden"
    }
    if (status === 404 || status === 410) {
      code = "source_missing"
    }
    throw new MediaDownloadError(
      code,
      retry,
      delay === undefined || !Number.isFinite(delay)
        ? undefined
        : Math.max(0, Math.min(900_000, delay)),
    )
  }
  if (
    response.headers["content-encoding"] &&
    response.headers["content-encoding"] !== "identity"
  ) {
    response.destroy()
    throw new MediaDownloadError("encoded_body")
  }
  response.setTimeout(10_000, () =>
    response.destroy(new MediaDownloadError("timeout", true)),
  )
  return {
    stream: response,
    contentLength:
      response.headers["content-length"] === undefined
        ? undefined
        : Number(response.headers["content-length"]),
  }
}

export async function downloadMedia(input: {
  source:
    | { type: "provider_url"; url: string }
    | { type: "storage_key"; key: string }
  kind: MediaKind
  signal?: AbortSignal
}): Promise<SpooledMedia> {
  const deadline = AbortSignal.timeout(60_000)
  const signal = input.signal
    ? AbortSignal.any([input.signal, deadline])
    : deadline
  const source =
    input.source.type === "provider_url"
      ? await providerStream(input.source.url, signal)
      : await withMediaDeadline(
          uploader.getObjectStream(input.source.key, { abortSignal: signal }),
          signal,
          (late) => {
            late.stream.destroy()
          },
        )
  return spoolMedia(source.stream, input.kind, signal, source.contentLength)
}

/** Only our private directories, bounded work, and a grace beyond any active transfer. */
export async function scavengeMediaTemp(
  now = Date.now(),
  tempRoot = tmpdir(),
): Promise<number> {
  let removed = 0
  const directory = await opendir(tempRoot)
  let inspected = 0
  for await (const entry of directory) {
    if (++inspected > 200) {
      break
    }
    if (
      !(entry.isDirectory() && entry.name.startsWith("chatbotx-zalo-media-"))
    ) {
      continue
    }
    const path = join(tempRoot, entry.name)
    if (now - (await stat(path)).mtimeMs < 24 * 60 * 60_000) {
      continue
    }
    await rm(path, { recursive: true, force: true })
    removed++
  }
  return removed
}
export function withMediaDeadline<T>(
  pending: Promise<T>,
  signal: AbortSignal,
  onLate?: (value: T) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let aborted = signal.aborted
    const abort = () => {
      aborted = true
      reject(signal.reason)
    }
    if (aborted) {
      reject(signal.reason)
    } else {
      signal.addEventListener("abort", abort, { once: true })
    }
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort)
        if (aborted) {
          onLate?.(value)
        } else {
          resolve(value)
        }
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort)
        if (!aborted) {
          reject(error)
        }
      },
    )
  })
}
