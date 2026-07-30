'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/store';
import {
  Users, Key, Box, FileText, BarChart3, Shield,
  LogOut, Menu, X
} from 'lucide-react';
import { useState } from 'react';

const adminNavLinks = [
  { href: '/admin/overview', label: '大屏总览', icon: BarChart3 },
  { href: '/admin/users', label: '用户管理', icon: Users },
  { href: '/admin/keys', label: 'Key 管理', icon: Key },
  { href: '/admin/models', label: '模型管理', icon: Box },
  { href: '/admin/logs', label: '调用日志', icon: FileText },
  { href: '/admin/settings', label: '系统配置', icon: Shield },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuthStore();
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleLogout = () => { logout(); router.push('/login'); };

  return (
    <div className="min-h-screen bg-gray-100 dark:bg-gray-950">
      {/* 顶部导航栏 */}
      <header className="h-14 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between px-4 sticky top-0 z-40 shadow-sm">
        <div className="flex items-center gap-4">
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="lg:hidden p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg"
          >
            {mobileOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
          <Link href="/admin/overview" className="flex items-center gap-2">
            <Shield size={20} className="text-blue-600" />
            <span className="font-bold text-gray-900 dark:text-white">MaaS 管理后台</span>
          </Link>
          <span className="hidden sm:inline text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 px-2 py-0.5 rounded-full font-medium">管理员</span>
        </div>

        <div className="flex items-center gap-3">
          <Link href="/dashboard" className="text-xs text-gray-500 hover:text-blue-600 transition-colors">
            切换到用户端 →
          </Link>
          <div className="flex items-center gap-2 text-sm">
            <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs font-medium">
              {user?.username?.charAt(0)?.toUpperCase() || 'A'}
            </div>
            <span className="hidden sm:inline text-gray-700 dark:text-gray-300">{user?.username}</span>
          </div>
          <button
            onClick={handleLogout}
            className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
            title="退出登录"
          >
            <LogOut size={18} />
          </button>
        </div>
      </header>

      <div className="flex">
        {/* 侧边导航（桌面端） */}
        <nav className="hidden lg:block w-56 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 min-h-[calc(100vh-3.5rem)] sticky top-14">
          <div className="p-3 space-y-0.5">
            {adminNavLinks.map((link) => {
              const Icon = link.icon;
              const active = pathname === link.href || pathname.startsWith(link.href + '/');
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setMobileOpen(false)}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                    active
                      ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 font-medium'
                      : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
                  }`}
                >
                  <Icon size={18} />
                  {link.label}
                </Link>
              );
            })}
          </div>
        </nav>

        {/* 移动端侧边栏 */}
        {mobileOpen && (
          <div className="lg:hidden fixed inset-0 z-50">
            <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
            <nav className="absolute left-0 top-0 w-56 h-full bg-white dark:bg-gray-900 shadow-xl pt-14">
              <div className="p-3 space-y-0.5">
                {adminNavLinks.map((link) => {
                  const Icon = link.icon;
                  const active = pathname === link.href || pathname.startsWith(link.href + '/');
                  return (
                    <Link
                      key={link.href}
                      href={link.href}
                      onClick={() => setMobileOpen(false)}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                        active
                          ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 font-medium'
                          : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
                      }`}
                    >
                      <Icon size={18} />
                      {link.label}
                    </Link>
                  );
                })}
              </div>
            </nav>
          </div>
        )}

        {/* 主内容区 */}

        <main className="flex-1 p-6 min-h-[calc(100vh-3.5rem)]">
          {children}
        </main>
      </div>
    </div>
  );
}