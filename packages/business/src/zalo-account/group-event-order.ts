const numericVersionPattern = /^\d{1,30}$/
const numericVersion = (value?: string | null): bigint | null =>
  value && numericVersionPattern.test(value) ? BigInt(value) : null

export function compareGroupEventVersion(
  next?: string | null,
  previous?: string | null,
): number | null {
  const a = numericVersion(next)
  const b = numericVersion(previous)
  if (a === null || b === null) {
    return null
  }
  if (a === b) {
    return 0
  }
  return a > b ? 1 : -1
}

export function isNewerGroupMembership(
  event: { timestampMs: number; providerVersion?: string },
  group: {
    nativeMembershipVersion: string | null
    nativeMembershipAt: Date | null
    lastSyncedAt: Date
    providerVersion: string | null
  },
): boolean {
  const version = compareGroupEventVersion(
    event.providerVersion,
    group.nativeMembershipVersion,
  )
  if (
    (version !== null && version < 0) ||
    (group.nativeMembershipAt &&
      event.timestampMs <= group.nativeMembershipAt.getTime())
  ) {
    return false
  }
  const snapshotVersion = compareGroupEventVersion(
    event.providerVersion,
    group.providerVersion,
  )
  return (
    snapshotVersion !== -1 &&
    (snapshotVersion === 1 || event.timestampMs > group.lastSyncedAt.getTime())
  )
}
