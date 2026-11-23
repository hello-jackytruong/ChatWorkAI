import { expect, it } from "vitest"
import { zaloAccountNativeOperationSchema } from "../src/lib/zalo-account"

const operation = {
  operation: "deleteMessage",
  attemptCommandId: "cmd",
  requestHash: "hash",
  threadType: "user",
  threadId: "thread",
  providerMessageId: "provider",
  providerClientMessageId: "client",
  providerOwnerId: "owner",
}
it("requires a real complete provider tuple", () => {
  expect(
    zaloAccountNativeOperationSchema.safeParse({
      ...operation,
      providerClientMessageId: "",
    }).success,
  ).toBe(false)
  expect(zaloAccountNativeOperationSchema.safeParse(operation).success).toBe(
    true,
  )
})
it("never accepts a caller onlyMe override or moderation target flag", () => {
  expect(
    zaloAccountNativeOperationSchema.safeParse({ ...operation, onlyMe: false })
      .success,
  ).toBe(false)
  expect(
    zaloAccountNativeOperationSchema.safeParse({ ...operation, isSelf: true })
      .success,
  ).toBe(false)
})
