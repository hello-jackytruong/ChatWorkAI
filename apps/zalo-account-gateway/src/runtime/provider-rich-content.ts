import {
  type ZaloAccountMediaResource,
  type ZaloAccountRichContent,
  zaloAccountRichStyleSchema,
  zaloAccountStickerMessageIdentitySchema,
} from "@chatbotx.io/sdk"
import {
  asNonEmptyString,
  asObject,
  firstUrl,
  parseObject,
  providerNumber,
} from "./provider-content"

type RichPresentation = {
  richContent?: ZaloAccountRichContent
  text?: string
  image?: ZaloAccountMediaResource
}

type ProviderFields = Record<string, unknown>

const styleText = (value: unknown): string | undefined =>
  typeof value === "string" && value.length <= 20_000 && value.trim()
    ? value
    : undefined

const isCodePointBoundary = (text: string, index: number): boolean => {
  const before = text.charCodeAt(index - 1)
  const after = text.charCodeAt(index)
  return !(
    before >= 0xd8_00 &&
    before <= 0xdb_ff &&
    after >= 0xdc_00 &&
    after <= 0xdf_ff
  )
}

const styledText = (
  text: string | undefined,
  styles: unknown,
): RichPresentation => {
  if (!(text && Array.isArray(styles)) || styles.length > 100) {
    return { text }
  }
  const spans = styles.flatMap((value) => {
    const fields = asObject(value)
    const offset = fields?.start
    const length = fields?.len
    const style = zaloAccountRichStyleSchema.safeParse(fields?.st)
    if (
      typeof offset !== "number" ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      offset + length > text.length ||
      !isCodePointBoundary(text, offset) ||
      !isCodePointBoundary(text, offset + length) ||
      !style.success
    ) {
      return []
    }
    return [{ offset, length, style: style.data.toLowerCase() }]
  })
  return spans.length
    ? { text, richContent: { kind: "styledText", spans } }
    : { text }
}

const cardImage = (
  url: string | undefined,
  slot: string,
): ZaloAccountMediaResource | undefined =>
  url ? { url, kind: "image", role: "card_image", slot } : undefined

const callCard = (
  fields: ProviderFields,
  action: string,
  isSelf: boolean,
): RichPresentation => {
  const callType = asNonEmptyString(fields.callType)?.toLowerCase() ?? ""
  const durationSeconds = providerNumber(
    fields.callDuration ?? fields.duration,
    0,
    Number.MAX_SAFE_INTEGER / 1000,
  )
  const durationMs =
    providerNumber(fields.durationMs, 0) ??
    (durationSeconds === undefined ? undefined : durationSeconds * 1000)
  const missed =
    fields.isMissed === true ||
    action.endsWith(".misscall") ||
    callType.includes("miss")
  const answered =
    fields.isMissed === false ||
    action.endsWith(".calltime") ||
    (durationMs !== undefined && durationMs > 0)
  const caller = typeof fields.isCaller === "boolean" ? fields.isCaller : isSelf
  const answeredStatus = answered ? "answered" : undefined
  const audio =
    callType.includes("voice") ||
    callType.includes("audio") ||
    fields.isVideo === false
  const audioMedium = audio ? "audio" : undefined
  const video = callType.includes("video") || fields.isVideo === true
  return {
    richContent: {
      kind: "call",
      direction: caller ? "outgoing" : "incoming",
      status: missed ? "missed" : answeredStatus,
      medium: video ? "video" : audioMedium,
      durationMs,
    },
  }
}

