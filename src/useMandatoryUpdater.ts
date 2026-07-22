import { useCallback, useEffect, useRef, useState } from 'react';

export type MandatoryUpdateState =
  | { phase: 'idle' | 'checking' }
  | { phase: 'downloading'; version: string; progress: number | null }
  | { phase: 'installing'; version: string }
  | { phase: 'error'; message: string };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function useMandatoryUpdater() {
  const [state, setState] = useState<MandatoryUpdateState>({ phase: 'idle' });
  const runningRef = useRef(false);

  const checkAndInstall = useCallback(async () => {
    if (runningRef.current || !('__TAURI_INTERNALS__' in window)) return;
    runningRef.current = true;
    setState({ phase: 'checking' });
    try {
      const [{ check }, { relaunch }] = await Promise.all([
        import('@tauri-apps/plugin-updater'),
        import('@tauri-apps/plugin-process'),
      ]);
      const update = await check({ headers: { 'Cache-Control': 'no-cache' } });
      if (!update) {
        setState({ phase: 'idle' });
        return;
      }

      let downloaded = 0;
      let total: number | null = null;
      setState({ phase: 'downloading', version: update.version, progress: null });
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') total = event.data.contentLength ?? null;
        if (event.event === 'Progress') downloaded += event.data.chunkLength;
        if (event.event === 'Started' || event.event === 'Progress') {
          setState({
            phase: 'downloading',
            version: update.version,
            progress: total ? Math.min(100, Math.round((downloaded / total) * 100)) : null,
          });
        }
        if (event.event === 'Finished') setState({ phase: 'installing', version: update.version });
      });
      setState({ phase: 'installing', version: update.version });
      await relaunch();
    } catch (error) {
      setState({ phase: 'error', message: errorMessage(error) });
    } finally {
      runningRef.current = false;
    }
  }, []);

  useEffect(() => {
    void checkAndInstall();
  }, [checkAndInstall]);

  return { state, retry: checkAndInstall };
}
