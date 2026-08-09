'use client';

import { useEffect, useState } from 'react';
import { adminApi as api } from '@/lib/api';

export default function AdminLogsPage() {
  const [logs, setLogs] = useState<any[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState('');

  const load = () => {
    const params: any = { page: String(page) };
    if (status) params.status = status;
    api.get('/api/v1/admin/logs?' + new URLSearchParams(params)).then(res => {
      if (res.success) { setLogs((res.data as any).items); setTotal((res.data as any).total); }
    });
  };
  useEffect(load, [page, status]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">调用日志</h1>
        <select value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}
          className="px-3 py-1.5 border rounded-lg text-sm bg-white dark:bg-gray-800">
          <option value="">全部状态</option>
          <option value="success">成功</option>
          <option value="failed">失败</option>
          <option value="timeout">超时</option>
        </select>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
              <th className="text-left px-4 py-3 text-sm">用户</th>
              <th className="text-left px-4 py-3 text-sm">模型</th>
              <th className="text-left px-4 py-3 text-sm">Tokens</th>
              <th className="text-left px-4 py-3 text-sm">耗时</th>
              <th className="text-left px-4 py-3 text-sm">消耗</th>
              <th className="text-left px-4 py-3 text-sm">状态</th>
              <th className="text-left px-4 py-3 text-sm">时间</th>
            </tr>
          </thead>
          <tbody>
            {logs.map(l => (
              <tr key={l.id} className="border-b border-gray-100 dark:border-gray-700/50 text-sm">
                <td className="px-4 py-3">{l.user?.username || '—'}</td>
                <td className="px-4 py-3 font-mono text-xs">{l.model?.name || '—'}</td>
                <td className="px-4 py-3">{l.tokensInput || 0}→{l.tokensOutput || 0}</td>
                <td className="px-4 py-3">{l.durationMs ? `${l.durationMs}ms` : '—'}</td>
                <td className="px-4 py-3">{l.cost || '—'}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded-full text-xs ${l.status === 'success' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                    {l.status === 'success' ? '成功' : l.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500">{new Date(l.createdAt).toLocaleString('zh-CN')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {logs.length === 0 && <div className="text-center py-12 text-gray-500">暂无日志</div>}
      </div>
      <div className="flex justify-between mt-4 text-sm text-gray-500">
        <span>共 {total} 条</span>
        <div className="flex gap-2">
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} className="px-3 py-1 border rounded disabled:opacity-50">上一页</button>
          <button onClick={() => setPage(p => p + 1)} disabled={page * 20 >= total} className="px-3 py-1 border rounded disabled:opacity-50">下一页</button>
        </div>
      </div>
    </div>
  );
}