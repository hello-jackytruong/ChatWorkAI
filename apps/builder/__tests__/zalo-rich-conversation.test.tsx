import { describe, expect, test } from "vitest"
import { buildZaloConversationRows } from "@/features/messages/lib/zalo-conversation-rows"
import {
  applyZaloMention,
  findZaloMentionQuery,
  updateZaloMentionRanges,
} from "@/features/messages/lib/zalo-mention-draft"
import type { MessageResourceWithRelations } from "@/features/messages/schema/resource"

const message = (
  id: string,
  attrs?: {
    album: { layoutId: string; index: number; itemCount: number }
    hidden?: boolean
  },
  contactInboxId = "zalo",
) =>
  ({
    id,
    workspaceId: "workspace",
    sourceId: `za:account:group:thread:${id}`,
    contactInboxId,
    messageType: "incoming",
    type: "message",
    text: attrs?.hidden ? null : id,
    attachments: attrs && !attrs.hidden ? [{ id, fileType: "image" }] : [],
    contentAttributes: attrs && {
      zaloAccount: {
        album: attrs.album,
        ...(attrs.hidden && { lifecycle: { recalled: true } }),
      },
    },
  }) as unknown as MessageResourceWithRelations

describe("Zalo Account conversation rows", () => {
  test("groups trusted same-thread images by layout, retaining other files and hidden slot IDs", () => {
    const album = { layoutId: "batch-1", itemCount: 3 }
    const rows = buildZaloConversationRows(
      [
        message("2", { album: { ...album, index: 2 } }),
        message("plain-file"),
        message("0", { album: { ...album, index: 0 } }),
        message("1", { album: { ...album, index: 1 }, hidden: true }),
        message("other", { album: { ...album, index: 0 } }, "messenger"),
      ],
      new Set(["zalo"]),
    )
    expect(rows.map((row) => row.items.map((item) => item.id))).toEqual([
      ["0", "1", "2"],
      ["plain-file"],
      ["other"],
    ])
  })

  test("does not displace another message at a duplicate album index", () => {
    const album = { layoutId: "batch-1", itemCount: 3, index: 0 }
    const rows = buildZaloConversationRows(
      [message("first", { album }), message("second", { album })],
      new Set(["zalo"]),
    )
    expect(rows.flatMap((row) => row.items.map((item) => item.id))).toEqual([
      "first",
      "second",
    ])
  })
})

describe("Zalo Account mention draft", () => {
  test("retains the chosen UID and UTF-16 range when emoji or decomposed Vietnamese is inserted before it", () => {
    const initial = "Hi @Anh"
    const query = findZaloMentionQuery(initial, initial.length)
    expect(query).toEqual({ start: 3, end: 7, query: "Anh" })
    const draft = applyZaloMention(
      initial,
      [],
      { start: 3, end: 7, query: "Anh" },
      { uid: "second-person", name: "Anh" },
    )
    expect(draft.text).toBe("Hi @Anh ")
    const prefix = "👩‍💻 ă "
    expect(
      updateZaloMentionRanges(draft.text, prefix + draft.text, draft.mentions),
    ).toEqual([{ uid: "second-person", offset: 3 + prefix.length, length: 4 }])
    expect(
      updateZaloMentionRanges(draft.text, "Hi @Ahn ", draft.mentions),
    ).toEqual([])
  })

  test("does not open on an email address or allow free text to become a native mention", () => {
    expect(findZaloMentionQuery("test@example.com", 16)).toBeNull()
    expect(updateZaloMentionRanges("", "@all", [])).toEqual([])
  })
})
