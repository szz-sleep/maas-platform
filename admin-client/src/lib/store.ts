'use client';

import { create } from 'zustand';
import { adminApi } from './api';

interface AdminUser {
  id: number;
  username: string;
  role: string;
}

interface AdminAuthState {
  user: AdminUser | null;
  isLoading: boolean;
  login: (account: string, password: string) => Promise<{ success: boolean; isAdmin: boolean }>;
  logout: () => void;
  fetchUser: () => Promise<void>;
}

export const useAdminAuth = create<AdminAuthState>((set) => ({
  user: null,
  isLoading: true,

  login: async (account, password) => {
    const res = await adminApi.login(account, password);
    if (res.success && res.data) {
      const d = res.data as any;
      if (d.role !== 'admin') {
        return { success: false, isAdmin: false };
      }
      adminApi.setToken(d.accessToken);
      localStorage.setItem('admin_refresh_token', d.refreshToken);
      set({ user: { id: d.userId, username: d.username, role: d.role } });
      return { success: true, isAdmin: true };
    }
    return { success: false, isAdmin: false };
  },

  logout: () => {
    adminApi.setToken(null);
    localStorage.removeItem('admin_refresh_token');
    set({ user: null });
  },

  fetchUser: async () => {
    set({ isLoading: true });
    const token = adminApi.getToken();
    if (!token) { set({ isLoading: false }); return; }
    const res = await adminApi.getMe();
    if (res.success && res.data) {
      const u = res.data as any;
      if (u.role !== 'admin') {
        adminApi.setToken(null);
        set({ user: null, isLoading: false });
        return;
      }
      set({ user: u as AdminUser, isLoading: false });
    } else {
      set({ user: null, isLoading: false });
    }
  },
}));
