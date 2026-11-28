import { describe, expect, it } from "vitest"
import { isNewerGroupMembership } from "../src/zalo-account/group-event-order"

describe("Zalo group membership ordering", () => {
  const rejoined = {
    nativeMembershipVersion: "120",
    nativeMembershipAt: new Date(2000),
    lastSyncedAt: new Date(1000),
    providerVersion: "110",
  }

  it("rejects a replayed removal and a version regression after rejoin", () => {
    expect(
      isNewerGroupMembership(
        { timestampMs: 1800, providerVersion: "115" },
        rejoined,
      ),
    ).toBe(false)
    expect(
      isNewerGroupMembership(
        { timestampMs: 2200, providerVersion: "115" },
        rejoined,
      ),
    ).toBe(false)
    expect(
      isNewerGroupMembership(
        { timestampMs: 2100, providerVersion: "121" },
        rejoined,
      ),
    ).toBe(true)
  })

  it("does not apply destruction older than a confirmed provider snapshot", () => {
    const snapshot = {
      ...rejoined,
      providerVersion: "130",
      lastSyncedAt: new Date(3000),
    }
    expect(
      isNewerGroupMembership(
        { timestampMs: 3500, providerVersion: "121" },
        snapshot,
      ),
    ).toBe(false)
    expect(
      isNewerGroupMembership(
        { timestampMs: 2800, providerVersion: "130" },
        snapshot,
      ),
    ).toBe(false)
    expect(
      isNewerGroupMembership(
        { timestampMs: 2800, providerVersion: "131" },
        snapshot,
      ),
    ).toBe(true)
  })
})
