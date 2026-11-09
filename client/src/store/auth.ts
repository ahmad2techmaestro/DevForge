import { create } from 'zustand';
import type { User } from '../types/index';

const KEY = 'df-auth';

interface Persisted {
  token: string;
  user: User;
}

function load(): Persisted | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Persisted) : null;
  } catch {
    return null;
  }
}

interface AuthState {
  token: string | null;
  user: User | null;
  setSession: (token: string, user: User) => void;
  clear: () => void;
}

const initial = load();

export const useAuth = create<AuthState>((set) => ({
  token: initial?.token ?? null,
  user: initial?.user ?? null,
  setSession: (token, user) => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ token, user }));
    } catch {
      // storage unavailable: session lasts until reload
    }
    set({ token, user });
  },
  clear: () => {
    try {
      localStorage.removeItem(KEY);
    } catch {
      // ignore
    }
    set({ token: null, user: null });
  },
}));
