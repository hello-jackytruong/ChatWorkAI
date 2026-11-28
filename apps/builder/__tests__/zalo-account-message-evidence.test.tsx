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
      <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
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
it("renders status without inline inspection controls or automatic requests", () => {
  const result = show({
    attributes: { zaloAccount: { sendAttempt: { status: "unknown" } } },
    message: { id: "12", workspaceId: "1", createdAt: new Date() },
  })
  expect(result.container.querySelector("button")).toBeNull()
  expect(result.container.textContent).toContain(
    en.zaloAccount.evidence.unknown,
  )
  expect(mocks.inspect).not.toHaveBeenCalled()
  result.unmount()
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

it.each([
  [undefined, "Sent"],
  [{ delivered: 1, seen: 0 }, "Delivered"],
  [{ delivered: 1, seen: 1 }, "Seen"],
])("reports the highest confirmed direct delivery state for %j", (receipt, label) => {
  const result = show({
    attributes: { zaloAccount: { sendAttempt: { status: "applied" } } },
    activity: {
      threadType: "user",
      outgoing: true,
      sent: true,
      receipt,
      reactions: [],
    },
  })
  expect(
    Array.from(result.container.querySelectorAll('[role="status"]')).map(
      (node) => node.textContent,
    ),
  ).toEqual([label])
  result.unmount()
})

it("shows group receipt counts and an accessible reaction detail control", () => {
  const result = show({
    attributes: { zaloAccount: {} },
    activity: {
      threadType: "group",
      outgoing: true,
      sent: true,
      receipt: { delivered: 3, seen: 2 },
      reactions: [
        { key: "heart", count: 2 },
        { key: "like", count: 1 },
      ],
      loadDetails: vi.fn().mockResolvedValue({ receipts: [], reactions: [] }),
    },
  })
  expect(result.container.textContent).toContain("Delivered to 3")
  expect(result.container.textContent).toContain("Seen by 2")
  expect(
    result.container.querySelector('button[aria-label="View reactions"]')
      ?.textContent,
  ).toContain("3")
  result.unmount()
})

it("loads per-message reaction details on demand and filters under provider emoji aliases", async () => {
  const loadDetails = vi.fn().mockResolvedValue({
    receipts: [],
    reactions: [
      { actorId: "unknown-provider-uid", reaction: "/-heart" },
      { actorId: "u2", reaction: "/-strong", timestampMs: 1_700_000_000_000 },
    ],
  })
  const result = show({
    attributes: { zaloAccount: {} },
    activity: {
      threadType: "user",
      outgoing: false,
      sent: false,
      reactions: [
        { key: "heart", count: 1 },
        { key: "like", count: 1 },
      ],
      actorName: (uid) => (uid === "u2" ? "Linh" : undefined),
      loadDetails,
    },
  })
  try {
    expect(loadDetails).not.toHaveBeenCalled()
    await act(async () =>
      result.container
        .querySelector<HTMLButtonElement>('button[aria-label="View reactions"]')
        ?.click(),
    )
    expect(loadDetails).toHaveBeenCalledTimes(1)
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain("Unknown participant")
    expect(dialog?.textContent).not.toContain("unknown-provider-uid")
    expect(dialog?.textContent).toContain("Linh")
    const likeFilter = Array.from(
      dialog?.querySelectorAll("button") ?? [],
    ).find((button) => button.textContent === "👍 1")
    act(() => likeFilter?.click())
    expect(dialog?.textContent).not.toContain("Unknown participant")
    expect(dialog?.textContent).toContain("Linh")
  } finally {
    result.unmount()
  }
})

it("dispatches selected changes and removal without inventing reaction chips", async () => {
  const changeReaction = vi.fn().mockResolvedValue(true)
  const result = show({
    attributes: { zaloAccount: {} },
    activity: {
      threadType: "group",
      outgoing: false,
      sent: false,
      reactions: [],
      changeReaction,
    },
  })
  try {
    const trigger = result.container.querySelector<HTMLButtonElement>(
      'button[aria-label="React to message"]',
    )
    expect(trigger).not.toBeNull()
    for (const [label, choice] of [
      ["React with ❤️", "heart"],
      ["React with 👍", "like"],
      ["Remove reaction", null],
    ]) {
      await act(async () => trigger?.click())
      const action = Array.from(document.querySelectorAll("button")).find(
        (button) =>
          button.getAttribute("aria-label") === label ||
          button.textContent === label,
      )
      expect(action).toBeDefined()
      await act(async () => action?.click())
      expect(changeReaction).toHaveBeenLastCalledWith(choice)
      expect(
        result.container.querySelector('button[aria-label="View reactions"]'),
      ).toBeNull()
    }
    expect(changeReaction).toHaveBeenCalledTimes(3)
  } finally {
    result.unmount()
  }
})
