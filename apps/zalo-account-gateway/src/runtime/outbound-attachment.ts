import { assertPublicUrl } from "@chatbotx.io/business"
import type { ZaloAccountAttachment } from "@chatbotx.io/sdk"

const MAX_REDIRECTS = 5
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_FILE_BYTES = 25 * 1024 * 1024
const ALLOWED_IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])
const BLOCKED_FILE_TYPES = new Set(["text/html", "application/xhtml+xml"])
const FILENAME_EXTENSION = /\.[^.]*$/

const baseMimeType = (value: string | null): string | null =>
  value ? (value.split(";")[0] ?? "").trim().toLowerCase() : null

const extensionFor = (mimeType: string): string => {
  switch (mimeType) {
    case "image/gif":
      return "gif"
    case "image/jpeg":
      return "jpg"
    case "image/png":
      return "png"
    case "image/webp":
      return "webp"
    case "application/pdf":
      return "pdf"
    case "video/mp4":
      return "mp4"
    case "audio/mp4":
    case "audio/x-m4a":
      return "m4a"
    default:
      return "bin"
  }
}

const safeFilename = (
  name: string | undefined,
  mimeType: string,
): `${string}.${string}` => {
  const normalized = (name ?? `attachment.${extensionFor(mimeType)}`)
    .replaceAll(/[^a-zA-Z0-9._-]/g, "_")
    .slice(-120)
  const knownExtension = extensionFor(mimeType)
  if (knownExtension === "bin") {
    return (
      normalized.includes(".") ? normalized : `${normalized}.bin`
    ) as `${string}.${string}`
  }
  const basename = normalized.replace(FILENAME_EXTENSION, "") || "attachment"
  return `${basename}.${knownExtension}`
}

const fetchChecked = async (
  initialUrl: string,
  signal: AbortSignal,
  redirectsLeft = MAX_REDIRECTS,
): Promise<Response> => {
  await assertOutboundUrl(initialUrl)
  const response = await fetch(initialUrl, {
    redirect: "manual",
    signal,
  })
  if (![301, 302, 303, 307, 308].includes(response.status)) {
    return response
  }
  await response.body?.cancel().catch(() => undefined)
  if (redirectsLeft <= 0) {
    throw new Error("Too many redirects for Zalo Account attachment")
  }
  const location = response.headers.get("location")
  if (!location) {
    throw new Error("Zalo Account attachment redirect has no location")
  }
  return await fetchChecked(
    new URL(location, initialUrl).href,
    signal,
    redirectsLeft - 1,
  )
}

export const assertOutboundUrl = async (url: string): Promise<void> => {
  const parsed = new URL(url)
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("Zalo Account media requires a public HTTPS URL")
  }
  await assertPublicUrl(url, "Zalo Account attachment URL")
}

const readBounded = async (
  response: Response,
  maxBytes: number,
): Promise<Buffer> => {
  const declaredSize = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error("Zalo Account attachment is too large")
  }
  if (!response.body) {
    throw new Error("Zalo Account attachment response has no body")
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) {
      break
    }
    received += chunk.value.byteLength
    if (received > maxBytes) {
      await reader.cancel()
      throw new Error("Zalo Account attachment is too large")
    }
    chunks.push(chunk.value)
  }
  return Buffer.concat(chunks, received)
}

export const downloadOutboundAttachment = async (
  attachment: ZaloAccountAttachment,
  options: {
    maxBytes?: number
    signal?: AbortSignal
    mimeTypes?: ReadonlySet<string>
  } = {},
): Promise<{
  data: Buffer
  filename: `${string}.${string}`
  metadata: { totalSize: number }
}> => {
  const response = await fetchChecked(
    attachment.url,
    options.signal ?? AbortSignal.timeout(30_000),
  )
  if (!response.ok) {
    throw new Error(
      `Zalo Account attachment download failed: ${response.status}`,
    )
  }
  const mimeType = baseMimeType(response.headers.get("content-type"))
  if (!mimeType) {
    throw new Error("Zalo Account attachment has no MIME type")
  }
  if (attachment.mimeType && baseMimeType(attachment.mimeType) !== mimeType) {
    throw new Error("Zalo Account attachment MIME type does not match")
  }
  if (attachment.kind === "image" && !ALLOWED_IMAGE_TYPES.has(mimeType)) {
    throw new Error("Unsupported Zalo Account image MIME type")
  }
  if (attachment.kind === "file" && BLOCKED_FILE_TYPES.has(mimeType)) {
    throw new Error("Unsafe Zalo Account file MIME type")
  }
  if (options.mimeTypes && !options.mimeTypes.has(mimeType)) {
    throw new Error("Unsupported Zalo Account clip or poster MIME type")
  }
  const data = await readBounded(
    response,
    Math.min(
      attachment.kind === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES,
      options.maxBytes ?? MAX_FILE_BYTES,
    ),
  )
  if (!data.byteLength) {
    throw new Error("Zalo Account attachment is empty")
  }
  return {
    data,
    filename: safeFilename(attachment.name, mimeType),
    metadata: { totalSize: data.byteLength },
  }
}
