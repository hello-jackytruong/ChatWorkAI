type FailureWindow = {
  failures: number[]
  openUntil: number
  expiresAt?: number
}

type AdmissionOptions = {
  accountCooldownMs?: number
  accountFailureThreshold?: number
  now?: () => number
  providerCooldownMs?: number
  providerFailureThreshold?: number
  windowMs?: number
}

export type ProviderAdmissionPort = {
  check: (accountId?: string) => number
  recordFailure: (accountId?: string) => void
  recordSuccess: (accountId?: string) => void
}

export class ZaloAccountProviderAdmission implements ProviderAdmissionPort {
  private readonly accounts = new Map<string, FailureWindow>()
  private lastSweep = 0
  private sweep: IterableIterator<[string, FailureWindow]> | undefined
  private readonly now: () => number
  private readonly options: Required<Omit<AdmissionOptions, "now">>
  private readonly provider: FailureWindow = { failures: [], openUntil: 0 }

  constructor(options: AdmissionOptions = {}) {
    this.now = options.now ?? Date.now
    this.options = {
      accountCooldownMs: options.accountCooldownMs ?? 15_000,
      accountFailureThreshold: options.accountFailureThreshold ?? 3,
      providerCooldownMs: options.providerCooldownMs ?? 30_000,
      providerFailureThreshold: options.providerFailureThreshold ?? 5,
      windowMs: options.windowMs ?? 60_000,
    }
  }

  check(accountId?: string): number {
    const now = this.now()
    this.prune(now)
    if (accountId) {
      const existing = this.accounts.get(accountId)
      if (existing && (existing.expiresAt ?? Number.POSITIVE_INFINITY) <= now) {
        this.accounts.delete(accountId)
      }
      if (!this.accounts.has(accountId) && this.accounts.size >= 4096) {
        return 30_000
      }
    }
    const providerDelay = Math.max(0, this.provider.openUntil - now)
    const account = accountId ? this.accounts.get(accountId) : undefined
    const accountDelay = Math.max(0, (account?.openUntil ?? 0) - now)
    return Math.max(providerDelay, accountDelay)
  }

  recordFailure(accountId?: string): void {
    this.addFailure(
      this.provider,
      this.options.providerFailureThreshold,
      this.options.providerCooldownMs,
    )
    if (accountId) {
      this.prune(this.now())
      if (!this.accounts.has(accountId) && this.accounts.size >= 4096) {
        return
      }
      const account = this.accounts.get(accountId) ?? {
        failures: [],
        openUntil: 0,
      }
      account.expiresAt =
        this.now() +
        Math.max(this.options.windowMs, this.options.accountCooldownMs)
      this.accounts.set(accountId, account)
      this.addFailure(
        account,
        this.options.accountFailureThreshold,
        this.options.accountCooldownMs,
      )
    }
  }

  recordSuccess(accountId?: string): void {
    this.provider.failures.length = 0
    this.provider.openUntil = 0
    if (accountId) {
      this.accounts.delete(accountId)
    }
  }

  private prune(now: number): void {
    if (now - this.lastSweep < 30_000) {
      return
    }
    this.lastSweep = now
    this.sweep ??= this.accounts.entries()
    for (let i = 0; i < 64; i++) {
      const next = this.sweep.next()
      if (next.done) {
        this.sweep = undefined
        break
      }
      const [key, entry] = next.value
      if ((entry.expiresAt ?? Number.POSITIVE_INFINITY) <= now) {
        this.accounts.delete(key)
      }
    }
  }

  private addFailure(
    state: FailureWindow,
    threshold: number,
    cooldownMs: number,
  ): void {
    const now = this.now()
    const cutoff = now - this.options.windowMs
    state.failures = state.failures.filter((at) => at >= cutoff)
    state.failures.push(now)
    if (state.failures.length >= threshold) {
      state.openUntil = now + cooldownMs
      state.failures.length = 0
    }
  }
}
