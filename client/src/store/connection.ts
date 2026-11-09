import { create } from 'zustand';
import type { WsStatus } from '../services/realtime/ws';

export const useConnection = create<{ status: WsStatus; set: (s: WsStatus) => void }>((set) => ({
  status: 'closed',
  set: (status) => set({ status }),
}));
