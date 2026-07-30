'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/store';
import api from '@/lib/api';
import { Box, Key, Activity, TrendingUp } from 'lucide-react';

export default function DashboardPage() {
  const { user } = useAuthStore();
  const router = useRouter();
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const [keysRes, modelsRes, usageRes] = await Promise.all([
          api.getKeys(), api.getModels(), api.get('/api/v1/stats/my-usage'),
        ]);
        const keys = (keysRes.data as any[]) || [];
        const usage = usageRes.success ? (usageRes.data as any) : {};
        setStats({
          keys: keys.length,
          activeKeys: keys.filter((k: any) => k.status === 'active').length,
          models: ((modelsRes.data as any[]) || []).length,
          totalCalls: usage.totalCalls || 0,
          monthCalls: usage.monthCalls || 0,
          totalQuotaUsed: usage.totalQuotaUsed || 0,
        });
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const cards = [
    { label: '我的 Key', value: stats?.keys || 0, sub: `活跃 ${stats?.activeKeys || 0}`, icon: Key, color: 'text-blue-600', bg: 'bg-blue-50 dark:bg-blue-900/20', href: '/keys' },
    { label: '可用模型', value: stats?.models || 0, icon: Box, color: 'text-green-600', bg: 'bg-green-50 dark:bg-green-900/20', href: '/models' },
    { label: '本月调用', value: stats?.monthCalls ?? '—', icon: Activity, color: 'text-purple-600', bg: 'bg-purple-50 dark:bg-purple-900/20', href: '/keys' },
    { label: '累计消耗', value: stats?.totalQuotaUsed || 0, icon: TrendingUp, color: 'text-orange-600', bg: 'bg-orange-50 dark:bg-orange-900/20', href: '/keys' },
  ];

  if (loading) {
    return <div className="flex justify-center items-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" /></div>;
  }
  if (error) {
    return <div className="flex items-center justify-center h-64 text-gray-500">加载失败，请刷新重试</div>;
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">欢迎回来，{user?.username}</h1>
      <p className="text-gray-500 dark:text-gray-400 mb-6">这是你的 MaaS 平台仪表盘</p>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <div key={card.label}
              onClick={() => card.href && router.push(card.href)}
              className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm border border-gray-200 dark:border-gray-700 cursor-pointer hover:shadow-md hover:border-blue-300 dark:hover:border-blue-600 transition-all">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500 dark:text-gray-400">{card.label}</p>
                  <p className="text-2xl font-bold mt-1">{card.value}</p>
                  {(card as any).sub && <p className="text-xs text-gray-400 mt-0.5">{(card as any).sub}</p>}
                </div>
                <div className={`p-3 rounded-lg ${card.bg}`}>
                  <Icon size={24} className={card.color} />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl p-6 shadow-sm border border-gray-200 dark:border-gray-700">
        <h2 className="text-lg font-semibold mb-4">快速开始</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <a href="/models" className="block p-4 border border-gray-200 dark:border-gray-700 rounded-lg hover:border-blue-300 dark:hover:border-blue-600 transition-colors">
            <h3 className="font-medium mb-1">🔍 浏览模型</h3>
            <p className="text-sm text-gray-500">查看所有可用模型及其用法</p>
          </a>
          <a href="/keys" className="block p-4 border border-gray-200 dark:border-gray-700 rounded-lg hover:border-blue-300 dark:hover:border-blue-600 transition-colors">
            <h3 className="font-medium mb-1">🔑 管理 Key</h3>
            <p className="text-sm text-gray-500">申请和管理 API Key</p>
          </a>
        </div>
      </div>
    </div>
  );
}