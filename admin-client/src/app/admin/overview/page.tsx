'use client';

import { useEffect, useRef, useState } from 'react';
import { adminApi as api } from '@/lib/api';
import { Users, Key, Box, Activity, TrendingUp, Zap, RefreshCw, Timer } from 'lucide-react';
import GaugeStat from '@/components/charts/GaugeStat';
import TrendChart from '@/components/charts/TrendChart';
import PieChart from '@/components/charts/PieChart';
import Ranking from '@/components/charts/Ranking';
import { useRouter } from 'next/navigation';

const typeLabels: Record<string, string> = { chat: '对话', video: '视频', image: '图片', '3d': '3D', audio: '音频', embedding: '向量' };

export default function AdminOverviewPage() {
  const [data, setData] = useState<any>(null);
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const timerRef = useRef<any>(null);
  const router = useRouter();

  const load = (d: number) => {
    api.get(`/api/v1/admin/overview?days=${d}`).then(res => {
      if (res.success) { setData(res.data); setLastRefresh(new Date()); }
      setLoading(false);
    });
  };

  // 切换天数时加载
  useEffect(() => { setLoading(true); load(days); }, [days]);

  // 页面卸载清理
  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  // 自动刷新：每60秒重载当前天数
  useEffect(() => {
    if (!autoRefresh) { if (timerRef.current) clearInterval(timerRef.current); return; }
    timerRef.current = setInterval(() => load(days), 60000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [autoRefresh, days]);

  const manualRefresh = () => { setLoading(true); load(days); };

  if (loading && !data) return <div className="flex justify-center items-center h-64"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-600" /></div>;

  // 模型类型分布（调用量占比）
  const typePie = ((data?.typeDistribution) || []).map((t: any) => ({ name: typeLabels[t.type] || t.type, value: t.calls }));
  // 模型调用占比
  const modelPie = ((data?.modelDistribution) || []).map((m: any) => ({ name: m.model, value: m.count }));
  // 用户TOP
  const topUsers = ((data?.topUsers) || []).map((u: any) => ({ name: u.username, value: u.calls, sub: `¥${u.cost}`, unit: '次' }));

  return (
    <div className="space-y-6">
      {/* 标题栏 + 控制 */}
      <div className="flex items-center flex-wrap gap-3 justify-between">
        <div>
          <h1 className="text-2xl font-bold bg-gradient-to-r from-indigo-600 to-sky-500 bg-clip-text text-transparent">平台大屏总览</h1>
          {lastRefresh && <p className="text-xs text-gray-400 mt-1">更新于 {lastRefresh.toLocaleTimeString('zh-CN')}</p>}
        </div>
        <div className="flex items-center gap-3">
          {/* 时间范围 */}
          <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
            {[7, 15, 30].map(d => (
              <button key={d} onClick={() => setDays(d)}
                className={`px-4 py-1.5 text-sm transition-colors ${days === d ? 'bg-indigo-600 text-white' : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50'}`}>
                {d}天
              </button>
            ))}
          </div>
          {/* 自动刷新开关 */}
          <button onClick={() => setAutoRefresh(a => !a)}
            className={`px-3 py-1.5 rounded-lg text-sm flex items-center gap-1.5 border transition-colors ${autoRefresh ? 'bg-green-50 text-green-600 border-green-200 dark:bg-green-900/20 dark:border-green-800' : 'bg-white dark:bg-gray-800 text-gray-500 border-gray-200 dark:border-gray-700'}`}>
            <Timer size={14} /> {autoRefresh ? '自动刷新中' : '已暂停'}
          </button>
          {/* 手动刷新 */}
          <button onClick={manualRefresh} disabled={loading}
            className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm rounded-lg flex items-center gap-1.5">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> 刷新
          </button>
        </div>
      </div>

      {/* 顶部 6 大指标卡 */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <GaugeStat label="用户总数" value={data.users?.total || 0} icon={Users} color="#6366f1" bg="bg-indigo-50 dark:bg-indigo-900/20" href="/admin/users" />
        <GaugeStat label="活跃 Key" value={data.keys?.active || 0} icon={Key} color="#10b981" bg="bg-green-50 dark:bg-green-900/20"
          sub={`共 ${data.keys?.total || 0} 个`} percent={data.keys?.total ? Math.round((data.keys.active / data.keys.total) * 100) : 0} href="/admin/keys" />
        <GaugeStat label="在线模型" value={data.models?.online || 0} icon={Box} color="#a855f7" bg="bg-purple-50 dark:bg-purple-900/20"
          sub={`共 ${data.models?.total || 0} 个`} percent={data.models?.total ? Math.round((data.models.online / data.models.total) * 100) : 0} href="/admin/models" />
        <GaugeStat label="今日调用" value={data.calls?.today || 0} icon={Activity} color="#f59e0b" bg="bg-orange-50 dark:bg-orange-900/20" href="/admin/logs" />
        <GaugeStat label="总调用量" value={data.calls?.total || 0} icon={Zap} color="#ef4444" bg="bg-red-50 dark:bg-red-900/20" href="/admin/logs" />
        <GaugeStat label="已消耗配额" value={Number(data.quota?.totalUsed || 0).toFixed(2)} suffix=" 元" icon={TrendingUp} color="#14b8a6" bg="bg-teal-50 dark:bg-teal-900/20" href="/admin/billing" />
      </div>

      {/* 趋势图 */}
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-5">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">近 {days} 天调用与费用趋势</h3>
        <TrendChart data={data?.callTrend || []} days={days} />
      </div>

      {/* 第二行：分布图表 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-4">
          <PieChart title="模型类型分布" data={typePie} />
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-4">
          <PieChart title="模型调用占比" data={modelPie} />
        </div>
        <Ranking title="用户调用 TOP10" items={topUsers} color="#6366f1" />
      </div>

      {/* 第三行：最近调用动态 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">最近调用动态</h3>
            <a href="/admin/logs" className="text-xs text-indigo-500 hover:text-indigo-700">查看全部 →</a>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-700/50">
            {(data?.recentLogs || []).length === 0 ? (
              <div className="text-center py-10 text-gray-400 text-sm">暂无调用记录</div>
            ) : data.recentLogs.map((l: any) => (
              <div key={l.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                <span className={`px-2 py-0.5 rounded-full text-xs ${l.source === 'local' ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'}`}>
                  {l.source === 'local' ? '本地' : '火山'}
                </span>
                <span className="text-gray-400 text-xs">{l.modelType}</span>
                <span className="flex-1 truncate font-mono text-xs">{l.model}</span>
                <span className="text-gray-500 text-xs">{l.user}</span>
                <span className="font-medium text-gray-700 dark:text-gray-200">¥{Number(l.cost).toFixed(3)}</span>
                <span className="text-gray-400 text-xs">{new Date(l.createdAt).toLocaleTimeString('zh-CN')}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 费用概览卡 */}
        <div className="grid grid-cols-2 gap-4 content-start">
          <div className="bg-gradient-to-br from-emerald-500 to-teal-600 rounded-2xl p-5 text-white shadow-sm">
            <p className="text-emerald-100 text-sm">今日消耗</p>
            <p className="text-3xl font-bold mt-1">¥{calcDayCost(data?.callTrend)}</p>
            <p className="text-emerald-100/80 text-xs mt-2">近{days}天累计 ¥{calcTotalCost(data?.callTrend)}</p>
          </div>
          <div className="bg-gradient-to-br from-indigo-500 to-blue-600 rounded-2xl p-5 text-white shadow-sm">
            <p className="text-indigo-100 text-sm">配额使用</p>
            <p className="text-3xl font-bold mt-1">¥{Number(data?.quota?.totalUsed || 0).toFixed(2)}</p>
            <p className="text-indigo-100/80 text-xs mt-2">用户累计消耗额度</p>
          </div>
          <div className="bg-gradient-to-br from-amber-500 to-orange-600 rounded-2xl p-5 text-white shadow-sm col-span-2">
            <p className="text-amber-100 text-sm">各类型费用</p>
            <div className="flex flex-wrap gap-2 mt-3">
              {((data?.typeDistribution) || []).map((t: any) => (
                <span key={t.type} className="px-2.5 py-1 rounded-lg bg-white/20 text-xs">
                  {typeLabels[t.type] || t.type}: ¥{Number(t.cost).toFixed(2)} ({t.calls}次)
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function calcDayCost(trend: any[]) {
  if (!trend?.length) return '0.00';
  const last = trend[trend.length - 1];
  return Number(last.cost || 0).toFixed(2);
}

function calcTotalCost(trend: any[]) {
  if (!trend?.length) return '0.00';
  return Number(trend.reduce((s, d) => s + (Number(d.cost) || 0), 0)).toFixed(2);
}