export function normalizeProviderRichContent(input: {
  msgType: string
  content: unknown
  propertyExt?: unknown
  textProperties?: unknown
  isSelf: boolean
}): RichPresentation {
  const content = asObject(input.content)
  const extension = parseObject(asObject(input.propertyExt)?.ext)
  const params = parseObject(content?.params) ?? parseObject(content?.param)
  const fields = { ...params, ...content }
  const action = (
    asNonEmptyString(content?.action)?.toLowerCase() ?? ""
  ).replace("recommened.", "recommended.")
  const type = input.msgType
    .toLowerCase()
    .replace("recommened.", "recommended.")
  const typeVariant = type.split(".").at(-1)
  const properties = parseObject(input.textProperties)
  if (
    action === "rtf" ||
    typeVariant === "rtf" ||
    typeof input.content === "string"
  ) {
    const text = styleText(
      typeof input.content === "string"
        ? input.content
        : (content?.title ?? content?.text),
    )
    return styledText(
      text,
      params?.styles ??
        fields.styles ??
        extension?.styles ??
        properties?.styles,
    )
  }
  if (!content) {
    return {}
  }
  const stickerId = fields.stickerId ?? fields.sticker_id
  if (
    stickerId !== undefined ||
    type.includes("sticker") ||
    action.includes("sticker")
  ) {
    const identity = zaloAccountStickerMessageIdentitySchema.shape
    const id = identity.stickerId.safeParse(
      asNonEmptyString(stickerId ?? fields.id),
    )
    if (id.success) {
      return {
        richContent: {
          kind: "sticker",
          stickerId: id.data,
          categoryId: identity.categoryId.safeParse(
            asNonEmptyString(
              fields.categoryId ??
                fields.catId ??
                fields.cateId ??
                fields.cate_id,
            ),
          ).data,
          stickerType: identity.stickerType.safeParse(
            providerNumber(fields.stickerType ?? fields.type, 1, 32_767),
          ).data,
        },
      }
    }
  }
  const title = asNonEmptyString(fields.title)
  const description = asNonEmptyString(fields.description, 2048)
  const descriptionFields = parseObject(fields.description)
  const bankName = asNonEmptyString(fields.bankName ?? fields.bankCode)
  const accountName = asNonEmptyString(fields.accountName)
  const accountNumber = asNonEmptyString(
    fields.accountNumber ?? fields.accNumber,
    64,
  )
  const contactUid = asNonEmptyString(fields.contactUid)
  if (
    ["recommended.calltime", "recommended.misscall"].includes(action) ||
    ["call", "voip", "calltime", "misscall"].includes(typeVariant ?? "") ||
    fields.callType !== undefined ||
    fields.callDuration !== undefined
  ) {
    return callCard(fields, action || type, input.isSelf)
  }
  if (
    (action === "zinstant.bankcard" ||
      ["bank", "bankcard", "transfer"].includes(typeVariant ?? "") ||
      bankName ||
      accountNumber) &&
    (bankName || accountNumber || accountName || title)
  ) {
    return {
      richContent: {
        kind: "bank",
        bankName,
        accountNumber,
        accountName,
        amount: providerNumber(fields.amount ?? fields.transferAmount, 0),
        description: descriptionFields ? undefined : description,
      },
      text: title ?? bankName ?? accountName,
    }
  }
  if (
    ["show.profile", "recommended.user", "recommended.contact"].includes(
      action,
    ) ||
    ["contact", "contactcard", "user"].includes(typeVariant ?? "") ||
    contactUid
  ) {
    const profile = { ...fields, ...parseObject(fields.userInfo) }
    const name =
      asNonEmptyString(
        profile.zaloName ??
          profile.displayName ??
          profile.userName ??
          profile.name,
      ) ?? title
    return {
      richContent: {
        kind: "contact",
        name,
        userId: contactUid ?? asNonEmptyString(profile.uid ?? profile.userId),
        phone: asNonEmptyString(profile.phone ?? profile.phoneNumber, 64),
      },
      text: name ?? description,
      image: cardImage(
        firstUrl(profile, ["avatar", "avatarUrl", "thumb", "qrCodeUrl"]),
        "contact_avatar",
      ),
    }
  }
  const qrUrl = firstUrl({ ...descriptionFields, ...fields }, ["qrCodeUrl"])
  if (
    qrUrl ||
    ["show.qr", "recommended.qr"].includes(action) ||
    typeVariant === "qr"
  ) {
    const qrDescription = descriptionFields ? undefined : description
    return {
      richContent: { kind: "qr", title, description: qrDescription },
      text: title ?? qrDescription,
      image: cardImage(qrUrl, "qr_image"),
    }
  }
  const url = firstUrl(fields, ["href", "link", "url"])
  const latitude = providerNumber(fields.latitude ?? fields.lat, -90, 90)
  const longitude = providerNumber(
    fields.longitude ?? fields.lng ?? fields.lon,
    -180,
    180,
  )
  const hasCoordinates = latitude !== undefined && longitude !== undefined
  if (
    ["show.location", "recommended.location", "share.location"].includes(
      action,
    ) ||
    typeVariant === "location" ||
    (!action && hasCoordinates)
  ) {
    const address = asNonEmptyString(fields.address, 2048) ?? description
    return {
      richContent: {
        kind: "location",
        latitude: hasCoordinates ? latitude : undefined,
        longitude: hasCoordinates ? longitude : undefined,
        url,
        title,
        address,
      },
      text: title ?? address ?? url,
    }
  }
  const unfurl =
    !action &&
    ["webchat", "recommended"].includes(typeVariant ?? "") &&
    Boolean(title || fields.thumb)
  if (
    url &&
    (action === "recommended.link" || typeVariant === "link" || unfurl)
  ) {
    return {
      richContent: { kind: "link", url, title, description },
      text: title ?? description ?? url,
      image: cardImage(
        firstUrl(fields, ["thumb", "thumbUrl", "thumbnail", "imageUrl"]),
        "link_preview",
      ),
    }
  }
  return {}
}
