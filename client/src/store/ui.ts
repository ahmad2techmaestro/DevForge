import { create } from 'zustand';

export type Theme = 'dark' | 'light';
export type ToastTone = 'success' | 'error' | 'info';
export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  detail?: string;
}

function initialTheme(): Theme {
  const attr = document.documentElement.dataset.theme;
  return attr === 'dark' ? 'dark' : 'light';
}

interface UiState {
  theme: Theme;
  paletteOpen: boolean;
  connectOpen: boolean;
  sidebarOpen: boolean;
  toasts: Toast[];
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  setPalette: (open: boolean) => void;
  setConnect: (open: boolean) => void;
  setSidebar: (open: boolean) => void;
  toast: (tone: ToastTone, title: string, detail?: string) => void;
  dismissToast: (id: number) => void;
}

let toastId = 0;

export const useUi = create<UiState>((set, get) => ({
  theme: initialTheme(),
  paletteOpen: false,
  connectOpen: false,
  sidebarOpen: false,
  toasts: [],
  setTheme: (theme) => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('df-theme-v2', theme);
    } catch {
      // ignore
    }
    set({ theme });
  },
  toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
  setPalette: (paletteOpen) => set({ paletteOpen }),
  setConnect: (connectOpen) => set({ connectOpen }),
  setSidebar: (sidebarOpen) => set({ sidebarOpen }),
  toast: (tone, title, detail) => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, tone, title, detail }] }));
    setTimeout(() => get().dismissToast(id), tone === 'error' ? 7000 : 4000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
  success: (title: string, detail?: string) => useUi.getState().toast('success', title, detail),
  error: (title: string, detail?: string) => useUi.getState().toast('error', title, detail),
  info: (title: string, detail?: string) => useUi.getState().toast('info', title, detail),
};
