import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import {
  getZaloGroupConversation,
  getZaloGroupMessage,
  splitZaloMentions,
} from "../../../zalo-accounts/lib/group-content"
import { ZaloGroupText } from "../zalo-group-text"

const payload = {
  threadType: "group",
  threadId: "g",
  providerMessageId: "m",
  senderId: "member-1",
  senderName: "Alice",
  timestampMs: 100,
  msgType: "webchat",
  isSelf: false,
  text: "Hi @Bob",
  attachments: [],
  mentions: [{ uid: "member-2", offset: 3, length: 4, type: 0 }],
}
it("keeps two senders in one group without deriving customer identities", () => {
  expect(
    getZaloGroupMessage({ zaloAccount: { group: payload } })?.senderName,
  ).toBe("Alice")
  expect(
    getZaloGroupMessage({
      zaloAccount: {
        group: { ...payload, senderId: "member-2", senderName: "Bob" },
      },
    })?.senderName,
  ).toBe("Bob")
  expect(
    getZaloGroupConversation({
      sourceId: "za:group:g",
      additionalAttributes: {
        audience: {
          kind: "zaloAccountGroup",
          accountId: "a",
          groupId: "resource",
          providerGroupId: "g",
          memberCount: 3,
        },
      },
    }),
  ).toEqual(expect.objectContaining({ groupId: "resource", memberCount: 3 }))
  expect(
    getZaloGroupConversation({ sourceId: null, additionalAttributes: {} }),
  ).toBeNull()
})
it("renders validated mention spans as text and escapes untrusted names", () => {
  const text = "Hi @Bob <script>"
  const html = renderToStaticMarkup(
    <ZaloGroupText mentions={payload.mentions} text={text} />,
  )
  expect(html).toContain("<mark")
  expect(html).toContain("@Bob")
  expect(html).toContain("&lt;script&gt;")
  expect(html).not.toContain("<script>")
})
it("ignores overlapping or out-of-range mention spans without losing text", () => {
  const parts = splitZaloMentions("Hi @Bob", [
    ...payload.mentions,
    { uid: "other", offset: 4, length: 3, type: 0 },
    { uid: "bad", offset: 99, length: 2, type: 0 },
  ])
  expect(parts.map((part) => part.text).join("")).toBe("Hi @Bob")
  expect(parts.filter((part) => part.uid)).toHaveLength(1)
})
