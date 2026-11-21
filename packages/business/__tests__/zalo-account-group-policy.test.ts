import { describe, expect, it } from "vitest"
import {
  allowsGroupAutomation,
  isAllowedGroupAutomationStep,
  isAllowedGroupFlow,
  isAllowedGroupFlowStep,
} from "../src/zalo-account/group-policy"

describe("group automation admission", () => {
  it("allows static waits as control flow while refusing customer-field waits and interactive actions", () => {
    expect(
      isAllowedGroupFlowStep({ stepType: "wait", delayType: "duration" }),
    ).toBe(true)
    expect(
      isAllowedGroupFlowStep({
        stepType: "wait",
        delayType: "date",
        dateType: "dynamic",
      }),
    ).toBe(false)
    expect(
      isAllowedGroupFlowStep({
        stepType: "sendText",
        buttons: [{ actions: [{ stepType: "callApi" }] }],
      }),
    ).toBe(false)
    expect(
      isAllowedGroupFlow([
        {
          data: {
            details: {
              steps: [
                { stepType: "sendText" },
                { stepType: "wait", delayType: "duration" },
              ],
            },
          },
        },
      ]),
    ).toBe(true)
    expect(
      isAllowedGroupFlow([
        {
          data: { details: { beforeStep: { stepType: "callApi" }, steps: [] } },
        },
      ]),
    ).toBe(false)
  })
  const base = {
    accountEnabled: true,
    accessible: true,
    receiveEnabled: true,
    mode: "mentionOnly" as const,
    self: false,
    accountUid: "self",
    mentions: [{ uid: "self" }],
  }
  it("uses exact UID mentions, never names or all-member markers", () => {
    expect(allowsGroupAutomation(base)).toBe(true)
    expect(allowsGroupAutomation({ ...base, mentions: [{ uid: "-1" }] })).toBe(
      false,
    )
    expect(allowsGroupAutomation({ ...base, mentions: [] })).toBe(false)
    expect(allowsGroupAutomation({ ...base, self: true })).toBe(false)
  })
  it("fails closed for disabled account, receive, accessibility or automation", () => {
    for (const patch of [
      { accountEnabled: false },
      { receiveEnabled: false },
      { accessible: false },
      { mode: "disabled" as const },
    ]) {
      expect(allowsGroupAutomation({ ...base, ...patch })).toBe(false)
    }
  })
  it("has a closed action allowlist so new steps cannot gain group side effects", () => {
    for (const step of [
      "sendText",
      "sendImage",
      "sendFile",
      "addContactTag",
      "removeContactTag",
    ]) {
      expect(isAllowedGroupAutomationStep(step)).toBe(true)
    }
    for (const step of [
      "callApi",
      "executeJavascript",
      "deleteContact",
      "addContactNotes",
      "addToSequence",
      "aiAgent",
      "autoAssignConversation",
      "futureStep",
    ]) {
      expect(isAllowedGroupAutomationStep(step)).toBe(false)
    }
  })
})
