import { expect, it, vi } from "vitest"

const project = vi.hoisted(() =>
  vi
    .fn()
    .mockResolvedValue(
      new Map([
        [
          JSON.stringify(["a", "account", "a"]),
          { avatarUrl: "https://signed.test/avatar" },
        ],
      ]),
    ),
)
vi.mock("@chatbotx.io/business/zalo-account-media", () => ({
  zaloAccountMediaReadService: { projectProfiles: project },
}))

import { toZaloAccountResources } from "../lib/to-resource"

it("batch projects account avatars without leaking stored object keys", async () => {
  const time = new Date("2026-11-23T00:00:00Z")
  const account = {
    id: "a",
    workspaceId: "w",
    inboxId: "i",
    zaloUid: "u",
    name: "User",
    avatarUrl: "https://provider.test/a?token=secret",
    sessionVerifiedAt: time,
    createdAt: time,
    updatedAt: time,
  }
  const result = await toZaloAccountResources([account as never])
  expect(result[0]?.avatarUrl).toBe("https://signed.test/avatar")
  expect(project).toHaveBeenCalledTimes(1)
})
