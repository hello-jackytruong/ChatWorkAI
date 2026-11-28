import type { ZaloAccountProfile } from "@chatbotx.io/sdk"
import { expect, it } from "vitest"
import { mergeZaloAccountProfileEvidence } from "../src/repositories/integration-zalo-account/profile-evidence"

const snapshot = (
  fields: ZaloAccountProfile["fields"],
): ZaloAccountProfile => ({
  uid: "42",
  fields,
})
const detail = (fields: ZaloAccountProfile["fields"], observedAt: number) =>
  mergeZaloAccountProfileEvidence(undefined, snapshot(fields), {
    observedAt: new Date(observedAt),
    detail: true,
  })

it("preserves source evidence but hides fields absent from the latest authoritative read", () => {
  const publicPhone = {
    value: "+12025550101",
    source: "getUserInfo",
    observedAt: 100,
  } as const
  const birthDate = {
    value: "2002",
    source: "getUserInfo",
    observedAt: 100,
  } as const
  const original = detail({ birthDate, publicPhone }, 100)
  const latest = mergeZaloAccountProfileEvidence(
    original,
    snapshot({
      birthDate: { ...birthDate, observedAt: 200 },
    }),
    { observedAt: new Date(200), detail: true },
  )
  expect(latest.fields.publicPhone).toEqual(publicPhone)
  expect(latest.fields.birthDate?.value).toBe("2002")
  expect(latest.visibleFields).toEqual(["birthDate"])
  const friend = mergeZaloAccountProfileEvidence(
    latest,
    snapshot({
      publicPhone: { ...publicPhone, source: "getAllFriends", observedAt: 300 },
    }),
    { observedAt: new Date(300) },
  )
  expect(friend.fields.publicPhone).toEqual(publicPhone)
  expect(friend.visibleFields).toEqual(["birthDate"])
})

it("preserves newer detail and the privacy mask against stale provider detail and weaker sources", () => {
  const zaloName = {
    value: "Provider",
    source: "getUserInfo",
    observedAt: 200,
  } as const
  const original = detail({ zaloName }, 200)
  const old = mergeZaloAccountProfileEvidence(
    original,
    snapshot({
      zaloName: { ...zaloName, value: "Stale", observedAt: 100 },
      publicPhone: {
        value: "+12025550101",
        source: "getUserInfo",
        observedAt: 100,
      },
    }),
    { observedAt: new Date(100), detail: true },
  )
  expect(old.fields.zaloName).toEqual(zaloName)
  expect(old.visibleFields).toEqual(["zaloName"])
  const lowerSource = mergeZaloAccountProfileEvidence(
    old,
    snapshot({
      zaloName: {
        ...zaloName,
        value: "Alias",
        source: "getAllFriends",
        observedAt: 300,
      },
    }),
    { observedAt: new Date(300) },
  )
  expect(lowerSource.fields.zaloName).toEqual(zaloName)
  expect(lowerSource.detailObservedAt).toEqual(new Date(200))
})

it("keeps sparse friend observations safe and clamps field observation time", () => {
  const result = mergeZaloAccountProfileEvidence(
    undefined,
    snapshot({
      displayName: {
        value: "Friend alias",
        source: "getAllFriends",
        observedAt: 99_999,
      },
      publicPhone: {
        value: "+12025550101",
        source: "getAllFriends",
        observedAt: 50,
      },
    }),
    { observedAt: new Date(100) },
  )
  expect(result.visibleFields).toEqual(["displayName"])
  expect(result.fields.displayName?.observedAt).toBe(100)
})
