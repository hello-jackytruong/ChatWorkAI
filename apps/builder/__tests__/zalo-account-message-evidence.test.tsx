// @vitest-environment jsdom

import { NextIntlClientProvider } from "next-intl"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import en from "../messages/en.json"
import {
  canResendZaloMessage,
  ZaloMessageEvidence,
} from "../src/features/messages/components/zalo-message-evidence"

const mocks = vi.hoisted(() => ({ inspect: vi.fn() }))
vi.mock(
  "../src/features/zalo-accounts/actions/account-operations.action",
  () => ({ inspectZaloAccountMessageAction: mocks.inspect }),
)
const show = (props: React.ComponentProps<typeof ZaloMessageEvidence>) => {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  act(() =>
    root.render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ZaloMessageEvidence {...props} />
      </NextIntlClientProvider>,
    ),
  )
  return {
    container,
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}
it.each([
  "unsupported_content",
  "invalid_content",
  "unsupported_schema",
])("renders safe localized evidence for direct and group %s", (reason) => {
  for (const zaloAccount of [
    { unsupported: { reason } },
    { group: { unsupported: { reason } } },
  ]) {
    const result = show({ attributes: { zaloAccount, raw: "SECRET_RAW" } })
    expect(result.container.textContent?.trim()).toBeTruthy()
    expect(result.container.textContent).not.toContain("SECRET_RAW")
    expect(result.container.textContent).not.toContain("zaloAccount.")
    result.unmount()
  }
})
it("does not inspect automatically, hides inspection without permission and never renders raw error", async () => {
  const attributes = { zaloAccount: { sendAttempt: { status: "unknown" } } }
  const message = {
    id: "12",
    workspaceId: "1",
    createdAt: new Date("2026-11-23T00:00:00Z"),
  }
  const first = show({
    attributes,
    message,
    inspect: { accountId: "2", canInspect: false },
  })
  expect(first.container.querySelector("button")).toBeNull()
  first.unmount()
  mocks.inspect.mockResolvedValue({
    data: { status: "applied", reconciliation: { state: "pending" } },
  })
  const second = show({
    attributes,
    message,
    inspect: { accountId: "2", canInspect: true },
  })
  expect(mocks.inspect).not.toHaveBeenCalled()
  await act(async () => second.container.querySelector("button")?.click())
  expect(mocks.inspect).toHaveBeenCalledWith("1", "2", {
    messageId: "12",
    messageCreatedAt: message.createdAt,
  })
  expect(
    second.container.querySelector('[role="status"]')?.textContent,
  ).toContain(en.zaloAccount.evidence.appliedPending)
  second.unmount()
})

it("permits only proven predispatch Zalo failures to offer resend and preserves other channels", () => {
  const errorInfo = {
    code: "pre_dispatch_failed",
    phase: "validation",
    safeAction: "new_attempt",
  }
  for (const status of ["pending", "unknown", "applied"]) {
    expect(
      canResendZaloMessage({
        zaloAccount: { sendAttempt: { status, errorInfo } },
      }),
    ).toBe(false)
  }
  expect(
    canResendZaloMessage({
      zaloAccount: { sendAttempt: { status: "failed", errorInfo } },
    }),
  ).toBe(true)
  expect(
    canResendZaloMessage({
      zaloAccount: {
        sendAttempt: {
          status: "failed",
          errorInfo: { ...errorInfo, phase: "dispatch" },
        },
      },
    }),
  ).toBe(false)
  expect(
    canResendZaloMessage({
      zaloAccount: {
        sendAttempt: {
          status: "failed",
          errorInfo,
          reconciliation: { state: "needs_review" },
        },
      },
    }),
  ).toBe(false)
  expect(canResendZaloMessage({ zaloAccount: {} })).toBe(false)
  expect(canResendZaloMessage({ whatsapp: {} })).toBe(true)
})

it("keeps legacy Zalo failures safe until their durable outcome is inspected", () => {
  const result = show({
    attributes: { zaloAccount: { providerMessageId: "legacy" } },
    message: {
      id: "12",
      workspaceId: "1",
      createdAt: new Date(),
      sendError: "SECRET provider credentials",
    },
  })
  expect(result.container.textContent).toContain(
    en.zaloAccount.evidence.unknown,
  )
  expect(result.container.textContent).not.toContain("SECRET")
  expect(
    canResendZaloMessage({ zaloAccount: { providerMessageId: "legacy" } }),
  ).toBe(false)
  result.unmount()
})
