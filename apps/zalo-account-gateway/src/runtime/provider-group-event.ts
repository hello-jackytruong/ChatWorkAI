import { createHash } from "node:crypto"
import {
  type ZaloAccountGroupEvent,
  zaloAccountGroupEventSchema,
  zaloAccountGroupSettingsSchema,
} from "@chatbotx.io/sdk"
import { type GroupEvent, GroupEventType } from "zca-js"

const kinds: Partial<
  Record<GroupEventType, Exclude<ZaloAccountGroupEvent["kind"], "refresh">>
> = {
  [GroupEventType.JOIN]: "joined",
  [GroupEventType.LEAVE]: "left",
  [GroupEventType.REMOVE_MEMBER]: "removed",
  [GroupEventType.BLOCK_MEMBER]: "blocked",
  [GroupEventType.ADD_ADMIN]: "adminAdded",
  [GroupEventType.REMOVE_ADMIN]: "adminRemoved",
  [GroupEventType.UPDATE]: "updated",
  [GroupEventType.UPDATE_AVATAR]: "avatarUpdated",
  [GroupEventType.UPDATE_SETTING]: "settingsUpdated",
  [GroupEventType.NEW_LINK]: "linkUpdated",
  [GroupEventType.NEW_PIN_TOPIC]: "topicUpdated",
  [GroupEventType.UPDATE_PIN_TOPIC]: "topicUpdated",
  [GroupEventType.REORDER_PIN_TOPIC]: "topicUpdated",
  [GroupEventType.UNPIN_TOPIC]: "topicUpdated",
  [GroupEventType.UPDATE_TOPIC]: "topicUpdated",
  [GroupEventType.REMOVE_TOPIC]: "topicUpdated",
  [GroupEventType.UPDATE_BOARD]: "topicUpdated",
  [GroupEventType.REMOVE_BOARD]: "topicUpdated",
}

const groupIdPattern = /^[1-9]\d{0,199}$/
const timestampPattern = /^\d{10}(?:\d{3})?$/
const versionPattern = /^[1-9]\d{0,29}$/
const validId = (value: unknown): value is string =>
  typeof value === "string" && groupIdPattern.test(value)

const normalizeTime = (value: unknown) => {
  const raw = typeof value === "number" ? String(value) : value
  return typeof raw === "string" && timestampPattern.test(raw)
    ? Number(raw) * (raw.length === 10 ? 1000 : 1)
    : 0
}

const groupSettingKeys = zaloAccountGroupSettingsSchema.keyof().options

function safeAvatar(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2000) {
    return
  }
  try {
    const url = new URL(value)
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port
    ) {
      return value
    }
  } catch {
    return
  }
}

export function normalizeProviderGroupEvent(
  event: GroupEvent,
  ownUid: string,
  observedAt = Date.now(),
): ZaloAccountGroupEvent | undefined {
  const providerGroupId = event?.threadId
  if (
    !(validId(providerGroupId) && event.data && typeof event.data === "object")
  ) {
    return
  }
  const refresh = { providerGroupId, kind: "refresh" } as const
  const kind = kinds[event.type]
  const data = event.data
  if ("groupId" in data && data.groupId !== providerGroupId) {
    return
  }
  if (!(kind && "groupId" in data)) {
    return refresh
  }
  // `sourceId` is the actor. `isSelf` is true for both actors and targets.
  const members =
    "updateMembers" in data &&
    Array.isArray(data.updateMembers) &&
    data.updateMembers.length <= 1000
      ? data.updateMembers
          .map((member) => (typeof member === "object" ? member?.id : member))
          .filter(validId)
      : []
  const pin =
    kind === "topicUpdated" &&
    "topic" in data &&
    data.topic &&
    validId(data.topic.id) &&
    Number.isSafeInteger(data.boardVersion)
      ? data.topic
      : undefined
  const timestamp =
    normalizeTime("time" in data && data.time) ||
    normalizeTime(pin?.editTime) ||
    normalizeTime(pin?.createTime)
  const providerVersion =
    "version" in data &&
    typeof data.version === "string" &&
    versionPattern.test(data.version)
      ? data.version
      : undefined
  const eventVersion =
    providerVersion ??
    (pin && "boardVersion" in data
      ? `${data.boardVersion}:${pin.id}`
      : undefined)
  if (!timestamp || timestamp > observedAt + 60_000 || !eventVersion) {
    return refresh
  }
  const targetIncludesAccount = validId(ownUid) && members.includes(ownUid)
  const actor =
    "sourceId" in data && validId(data.sourceId) ? data.sourceId : ""
  const name =
    kind === "updated" &&
    "groupName" in data &&
    typeof data.groupName === "string"
      ? data.groupName.trim().slice(0, 255) || undefined
      : undefined
  const avatarUrl =
    (kind === "updated" || kind === "avatarUpdated") && "fullAvt" in data
      ? (safeAvatar(data.fullAvt) ?? safeAvatar(data.avt))
      : undefined
  const rawSettings = "groupSetting" in data ? data.groupSetting : undefined
  const settings =
    rawSettings && typeof rawSettings === "object"
      ? Object.fromEntries(
          groupSettingKeys.flatMap((key) => {
            const flag = rawSettings[key]
            return flag === 0 || flag === 1 ? [[key, flag === 1]] : []
          }),
        )
      : undefined
  const parsed = zaloAccountGroupEventSchema.safeParse({
    providerGroupId,
    kind,
    identity: createHash("sha256")
      .update(
        JSON.stringify([
          event.type,
          providerGroupId,
          timestamp,
          eventVersion,
          actor,
          [...new Set(members)].sort(),
        ]),
      )
      .digest("hex"),
    timestampMs: timestamp,
    providerVersion,
    targetIncludesAccount,
    ...(name ? { name } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(settings && Object.keys(settings).length ? { settings } : {}),
  })
  return parsed.success ? parsed.data : refresh
}
