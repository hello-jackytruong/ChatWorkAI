// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { NextIntlClientProvider } from "next-intl"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import en from "../messages/en.json"
import { ZaloMemberIdentity } from "../src/features/messages/components/zalo-member-identity"

const mocks = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock("@/features/zalo-accounts/actions/profile.action", () => ({
  getZaloProfileAction: mocks.get,
}))

const target = {
  workspaceId: "1",
  accountId: "2",
  conversationId: "3",
  contactInboxId: "4",
  memberUid: "12345",
}
const sourceProfile = {
  profile: {
    uid: "12345",
    fields: {
      zaloName: "Thu Nguyen",
      birthDate: "1990",
    },
  },
  staleness: "fresh",
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
let client: QueryClient

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  mocks.get.mockReset()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  client.clear()
  host.remove()
})

function view(accountId = target.accountId, direct = false) {
  const profileTarget = direct
    ? {
        workspaceId: target.workspaceId,
        accountId: null,
        conversationId: target.conversationId,
        contactInboxId: target.contactInboxId,
      }
    : { ...target, accountId }
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
          <ZaloMemberIdentity
            crmName={direct ? "Edited CRM contact" : undefined}
            key={accountId}
            name="Thu"
            profileTarget={profileTarget}
            uid={target.memberUid}
          />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    ),
  )
}

async function open(profileName: string) {
  await act(async () => host.querySelector("button")?.click())
  await vi.waitFor(async () => {
    await act(async () => undefined)
    expect(document.body.textContent).toContain(profileName)
  })
}

it("loads the scoped sender profile only after opening and preserves a year-only birth date", async () => {
  mocks.get.mockResolvedValue({ data: sourceProfile })
  view()
  expect(mocks.get).not.toHaveBeenCalled()
  await open("Thu Nguyen")
  expect(mocks.get).toHaveBeenCalledOnce()
  expect(mocks.get).toHaveBeenCalledWith("1", "2", {
    conversationId: "3",
    contactInboxId: "4",
    memberUid: "12345",
    refresh: false,
  })
  expect(document.body.textContent).toContain("Thu Nguyen")
  expect(document.body.textContent).not.toContain("Public phone (unverified)")
  expect(document.body.textContent).toContain("1990")
  expect(document.body.textContent).not.toContain("January")
})

it("labels a permitted public direct phone as unverified and separates the CRM contact name", async () => {
  mocks.get.mockResolvedValue({
    data: {
      ...sourceProfile,
      profile: {
        ...sourceProfile.profile,
        fields: {
          ...sourceProfile.profile.fields,
          publicPhone: "+84900111222",
        },
      },
    },
  })
  view("2", true)
  await open("Thu Nguyen")
  expect(mocks.get).toHaveBeenCalledWith("1", null, {
    conversationId: "3",
    contactInboxId: "4",
    refresh: false,
  })
  expect(document.body.textContent).toContain("Public phone (unverified)")
  expect(document.body.textContent).toContain("Edited CRM contact")
})

it("does not reuse one account's profile cache for the same UID in another account", async () => {
  mocks.get
    .mockResolvedValueOnce({ data: sourceProfile })
    .mockResolvedValueOnce({
      data: {
        ...sourceProfile,
        profile: {
          ...sourceProfile.profile,
          fields: { zaloName: "Another account name" },
        },
      },
    })
  view()
  await open("Thu Nguyen")
  expect(document.body.textContent).toContain("Thu Nguyen")
  view("5")
  await open("Another account name")
  expect(mocks.get).toHaveBeenLastCalledWith(
    "1",
    "5",
    expect.objectContaining({ memberUid: "12345" }),
  )
  expect(document.body.textContent).toContain("Another account name")
  expect(document.body.textContent).not.toContain("Thu Nguyen")
})

it("keeps stale profile data when the open-time refresh fails and loads a full avatar only on request", async () => {
  mocks.get
    .mockResolvedValueOnce({ data: { ...sourceProfile, staleness: "stale" } })
    .mockResolvedValueOnce({ serverError: "sensitive provider error" })
    .mockResolvedValueOnce({ data: sourceProfile })
  view()
  await open("Thu Nguyen")
  expect(mocks.get).toHaveBeenCalledTimes(2)
  expect(mocks.get).toHaveBeenLastCalledWith("1", "2", {
    conversationId: "3",
    contactInboxId: "4",
    memberUid: "12345",
    refresh: true,
  })
  expect(document.body.textContent).toContain(
    "Showing the last available Zalo profile.",
  )
  expect(document.body.textContent).toContain("Thu Nguyen")
  expect(document.body.textContent).not.toContain("sensitive provider error")
  const refresh = Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent === "Refresh Zalo profile",
  )
  expect(refresh).toBeDefined()
  await act(async () => refresh?.click())
  await vi.waitFor(async () => {
    await act(async () => undefined)
    expect(document.body.textContent).not.toContain(
      "Showing the last available Zalo profile.",
    )
  })
  expect(mocks.get).toHaveBeenLastCalledWith("1", "2", {
    conversationId: "3",
    contactInboxId: "4",
    memberUid: "12345",
    refresh: true,
    largeAvatar: true,
  })
  expect(document.body.textContent).not.toContain(
    "Showing the last available Zalo profile.",
  )
})
