'use client';

import { useEffect, useState } from 'react';
import { adminApi as api } from '@/lib/api';

export default function AdminModelsPage() {
  const [models, setModels] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');

  const load = () => {
    setLoading(true);
    api.get('/api/v1/admin/models/status').then(res => {
      if (res.success) setModels((res.data as any[]) || []);
      setLoading(false);
    });
  };
  useEffect(() => { load(); }, []);

  const handleLoad = async (name: string) => {
    await api.post('/api/v1/admin/models/load', { modelName: name });
    load();
  };
  const handleUnload = async (name: string) => {
    await api.post('/api/v1/admin/models/unload', { modelName: name });
    load();
  };
  const handleSync = async () => {
    setSyncing(true);
    setSyncMsg('');
    try {
      const res = await api.post('/api/v1/admin/models/sync');
      if (res.success) {
        setSyncMsg(res.message || '同步完成');
        load();
      } else {
        setSyncMsg(res.error?.message || '同步失败');
      }
    } catch {
      setSyncMsg('同步失败');
    }
    setSyncing(false);
  };

  if (loading) return <div className="flex justify-center items-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" /></div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">模型管理</h1>
        <button
          onClick={handleSync}
          disabled={syncing}
          className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-300 text-white text-sm rounded-lg transition-colors flex items-center gap-2"
        >
          {syncing ? (
            <><div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> 同步中...</>
          ) : (
            '🔄 扫描自部署模型'
          )}
        </button>
      </div>
      {syncMsg && (
        <div className="mb-4 p-3 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 text-sm rounded-lg border border-green-200 dark:border-green-800">
          {syncMsg}
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {models.map(m => (
          <div key={m.id} className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm border border-gray-200 dark:border-gray-700">
            <div className="flex justify-between items-start mb-2">
              <div>
                <h3 className="font-semibold">{m.displayName}</h3>
                <p className="text-xs text-gray-500 font-mono">{m.name}</p>
              </div>
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                m.status === 'online' ? 'bg-green-100 text-green-700' : m.status === 'loading' ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-500'
              }`}>
                {m.status === 'online' ? '在线' : m.status === 'loading' ? '加载中...' : '离线'}
                {m.source === 'volcano' ? ' · 火山' : ''}
              </span>
            </div>
            <p className="text-xs text-gray-400 mb-1">{m.modelType} · {m.source}</p>
            <p className="text-sm text-gray-500 mb-3">{m.description}</p>
            <div className="flex gap-2">
              {m.source === 'local' && (
                <>
                  <button onClick={() => handleLoad(m.name)} disabled={m.status === 'online' || m.status === 'loading'}
                    className="px-3 py-1 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white text-xs rounded-lg transition-colors">热加载</button>
                  <button onClick={() => handleUnload(m.name)} disabled={m.status !== 'online'}
                    className="px-3 py-1 bg-red-100 hover:bg-red-200 disabled:bg-gray-100 text-red-700 disabled:text-gray-400 text-xs rounded-lg transition-colors">卸载</button>
                </>
              )}
              {m.source === 'volcano' && (
                <span className="px-2 py-1 bg-orange-100 text-orange-700 text-xs rounded-lg">火山引擎管理</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}