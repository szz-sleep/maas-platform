'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Users, Key, Box, FileText, BarChart3, Shield, Server, Receipt, Tag } from 'lucide-react';

const links = [
  { href: '/admin/overview', label: '大屏总览', icon: BarChart3 },
  { href: '/admin/users', label: '用户管理', icon: Users },
  { href: '/admin/keys', label: 'Key 管理', icon: Key },
  { href: '/admin/models', label: '模型管理', icon: Box },
  { href: '/admin/logs', label: '调用日志', icon: FileText },
  { href: '/admin/billing', label: '账单核对', icon: Receipt },
  { href: '/admin/prices', label: '价格管理', icon: Tag },
  { href: '/admin/settings', label: '系统配置', icon: Shield },
];

export default function AdminSidebar() {
  const pathname = usePathname();

  return (
    <nav className="w-56 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 h-full overflow-y-auto shrink-0">
      <div className="p-3 space-y-0.5">
        {links.map((link) => {
          const Icon = link.icon;
          const active = pathname === link.href || pathname.startsWith(link.href + '/');
          return (
            <Link
              key={link.href}
              href={link.href}
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
  );
}
