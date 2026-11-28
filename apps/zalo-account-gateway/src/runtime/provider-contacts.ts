import {
  type ZaloAccountContactOperation,
  type ZaloAccountContactResult,
  type ZaloAccountFriendEvent,
  type ZaloAccountPresence,
  zaloAccountFriendEventSchema,
} from "@chatbotx.io/sdk"
import { FriendEventType, type Zalo } from "zca-js"
import { asNonEmptyString, asObject } from "./provider-content"
import { normalizeZaloProfile } from "./provider-profile"

const providerUid = /^\d{1,100}$/
const toUid = (value: unknown) =>
  typeof value === "string" && providerUid.test(value) ? value : undefined

export function normalizeZaloLastOnline(
  uid: string,
  raw: unknown,
  now = Date.now(),
): ZaloAccountPresence {
  const data = asObject(raw)
  const visible = asObject(data?.settings)?.show_online_status
  if (visible === false) {
    return { uid, status: "hidden" }
  }
  const time = data?.lastOnline
  if (
    visible !== true ||
    typeof time !== "number" ||
    !Number.isSafeInteger(time) ||
    time <= 0
  ) {
    return { uid, status: "unknown" }
  }
  const lastOnlineMs = time < 1e12 ? time * 1000 : time
  if (lastOnlineMs > now) {
    return { uid, status: "unknown" }
  }
  return {
    uid,
    status: now - lastOnlineMs >= 60_000 ? "offline" : "unknown",
    lastOnlineMs,
  }
}

const simpleEvents: Partial<Record<number, ZaloAccountFriendEvent["kind"]>> = {
  [FriendEventType.ADD]: "add",
  [FriendEventType.REMOVE]: "remove",
  [FriendEventType.BLOCK]: "block",
  [FriendEventType.UNBLOCK]: "unblock",
  [FriendEventType.BLOCK_CALL]: "blockCall",
  [FriendEventType.UNBLOCK_CALL]: "unblockCall",
  [FriendEventType.PIN_CREATE]: "pin",
  [FriendEventType.PIN_UNPIN]: "unpin",
}

export function normalizeZaloFriendEvent(
  raw: unknown,
  ownUid: string,
): ZaloAccountFriendEvent[] {
  const event = asObject(raw)
  const type = event?.type
  if (typeof type !== "number") {
    return []
  }
  if (type === FriendEventType.SEEN_FRIEND_REQUEST) {
    if (event?.threadId !== ownUid || !Array.isArray(event?.data)) {
      return []
    }
    return event.data.slice(0, 50).flatMap((value) => {
      const uid = toUid(value)
      return uid && uid !== ownUid ? [{ uid, kind: "seen" as const }] : []
    })
  }
  if (
    type === FriendEventType.REQUEST ||
    type === FriendEventType.REJECT_REQUEST ||
    type === FriendEventType.UNDO_REQUEST
  ) {
    const data = asObject(event?.data)
    const from = toUid(data?.fromUid)
    const to = toUid(data?.toUid)
    if (!(from && to) || from === to || (from !== ownUid && to !== ownUid)) {
      return []
    }
    let kind: ZaloAccountFriendEvent["kind"] = "request"
    if (type === FriendEventType.REJECT_REQUEST) {
      kind = "reject"
    }
    if (type === FriendEventType.UNDO_REQUEST) {
      kind = "undo"
    }
    return [
      {
        uid: from === ownUid ? to : from,
        kind,
        direction: from === ownUid ? "outgoing" : "incoming",
      },
    ]
  }
  const parsed = zaloAccountFriendEventSchema.safeParse({
    uid: event?.threadId,
    kind: simpleEvents[type],
  })
  return parsed.success && parsed.data.uid !== ownUid ? [parsed.data] : []
}

type Api = Awaited<ReturnType<Zalo["login"]>>
type Contacts = NonNullable<ZaloAccountContactResult["contacts"]>
function summarizeProfiles(
  rows: unknown[],
  ownUid: string,
  kind: "findUser" | "getAllFriends" = "getAllFriends",
  request?: "incoming" | "outgoing",
): Contacts {
  const profiles = new Map<string, Contacts[number]>()
  for (const raw of rows.slice(0, 50)) {
    const data = asObject(raw)
    const uid = toUid(data?.userId ?? data?.uid)
    if (!uid || uid === ownUid || profiles.has(uid)) {
      continue
    }
    const profile = normalizeZaloProfile({
      uid,
      data,
      source: kind,
      observedAt: Date.now(),
    })
    // Account-wide lists and discovery expose the matched identity only.
    const name = asNonEmptyString(
      profile.fields.displayName?.value ?? profile.fields.zaloName?.value,
      200,
    )
    const entry: Contacts[number] = { uid, name, request }
    if (kind === "findUser") {
      const { publicPhone: _publicPhone, ...fields } = profile.fields
      entry.profile = { ...profile, fields }
    }
    profiles.set(uid, entry)
  }
  return Array.from(profiles.values())
}

