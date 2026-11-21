import { describe, expect, it } from "vitest"
import { personContactWhere } from "../src/repositories/contact/person-boundary"

describe("person Contact boundary", () => {
  it("cannot be overridden by a caller's kind or OR filters", () => {
    const input = { workspaceId: "1", kind: "channelGroup", OR: [{ id: "2" }] }
    expect(personContactWhere(input)).toEqual({
      AND: [input, { kind: "person" }],
    })
    expect(input.kind).toBe("channelGroup")
  })
})
