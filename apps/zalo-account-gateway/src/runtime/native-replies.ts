import { createHash } from "node:crypto"
import {
  type ZaloAccountNativeToolOperation as Operation,
  type ZaloAccountNativeToolResult as Result,
  toZaloAccountWebUrl,
  zaloAccountQuickMessageMediaIdentity,
} from "@chatbotx.io/sdk"
import type { Zalo } from "zca-js"
import { downloadOutboundAttachment } from "./outbound-attachment"
import { asNonEmptyString, asObject } from "./provider-content"

type Provider = Pick<
  Awaited<ReturnType<Zalo["login"]>>,
  | "getOwnId"
  | "getBizAccount"
  | "getQuickMessageList"
  | "addQuickMessage"
  | "updateQuickMessage"
  | "removeQuickMessage"
  | "getAutoReplyList"
  | "deleteAutoReply"
>

type QuickEntry = NonNullable<Result["quickMessages"]>["items"][number]
type AutoEntry = NonNullable<Result["autoReplies"]>["items"][number]
type QuickEdit = Extract<
  Operation,
  { kind: "addQuickMessage" | "updateQuickMessage" }
>
type MutationResult = Pick<
  Result,
  "outcome" | "version" | "itemId" | "removedMediaRevision"
>
type Write = (send: () => Promise<MutationResult>) => Promise<Result>

const PAGE_SIZE = 30
const MAX_SNAPSHOT_ROWS = 1000
const profileUid = /^\d{1,200}$/
const photoIdPattern = /^\d{1,100}$/
const versionPattern = /^\d{1,128}$/
const mediaHosts = ["zdn.vn", "zadn.vn", "zalo.me", "zalo.vn"]
const imageMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"])
const unavailable = { outcome: "unavailable" } as const
const unknown = { outcome: "unknown" } as const
const rejected = { outcome: "rejected" } as const

function count(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value
  }
}

function itemId(value: unknown) {
  const id = count(value)
  return id === 0 ? undefined : id
}

function snapshotVersion(value: unknown) {
  if (count(value) !== undefined) {
    return String(value)
  }
  if (typeof value === "string" && versionPattern.test(value)) {
    return BigInt(value).toString()
  }
}

function knownUid(value: unknown) {
  return typeof value === "string" && value !== "0" && profileUid.test(value)
    ? value
    : undefined
}

function readPhotoId(value: unknown) {
  const id = typeof value === "string" ? value : String(itemId(value) ?? "")
  return id !== "0" && photoIdPattern.test(id) ? id : undefined
}

function boundedText(value: unknown, maxLength: number) {
  if (typeof value === "string" && value.length <= maxLength) {
    return value
  }
}

function providerImage(value: unknown) {
  const url = toZaloAccountWebUrl(asNonEmptyString(value, 2048), true)
  if (
    url &&
    !url.port &&
    !url.hash &&
    url.href.length <= 2048 &&
    mediaHosts.some(
      (domain) =>
        url.hostname === domain || url.hostname.endsWith(`.${domain}`),
    )
  ) {
    return url.href
  }
}

function knownImageItem(row: Record<string, unknown>) {
  const media = asObject(row.media)
  if (
    row.type !== 1 ||
    !Array.isArray(media?.items) ||
    media.items.length !== 1
  ) {
    return
  }
  const image = asObject(media.items[0])
  if (
    image &&
    (image.type === undefined || image.type === 0) &&
    (readPhotoId(image.photoId) || providerPhoto(image))
  ) {
    return image
  }
}

function providerPhoto(image: Record<string, unknown> | undefined) {
  if (!image) {
    return
  }
  const url =
    providerImage(image.rawUrl) ??
    providerImage(image.normalUrl) ??
    providerImage(image.hdUrl)
  if (url) {
    const photoId = readPhotoId(image.photoId)
    return { url, ...(photoId ? { photoId } : {}) }
  }
}

