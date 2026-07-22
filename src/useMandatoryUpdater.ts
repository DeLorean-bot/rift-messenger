import { useEffect, useState } from 'react';

export type MandatoryUpdateState =
  | { phase: 'idle' | 'checking' }
  | { phase: 'downloading'; version: string; progress: number | null }
  | { phase: 'installing'; version: string }
  | { phase: 'error'; message: string };

/**
 * Blocking mandatory updater. The Electron main process drives electron-updater
 * against GitHub releases and streams events here; when an update finishes
 * downloading it installs and relaunches automatically.
 */
export function useMandatoryUpdater() {
  const [state, setState] = useState<MandatoryUpdateState>({ phase: 'idle' });

  useEffect(() => {
    const desktop = window.riftDesktop;
    if (!desktop) return;
    const off = desktop.updater.onEvent((event) => {
      switch (event.status) {
        case 'checking':
          setState({ phase: 'checking' });
          break;
        case 'idle':
          setState({ phase: 'idle' });
          break;
        case 'downloading':
          setState({ phase: 'downloading', version: event.version || '', progress: event.percent ?? null });
          break;
        case 'installing':
          setState({ phase: 'installing', version: event.version || '' });
          break;
        case 'error':
          setState({ phase: 'error', message: event.message });
          break;
      }
    });
    return off;
  }, []);

  const retry = () => {
    void window.riftDesktop?.updater.check();
  };

  return { state, retry };
}
