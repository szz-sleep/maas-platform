import type { Metadata } from 'next';
import './globals.css';
import AdminClientLayout from '@/components/layout/AdminClientLayout';

export const metadata: Metadata = {
  title: 'MaaS 管理后台',
  description: 'MaaS 模型服务平台 - 管理后台',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="min-h-screen bg-gray-100 dark:bg-gray-950 antialiased">
        <AdminClientLayout>{children}</AdminClientLayout>
      </body>
    </html>
  );
}