function providerFlag(value: unknown) {
  if (value === true || value === 1) {
    return true
  }
  if (value === false || value === 0) {
    return false
  }
}

export async function runZaloContactOperation(
  api: Api,
  operation: ZaloAccountContactOperation,
  ownUid: string,
): Promise<ZaloAccountContactResult> {
  if ("uid" in operation && operation.uid === ownUid) {
    throw new Error("Invalid Zalo contact target")
  }
  switch (operation.kind) {
    case "lookupPhone":
      return {
        contacts: summarizeProfiles(
          [await api.findUser(operation.phone)],
          ownUid,
          "findUser",
        ),
      }
    case "lookupUsername":
      return {
        contacts: summarizeProfiles(
          [await api.findUserByUsername(operation.username)],
          ownUid,
          "findUser",
        ),
      }
    case "lookupPhones":
      return {
        contacts: summarizeProfiles(
          Object.values(
            (await api.getMultiUsersByPhones(operation.phones)) ?? {},
          ),
          ownUid,
          "findUser",
        ),
      }
    case "sentRequests": {
      const sent = await api.getSentFriendRequest()
      return {
        contacts: summarizeProfiles(
          Object.values(sent ?? {}),
          ownUid,
          "getAllFriends",
          "outgoing",
        ),
      }
    }
    case "recommendations": {
      const result = await api.getFriendRecommendations()
      const items = result?.recommItems?.slice(0, 50) ?? []
      const requests = items.filter(({ dataInfo }) => dataInfo.recommType === 2)
      return {
        contacts: [
          ...summarizeProfiles(
            requests.map(({ dataInfo }) => dataInfo),
            ownUid,
            "getAllFriends",
            "incoming",
          ),
          ...summarizeProfiles(
            items
              .filter(({ dataInfo }) => dataInfo.recommType === 1)
              .map(({ dataInfo }) => dataInfo),
            ownUid,
          ),
        ],
      }
    }
    case "closeFriends":
      return {
        contacts: summarizeProfiles(
          (await api.getCloseFriends()) ?? [],
          ownUid,
        ),
      }
    case "aliases": {
      const result = await api.getAliasList(50, 1)
      return {
        contacts: (result?.items ?? []).slice(0, 50).flatMap((item) => {
          const uid = toUid(item.userId)
          const alias = asNonEmptyString(item.alias, 100)
          return uid && uid !== ownUid && alias ? [{ uid, alias }] : []
        }),
      }
    }
    case "requestStatus": {
      const result = asObject(await api.getFriendRequestStatus(operation.uid))
      return {
        requestStatus: {
          isFriend: providerFlag(result?.isFriend),
          sent: providerFlag(result?.isFriendRequestSent ?? result?.isSent),
          received: providerFlag(
            result?.isFriendRequestReceived ?? result?.isReceived,
          ),
        },
      }
    }
    case "lastOnline":
      return {
        presence: [
          normalizeZaloLastOnline(
            operation.uid,
            await api.lastOnline(operation.uid),
          ),
        ],
      }
    case "onlines": {
      const result = await api.getFriendOnlines()
      const online = new Set(
        (result?.onlines ?? []).map(({ userId }) => userId),
      )
      return {
        presence: [...new Set(operation.uids)]
          .filter((uid) => uid !== ownUid)
          .map((uid) => ({
            uid,
            status: online.has(uid) ? "online" : "unknown",
          })),
      }
    }
    case "invite":
      await api.sendFriendRequest(operation.message, operation.uid)
      break
    case "accept":
      await api.acceptFriendRequest(operation.uid)
      break
    case "reject":
      await api.rejectFriendRequest(operation.uid)
      break
    case "cancel":
      await api.undoFriendRequest(operation.uid)
      break
    case "remove":
      await api.removeFriend(operation.uid)
      break
    case "block":
      await api.blockUser(operation.uid)
      break
    case "unblock":
      await api.unblockUser(operation.uid)
      break
    case "blockFeed":
      await api.blockViewFeed(operation.blocked, operation.uid)
      break
    case "setAlias":
      await api.changeFriendAlias(operation.alias, operation.uid)
      break
    case "clearAlias":
      await api.removeFriendAlias(operation.uid)
      break
    default:
      return {}
  }
  return { accepted: true }
}
