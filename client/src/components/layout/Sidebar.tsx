'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/store';
import {
  LayoutDashboard, Box, Key, Settings, Users, Server, FileText, BarChart3, LogOut, Shield
} from 'lucide-react';

const userLinks = [
  { href: '/dashboard', label: '仪表盘', icon: LayoutDashboard },
  { href: '/models', label: '模型中心', icon: Box },
  { href: '/keys', label: 'Key 管理', icon: Key },
  { href: '/settings', label: '设置', icon: Settings },
];

const adminLinks = [
  { href: '/admin/overview', label: '大屏总览', icon: BarChart3 },
  { href: '/admin/users', label: '用户管理', icon: Users },
  { href: '/admin/keys', label: 'Key 管理', icon: Key },
  { href: '/admin/models', label: '模型管理', icon: Box },
  { href: '/admin/logs', label: '调用日志', icon: FileText },
  { href: '/admin/settings', label: '系统配置', icon: Shield },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuthStore();
  const links = userLinks;

  return (
    <aside className="w-60 h-screen bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex flex-col">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700">
        <Link href="/dashboard" className="text-xl font-bold text-blue-600">MaaS Platform</Link>
        <p className="text-xs text-gray-500 mt-1">模型服务平台</p>
      </div>

      <nav className="flex-1 p-3 space-y-1">
        {links.map((link) => {
          const Icon = link.icon;
          const active = pathname === link.href || pathname.startsWith(link.href + '/');
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                active
                  ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 font-medium'
                  : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
            >
              <Icon size={18} />
              {link.label}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center text-blue-600 text-sm font-medium">
            {user?.username?.charAt(0)?.toUpperCase() || 'U'}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{user?.username}</p>
            <p className="text-xs text-gray-500">{user?.role === 'admin' ? '管理员' : '用户'}</p>
          </div>
        </div>
        <button
          onClick={() => { logout(); router.push('/login'); }}
          className="flex items-center gap-2 w-full px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
        >
          <LogOut size={16} />
          退出登录
        </button>
      </div>
    </aside>
  );
}