function hashKnownImage(row: Record<string, unknown> | undefined) {
  const image = row && knownImageItem(row)
  if (image) {
    const photoId = readPhotoId(image.photoId)
    if (photoId) {
      return createHash("sha256").update(photoId).digest("hex")
    }
    const photo = providerPhoto(image)
    if (photo) {
      return createHash("sha256")
        .update(
          zaloAccountQuickMessageMediaIdentity({ url: new URL(photo.url) }),
        )
        .digest("hex")
    }
  }
}

function plainQuickType(row: Record<string, unknown>) {
  if (row.type !== 0) {
    return false
  }
  const media = asObject(row.media)
  return (
    row.media == null ||
    (media !== undefined &&
      Object.keys(media).length === 1 &&
      Array.isArray(media.items) &&
      media.items.length === 0)
  )
}

function projectQuick(row: Record<string, unknown>): QuickEntry | undefined {
  const id = itemId(row.id)
  const keyword = boundedText(row.keyword, 100)
  const title = boundedText(asObject(row.message)?.title, 2000)
  if (id === undefined || keyword === undefined || title === undefined) {
    return
  }
  const hasMedia = !plainQuickType(row)
  const media = providerPhoto(knownImageItem(row))
  return { id, keyword, title, hasMedia, ...(media ? { media } : {}) }
}

function recipients(
  value: unknown,
  scope: AutoEntry["scope"],
): string[] | undefined {
  if (scope === 0 || scope === 1) {
    return []
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    return
  }
  const result = new Set<string>()
  for (const candidate of value) {
    const uid = knownUid(candidate)
    if (!uid) {
      return
    }
    result.add(uid)
  }
  return [...result]
}

function recurrenceRules(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 10) {
    return
  }
  const rules: string[] = []
  for (const raw of value) {
    const rule = boundedText(raw, 150)
    if (rule === undefined) {
      return
    }
    rules.push(rule)
  }
  return rules
}

function projectAuto(row: Record<string, unknown>): AutoEntry | undefined {
  const id = itemId(row.id)
  const content = boundedText(row.content, 2000)
  const { scope, enable: enabled } = row
  const startTime = count(row.startTime)
  const endTime = count(row.endTime)
  if (
    id === undefined ||
    content === undefined ||
    typeof enabled !== "boolean" ||
    !(scope === 0 || scope === 1 || scope === 2 || scope === 3) ||
    startTime === undefined ||
    endTime === undefined
  ) {
    return
  }
  const uids = recipients(row.uids, scope)
  const recurrence = recurrenceRules(row.recurrence)
  if (uids && recurrence) {
    return { id, content, enabled, scope, uids, startTime, endTime, recurrence }
  }
}

function readSnapshot(
  data: Record<string, unknown> | undefined,
  listField: "items" | "item",
) {
  const version = snapshotVersion(data?.version)
  const records = data?.[listField]
  if (!(version && Array.isArray(records))) {
    return
  }
  const items = new Map<number, Record<string, unknown>>()
  const encountered = new Set<number>()
  for (const raw of records.slice(0, MAX_SNAPSHOT_ROWS)) {
    const row = asObject(raw)
    const id = itemId(row?.id)
    if (row && id !== undefined) {
      if (encountered.has(id)) {
        items.delete(id)
      } else {
        encountered.add(id)
        items.set(id, row)
      }
    }
  }
  return {
    version,
    items,
    complete: items.size === records.length,
    providerCursor: count(data?.cursor),
  }
}

type Snapshot = NonNullable<ReturnType<typeof readSnapshot>>

async function quickSnapshot(api: Provider) {
  const response = asObject(await api.getQuickMessageList().catch(() => null))
  return readSnapshot(response, "items")
}

async function autoSnapshot(api: Provider, uid: string) {
  const business = asObject(await api.getBizAccount(uid).catch(() => null))
  const packageId = count(business?.pkgId)
  if (packageId === undefined || packageId === 0) {
    return
  }
  const response = asObject(await api.getAutoReplyList().catch(() => null))
  return readSnapshot(response, "item")
}

