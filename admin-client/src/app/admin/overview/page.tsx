'use client';

import { useEffect, useState } from 'react';
import { adminApi as api } from '@/lib/api';
import { Users, Key, Box, Activity, TrendingUp, Zap } from 'lucide-react';

export default function AdminOverviewPage() {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    api.get('/api/v1/admin/overview').then(res => { if (res.success) setData(res.data); });
  }, []);

  if (!data) return <div className="flex justify-center items-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" /></div>;

  const cards = [
    { label: '用户总数', value: data.users?.total || 0, icon: Users, color: 'text-blue-600', bg: 'bg-blue-50' },
    { label: '活跃 Key', value: `${data.keys?.active || 0}/${data.keys?.total || 0}`, icon: Key, color: 'text-green-600', bg: 'bg-green-50' },
    { label: '在线模型', value: `${data.models?.online || 0}/${data.models?.total || 0}`, icon: Box, color: 'text-purple-600', bg: 'bg-purple-50' },
    { label: '今日调用', value: data.calls?.today || 0, icon: Activity, color: 'text-orange-600', bg: 'bg-orange-50' },
    { label: '总调用量', value: data.calls?.total || 0, icon: Zap, color: 'text-red-600', bg: 'bg-red-50' },
    { label: '已消耗配额', value: data.quota?.totalUsed || 0, icon: TrendingUp, color: 'text-teal-600', bg: 'bg-teal-50' },
  ];

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">数据总览</h1>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
        {cards.map((c) => {
          const IconEl = c.icon;
          return (
            <div key={c.label} className="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm border border-gray-200 dark:border-gray-700">
              <div className={`${c.bg} w-10 h-10 rounded-lg flex items-center justify-center mb-3`}>
                <IconEl size={20} className={c.color} />
              </div>
              <p className="text-xs text-gray-500">{c.label}</p>
              <p className="text-xl font-bold mt-1">{c.value}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}