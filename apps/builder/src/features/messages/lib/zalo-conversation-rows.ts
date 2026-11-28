import { parseZaloAccountSourceId } from "@chatbotx.io/business/zalo-account/message-projection"
import { zaloAccountAlbumSchema } from "@chatbotx.io/sdk"
import type { MessageResourceWithRelations } from "../schema/resource"
import { zaloMessageLabel } from "./zalo-message-label"
import { getZaloAccountAttributes } from "./zalo-rich-message"

type Message = MessageResourceWithRelations
export type ZaloConversationRow = {
  id: string
  items: Message[]
  album?: Array<{ index: number; message: Message }>
}

function albumItem(message: Message, zaloInboxes: ReadonlySet<string>) {
  if (!zaloInboxes.has(message.contactInboxId)) {
    return
  }
  const source = parseZaloAccountSourceId(message.sourceId)
  const attrs = getZaloAccountAttributes(message.contentAttributes)
  if (!(source && attrs && typeof attrs === "object" && "album" in attrs)) {
    return
  }
  const data = zaloAccountAlbumSchema.safeParse(attrs.album).data
  const image =
    message.attachments?.length === 1 &&
    message.attachments[0]?.fileType === "image"
  if (!(data && (image || zaloMessageLabel(message)))) {
    return
  }
  const key = JSON.stringify([
    message.workspaceId,
    message.conversationId,
    source.accountId,
    source.threadType,
    source.threadId,
    data.layoutId,
    data.itemCount,
  ])
  return { key, index: data.index }
}

export function buildZaloConversationRows(
  messages: readonly Message[],
  zaloInboxes: ReadonlySet<string>,
): ZaloConversationRow[] {
  const rows: ZaloConversationRow[] = []
  const albums = new Map<string, NonNullable<ZaloConversationRow["album"]>>()
  const seen = new Set<string>()
  for (const message of messages) {
    if (seen.has(message.id)) {
      continue
    }
    seen.add(message.id)
    const album = albumItem(message, zaloInboxes)
    const row = album && albums.get(album.key)
    if (!album || row?.some(({ index }) => index === album.index)) {
      rows.push({ id: message.id, items: [message] })
    } else if (row) {
      row.push({ index: album.index, message })
    } else {
      const items = [{ index: album.index, message }]
      albums.set(album.key, items)
      rows.push({ id: album.key, items: [], album: items })
    }
  }
  return rows.map((row) => {
    if (!row.album) {
      return row
    }
    row.album.sort((a, b) => a.index - b.index)
    return { ...row, items: row.album.map(({ message }) => message) }
  })
}
