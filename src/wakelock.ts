// Keeps the screen awake while processing/exporting; re-acquires the lock if
// the system releases it (e.g. after the page was hidden).
export class WakeLockKeeper {
  private sentinel: WakeLockSentinel | null = null;
  private wanted = false;
  status = 'off';
  onChange?: (status: string) => void;

  constructor() {
    document.addEventListener('visibilitychange', () => {
      if (this.wanted && document.visibilityState === 'visible') void this.acquire();
    });
  }

  async enable(): Promise<void> {
    this.wanted = true;
    await this.acquire();
  }

  async disable(): Promise<void> {
    this.wanted = false;
    const s = this.sentinel;
    this.sentinel = null;
    if (s && !s.released) await s.release().catch(() => {});
    this.set('off');
  }

  private async acquire(): Promise<void> {
    if (!('wakeLock' in navigator)) { this.set('unsupported'); return; }
    if (this.sentinel && !this.sentinel.released) return;
    try {
      const s = await navigator.wakeLock.request('screen');
      this.sentinel = s;
      this.set('on');
      s.addEventListener('release', () => {
        if (this.sentinel === s) this.sentinel = null;
        if (this.wanted) {
          this.set('released – re-acquiring');
          if (document.visibilityState === 'visible') void this.acquire();
        }
      });
    } catch (e) {
      this.set(`failed: ${(e as Error).message}`);
    }
  }

  private set(s: string) { this.status = s; this.onChange?.(s); }
}
