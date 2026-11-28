import { expect, it } from "vitest"
import { normalizeZaloProfile } from "../src/runtime/provider-profile"

it("keeps Zalo and account display names separate and records field provenance", () => {
  expect(
    normalizeZaloProfile({
      uid: "42",
      source: "getUserInfo",
      observedAt: 1000,
      data: {
        userId: "42",
        zaloName: "Tên gốc",
        displayName: "Tên trên tài khoản",
        globalId: "global-example",
        sdob: "2002",
        phoneNumber: "+12025550101",
      },
    }),
  ).toMatchObject({
    uid: "42",
    fields: {
      zaloName: { value: "Tên gốc", source: "getUserInfo", observedAt: 1000 },
      displayName: {
        value: "Tên trên tài khoản",
        source: "getUserInfo",
        observedAt: 1000,
      },
      birthDate: { value: "2002" },
      publicPhone: { value: "+12025550101" },
    },
  })
})

it("accepts sparse find-user shapes, keeps real date precision and excludes unsafe links", () => {
  const result = normalizeZaloProfile({
    uid: "42",
    source: "findUser",
    observedAt: 1000,
    data: {
      uid: "42",
      zalo_name: "Provider name",
      sdob: "29/02/2024",
      avatar: "https://user:password@example.test/avatar",
    },
  })
  expect(result.fields).toMatchObject({
    zaloName: { value: "Provider name" },
    birthDate: { value: "2024-02-29" },
  })
  expect(result.fields).not.toHaveProperty("avatarUrl")
  expect(result.fields).not.toHaveProperty("publicPhone")
})

it("does not project a mismatched or empty provider profile", () => {
  expect(
    normalizeZaloProfile({
      uid: "42",
      source: "getAllFriends",
      observedAt: 1000,
      data: { userId: "99", displayName: "Other person" },
    }).fields,
  ).toEqual({})
})
