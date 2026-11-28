import {
  zaloAccountAlbumSchema,
  zaloAccountGroupMembersQuerySchema,
  zaloAccountSendContentSchema,
} from "@chatbotx.io/sdk"
import { describe, expect, it } from "vitest"

describe("Zalo Account conversation context", () => {
  it("keeps zero-based provider album positions bounded by the item count", () => {
    expect(
      zaloAccountAlbumSchema.parse({
        layoutId: "native-layout",
        index: 0,
        itemCount: 2,
      }),
    ).toEqual({ layoutId: "native-layout", index: 0, itemCount: 2 })
    expect(
      zaloAccountAlbumSchema.safeParse({
        layoutId: "native-layout",
        index: 2,
        itemCount: 2,
      }).success,
    ).toBe(false)
  })

  it("bounds the roster query and treats whitespace-only filters as absent", () => {
    expect(
      zaloAccountGroupMembersQuerySchema.parse({ query: "   " }),
    ).toMatchObject({
      query: undefined,
      limit: 20,
    })
    expect(
      zaloAccountGroupMembersQuerySchema.safeParse({ limit: 51 }).success,
    ).toBe(false)
  })

  it("preserves mention offsets with ZWJ and decomposed accents alongside styles", () => {
    const prefix = "Hi "
    const token = "@👩‍💻 Ha\u0300"
    const content = {
      kind: "text",
      text: prefix + token,
      styles: [{ st: "b", start: prefix.length, len: token.length }],
      mentions: [
        { uid: "member-1", offset: prefix.length, length: token.length },
      ],
    }
    expect(zaloAccountSendContentSchema.parse(content)).toEqual(content)
    for (const mentions of [
      [{ ...content.mentions[0], uid: "-1" }],
      [{ ...content.mentions[0], length: 3 }],
      [{ ...content.mentions[0], length: token.length - 1 }],
      [{ ...content.mentions[0], offset: 0 }],
      [content.mentions[0], { ...content.mentions[0], uid: "member-2" }],
    ]) {
      expect(
        zaloAccountSendContentSchema.safeParse({ ...content, mentions })
          .success,
      ).toBe(false)
    }
  })
})
