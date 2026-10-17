// Share a generated file through the native iOS share sheet (in the app), the
// Web Share API (Safari), or a download as a last resort.
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export type ShareOutcome = 'shared' | 'cancelled' | 'downloaded';

export async function shareFile(blob: Blob, fileName: string, title: string, text: string): Promise<ShareOutcome> {
  if (Capacitor.isNativePlatform()) {
    const { uri } = await Filesystem.writeFile({ path: fileName, data: await toBase64(blob), directory: Directory.Cache });
    try {
      await Share.share({ title, text, files: [uri], dialogTitle: title });
      return 'shared';
    } catch (e) {
      if (/cancel/i.test(String(e))) return 'cancelled';
      throw e;
    }
  }
  const file = new File([blob], fileName, { type: blob.type || 'application/pdf' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title, text });
      return 'shared';
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return 'cancelled';
      throw e;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fileName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return 'downloaded';
}
