// Keeps the screen awake while processing/exporting; re-acquires the lock if
// the system releases it (e.g. after the page was hidden). In the native iOS
// app (Capacitor/WKWebView) the Screen Wake Lock API may be missing, so the
// native idle-timer plugin is used instead.
import { Capacitor } from '@capacitor/core';
import { KeepAwake } from '@capacitor-community/keep-awake';

const native = Capacitor.isNativePlatform();

export class WakeLockKeeper {
  private sentinel: WakeLockSentinel | null = null;
  private wanted = false;
  status = 'off';
  onChange?: (status: string) => void;

  constructor() {
    document.addEventListener('visibilitychange', () => {
      if (this.wanted && !native && document.visibilityState === 'visible') void this.acquire();
    });
  }

  async enable(): Promise<void> {
    this.wanted = true;
    if (native) {
      try { await KeepAwake.keepAwake(); this.set('on (native)'); } catch (e) { this.set(`failed: ${String(e)}`); }
      return;
    }
    await this.acquire();
  }

  async disable(): Promise<void> {
    this.wanted = false;
    if (native) {
      await KeepAwake.allowSleep().catch(() => {});
      this.set('off');
      return;
    }
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
