'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAdminAuth } from '@/lib/store';
import AdminSidebar from './AdminSidebar';

const publicPaths = ['/login'];

export default function AdminClientLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, isLoading, fetchUser } = useAdminAuth();

  useEffect(() => { fetchUser(); }, []);

  const isPublic = publicPaths.includes(pathname);

  useEffect(() => {
    if (!isLoading && !user && !isPublic) {
      router.push('/login');
    }
  }, [user, isLoading, isPublic]);

  if (isLoading) {
    return <div className="flex items-center justify-center min-h-screen bg-gray-100"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" /></div>;
  }

  if (isPublic) return <>{children}</>;

  return (
    <div className="min-h-screen bg-gray-100 dark:bg-gray-950">
      <header className="h-14 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between px-6 sticky top-0 z-40 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold text-gray-900 dark:text-white">MaaS 管理后台</span>
          <span className="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 px-2 py-0.5 rounded-full">管理员</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-600 dark:text-gray-400">{user?.username}</span>
          <button onClick={() => { useAdminAuth.getState().logout(); router.push('/login'); }}
            className="text-sm text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 px-3 py-1 rounded-lg transition-colors">
            退出
          </button>
        </div>
      </header>
      <div className="flex h-[calc(100vh-3.5rem)]">
        <AdminSidebar />
        <main className="flex-1 p-6 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