function hasExpectedVersion(
  snapshot: Snapshot | undefined,
  expectedVersion?: string,
): snapshot is Snapshot {
  return (
    snapshot !== undefined &&
    (expectedVersion === undefined || snapshot.version === expectedVersion)
  )
}

function makePage<T>(
  snapshot: Snapshot,
  offset: number,
  project: (row: Record<string, unknown>) => T | undefined,
) {
  const records = [...snapshot.items.values()].slice(offset, offset + PAGE_SIZE)
  const items = records.flatMap((row) => {
    const item = project(row)
    return item === undefined ? [] : [item]
  })
  const nextOffset = offset + PAGE_SIZE
  return {
    items,
    version: snapshot.version,
    ...(nextOffset < snapshot.items.size ? { nextOffset } : {}),
    partial: !snapshot.complete || items.length !== records.length,
  }
}

function unknownIfWrongAckVersion(
  result: Record<string, unknown> | undefined,
  expectedVersion: string,
) {
  const version = snapshotVersion(result?.version)
  return version !== undefined && BigInt(version) > BigInt(expectedVersion)
    ? version
    : undefined
}

function allowedQuickEdit(
  operation: QuickEdit,
  snapshot: Snapshot | undefined,
): snapshot is Snapshot {
  if (!hasExpectedVersion(snapshot, operation.expectedVersion)) {
    return false
  }
  if (operation.kind === "updateQuickMessage") {
    const chosen = snapshot.items.get(operation.id)
    const params = asObject(chosen?.message)?.params
    if (!chosen || (params !== "" && params !== null)) {
      return false
    }
    if (operation.mediaMode === "remove") {
      return Boolean(knownImageItem(chosen)) && !operation.media
    }
    if (operation.mediaMode === "replace") {
      return Boolean(
        operation.media && (plainQuickType(chosen) || knownImageItem(chosen)),
      )
    }
    return !operation.media && plainQuickType(chosen)
  }
  return true
}

async function editQuick(
  api: Provider,
  operation: QuickEdit,
  write: Write,
): Promise<Result> {
  const { kind, expectedVersion, keyword, title } = operation
  let snapshot = await quickSnapshot(api)
  if (!allowedQuickEdit(operation, snapshot)) {
    return { kind, ...unavailable }
  }
  const media = operation.media
    ? await downloadOutboundAttachment(
        { ...operation.media, kind: "image" },
        { mimeTypes: imageMimeTypes, signal: AbortSignal.timeout(5000) },
      ).catch(() => null)
    : undefined
  if (operation.media && !media) {
    return { kind, ...unavailable }
  }
  if (media) {
    snapshot = await quickSnapshot(api)
    if (!allowedQuickEdit(operation, snapshot)) {
      return { kind, ...unavailable }
    }
  }
  const validated = snapshot
  const removedMediaRevision =
    operation.kind === "updateQuickMessage" && operation.mediaMode === "remove"
      ? await hashKnownImage(validated.items.get(operation.id))
      : undefined
  const input = { keyword, title, ...(media ? { media } : {}) }
  return await write(async () => {
    const response = asObject(
      kind === "addQuickMessage"
        ? await api.addQuickMessage(input)
        : await api.updateQuickMessage(input, operation.id),
    )
    const version = unknownIfWrongAckVersion(response, expectedVersion)
    const raw = asObject(response?.item)
    const result = raw && projectQuick(raw)
    if (
      !(version && raw && result) ||
      result.keyword !== keyword ||
      result.title !== title
    ) {
      return unknown
    }
    if (
      kind === "updateQuickMessage"
        ? result.id !== operation.id
        : validated.items.has(result.id)
    ) {
      return unknown
    }
    const validMedia = media
      ? knownImageItem(raw) !== undefined
      : plainQuickType(raw)
    return validMedia
      ? {
          outcome: "confirmed",
          itemId: result.id,
          version,
          removedMediaRevision,
        }
      : unknown
  })
}

