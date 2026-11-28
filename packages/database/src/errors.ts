export class ModelNotfoundException extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ModelNotfoundException"
  }
}

export class MessageShardConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "MessageShardConfigurationError"
  }
}

export class MessageShardUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "MessageShardUnavailableError"
  }
}

/** The exact Zalo timeline tuple could not be routed. No shard write was attempted. */
export class ZaloAccountMessageIdentityRangeUnavailableError extends MessageShardUnavailableError {
  constructor() {
    super("No registered primary covers the Zalo message identity")
    this.name = "ZaloAccountMessageIdentityRangeUnavailableError"
  }
}

export function isMessageStorageError(
  error: unknown,
): error is MessageShardConfigurationError | MessageShardUnavailableError {
  return (
    error instanceof MessageShardConfigurationError ||
    error instanceof MessageShardUnavailableError
  )
}
