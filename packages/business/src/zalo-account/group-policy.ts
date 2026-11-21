const groupAutomationSteps = new Set([
  "sendText",
  "sendImage",
  "sendFile",
  "addContactTag",
  "removeContactTag",
])
export const isAllowedGroupAutomationStep = (step: string) =>
  groupAutomationSteps.has(step)

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
export const isAllowedGroupFlowStep = (value: unknown): boolean => {
  const step = record(value)
  if (!step) {
    return false
  }
  if (step.stepType === "wait") {
    return (
      step.delayType === "duration" ||
      step.delayType === "random" ||
      (step.delayType === "date" && step.dateType === "specific")
    )
  }
  return (
    typeof step.stepType === "string" &&
    isAllowedGroupAutomationStep(step.stepType) &&
    !(Array.isArray(step.buttons) && step.buttons.length)
  )
}
/** Inspect the entire published graph before enqueue; execution checks it again. */
export const isAllowedGroupFlow = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((node) => {
    const details = record(record(record(node)?.data)?.details)
    if (
      !details ||
      (Array.isArray(details.quickReplies) && details.quickReplies.length)
    ) {
      return false
    }
    return (
      (!details.beforeStep || isAllowedGroupFlowStep(details.beforeStep)) &&
      Array.isArray(details.steps) &&
      details.steps.every(isAllowedGroupFlowStep)
    )
  })

export const allowsGroupAutomation = (input: {
  accountEnabled: boolean
  accessible: boolean
  receiveEnabled: boolean
  mode: "disabled" | "mentionOnly" | "all"
  self: boolean
  accountUid: string
  mentions: readonly { uid: string }[]
}) =>
  input.accountEnabled &&
  input.accessible &&
  input.receiveEnabled &&
  !input.self &&
  input.mode !== "disabled" &&
  (input.mode === "all" ||
    input.mentions.some((mention) => mention.uid === input.accountUid))
