export type DesktopSource = {
  id: string;
  name: string;
  thumbnail: string;
  appIcon: string | null;
  isScreen: boolean;
};

export type UpdaterEvent =
  | { status: 'checking' }
  | { status: 'idle' }
  | { status: 'downloading'; version?: string; percent?: number }
  | { status: 'installing'; version?: string }
  | { status: 'error'; message: string };

export type RiftDesktop = {
  isElectron: true;
  platform: string;
  getDesktopSources: (options?: {
    types?: Array<'screen' | 'window'>;
    thumbnailSize?: { width: number; height: number };
  }) => Promise<DesktopSource[]>;
  onDeepLink: (callback: (url: string) => void) => () => void;
  updater: {
    onEvent: (callback: (event: UpdaterEvent) => void) => () => void;
    quitAndInstall: () => Promise<void>;
    check: () => Promise<unknown>;
  };
};

declare global {
  interface Window {
    riftDesktop?: RiftDesktop;
  }
}
