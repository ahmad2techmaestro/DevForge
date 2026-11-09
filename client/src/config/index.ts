declare global {
  interface Window {
    __DEVFORGE__?: { apiUrl?: string };
  }
}

const runtime = typeof window !== 'undefined' ? window.__DEVFORGE__?.apiUrl : undefined;

/** API base URL: runtime /config.js wins, then the build-time VITE_API_URL, then localhost. */
export const API_URL: string = (runtime || import.meta.env.VITE_API_URL || 'http://localhost:4000').replace(/\/+$/, '');

export const WS_URL: string = API_URL.replace(/^http/, 'ws') + '/ws';
