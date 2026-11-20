export class ReconnectPolicy {
  private readonly closes: number[] = []
  private readonly now: () => number
  private readonly random: () => number
  private attempts = 0

  constructor(
    now: () => number = Date.now,
    random: () => number = Math.random,
  ) {
    this.now = now
    this.random = random
  }

  recordPassiveClose(): { reauthorize: boolean; delayMs: number } {
    const cutoff = this.now() - 5 * 60_000
    while (this.closes[0] !== undefined && this.closes[0] < cutoff) {
      this.closes.shift()
    }
    this.closes.push(this.now())
    if (this.closes.length >= 5) {
      return { reauthorize: true, delayMs: 0 }
    }
    const base = [1000, 5000, 30_000, 120_000][Math.min(this.attempts, 3)]
    this.attempts += 1
    const jitter = Math.round(base * 0.2 * this.random())
    return { reauthorize: false, delayMs: base + jitter }
  }

  connected(): void {
    this.attempts = 0
  }

  resetManualQr(): void {
    this.closes.length = 0
    this.attempts = 0
  }
}
