export const zaloAccountErrors = {
  zaloPolicyChanged: {
    message: "Zalo group policy changed; queued work was fenced",
    status: 409,
  },
  zaloGroupSendDisabled: {
    message: "Zalo group sending is disabled",
    status: 409,
  },
  zaloCommandConflict: {
    message: "Zalo command ID was reused for different content",
    status: 409,
  },
  zaloSendNotReplayable: {
    message:
      "Zalo send was rejected or its outcome is unknown; inspect the durable attempt",
    status: 409,
  },
  zaloSendPending: {
    message: "Zalo send is pending; inspect the durable attempt",
    status: 409,
  },
} as const