export async function runProviderNativeReplies(
  api: Provider,
  operation: Operation,
  authorizeDispatch: () => Promise<void>,
): Promise<Result> {
  const { kind } = operation
  const uid = knownUid(api.getOwnId())
  if (!uid) {
    return { kind, ...unavailable }
  }
  const write: Write = async (send) => {
    await authorizeDispatch()
    try {
      return { kind, ...(await send()) }
    } catch (error) {
      const code = asObject(error)?.code
      if (
        (kind === "addQuickMessage" && code === 821) ||
        ((kind === "updateQuickMessage" || kind === "deleteQuickMessage") &&
          code === 212)
      ) {
        return { kind, ...rejected }
      }
      return { kind, ...unknown }
    }
  }
  switch (kind) {
    case "readQuickMessages": {
      const offset = operation.offset ?? 0
      if (offset > 0 && !operation.expectedVersion) {
        return { kind, ...unavailable }
      }
      const snapshot = await quickSnapshot(api)
      if (!hasExpectedVersion(snapshot, operation.expectedVersion)) {
        return { kind, ...unavailable }
      }
      const { partial, ...page } = makePage(snapshot, offset, projectQuick)
      const providerCursor = snapshot.providerCursor
      const known =
        !partial &&
        providerCursor === 0 &&
        !page.items.some((item) => item.hasMedia && !item.media)
      return {
        kind,
        outcome: known ? "confirmed" : "partial",
        quickMessages: {
          ...page,
          ...(providerCursor === undefined ? {} : { providerCursor }),
        },
      }
    }
    case "readAutoReplies": {
      const offset = operation.offset ?? 0
      if (offset > 0 && !operation.expectedVersion) {
        return { kind, ...unavailable }
      }
      const snapshot = await autoSnapshot(api, uid)
      if (!hasExpectedVersion(snapshot, operation.expectedVersion)) {
        return { kind, ...unavailable }
      }
      const { partial, ...autoReplies } = makePage(
        snapshot,
        offset,
        projectAuto,
      )
      return { kind, outcome: partial ? "partial" : "confirmed", autoReplies }
    }
    case "addQuickMessage":
    case "updateQuickMessage":
      return await editQuick(api, operation, write)
    case "deleteQuickMessage": {
      const snapshot = await quickSnapshot(api)
      if (
        !(
          hasExpectedVersion(snapshot, operation.expectedVersion) &&
          snapshot.items.has(operation.id)
        )
      ) {
        return { kind, ...unavailable }
      }
      const removedMediaRevision = await hashKnownImage(
        snapshot.items.get(operation.id),
      )
      return await write(async () => {
        const result = asObject(await api.removeQuickMessage(operation.id))
        const version = unknownIfWrongAckVersion(
          result,
          operation.expectedVersion,
        )
        const ids = result?.itemIds
        if (
          version &&
          Array.isArray(ids) &&
          ids.length === 1 &&
          itemId(ids[0]) === operation.id
        ) {
          return {
            outcome: "confirmed",
            itemId: operation.id,
            version,
            removedMediaRevision,
          }
        }
        return unknown
      })
    }
    case "deleteAutoReply": {
      const snapshot = await autoSnapshot(api, uid)
      if (
        !(
          hasExpectedVersion(snapshot, operation.expectedVersion) &&
          snapshot.items.has(operation.id)
        )
      ) {
        return { kind, ...unavailable }
      }
      return await write(async () => {
        const result = asObject(await api.deleteAutoReply(operation.id))
        const version = unknownIfWrongAckVersion(
          result,
          operation.expectedVersion,
        )
        if (version && itemId(result?.item) === operation.id) {
          return { outcome: "confirmed", itemId: operation.id, version }
        }
        return unknown
      })
    }
    default:
      return { kind, ...unavailable }
  }
}
