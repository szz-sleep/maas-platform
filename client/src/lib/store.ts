'use client';

import { create } from 'zustand';
import api from '../lib/api';

interface User {
  id: number;
  username: string;
  email: string | null;
  phone: string | null;
  role: string;
  avatarUrl: string | null;
}

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (account: string, password: string) => Promise<{ success: boolean; role: string }>;
  register: (data: { username: string; password: string; turnstileToken?: string }) => Promise<boolean>;
  logout: () => void;
  fetchUser: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: true,
  isAuthenticated: false,

  login: async (account: string, password: string) => {
    const res = await api.login(account, password);
    if (res.success && res.data) {
      const d = res.data as any;
      api.setToken(d.accessToken);
      localStorage.setItem('refresh_token', d.refreshToken);
      const role = d.role || 'user';
      set({ user: { id: d.userId, username: d.username, role, email: null, phone: null, avatarUrl: null }, isAuthenticated: true });
      return { success: true, role };
    }
    return { success: false, role: 'user' };
  },

  register: async (data) => {
    const res = await api.register(data);
    if (res.success && res.data) {
      api.setToken((res.data as any).accessToken);
      localStorage.setItem('refresh_token', (res.data as any).refreshToken);
      set({ user: { id: (res.data as any).userId, username: (res.data as any).username, role: 'user', email: null, phone: null, avatarUrl: null }, isAuthenticated: true });
      return true;
    }
    return false;
  },

  logout: () => {
    api.setToken(null);
    localStorage.removeItem('refresh_token');
    set({ user: null, isAuthenticated: false });
  },

  fetchUser: async () => {
    set({ isLoading: true });
    const token = api.getToken();
    if (!token) {
      set({ isLoading: false, isAuthenticated: false });
      return;
    }
    const res = await api.getMe();
    if (res.success && res.data) {
      set({ user: res.data as User, isAuthenticated: true, isLoading: false });
    } else {
      set({ user: null, isAuthenticated: false, isLoading: false });
    }
  },
}));