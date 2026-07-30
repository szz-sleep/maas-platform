'use client';

import { useEffect, useState } from 'react';
import { adminApi as api } from '@/lib/api';
import { ToggleLeft, ToggleRight, Trash2, Eye, Copy, Check, X } from 'lucide-react';

export default function AdminKeysPage() {
  const [keys, setKeys] = useState<any[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [allocating, setAllocating] = useState<{id: number; amount: string} | null>(null);
  const [viewKey, setViewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = () => {
    api.get(`/api/v1/admin/keys?page=${page}`).then(res => {
      if (res.success) { setKeys((res.data as any).items || (res.data as any)); setTotal((res.data as any).total || 0); }
    });
  };
  useEffect(() => { load(); }, [page]);

  const handleAllocate = async () => {
    if (!allocating || !allocating.amount) return;
    const res = await api.put(`/api/v1/admin/keys/${allocating.id}/quota`, { amount: parseFloat(allocating.amount) });
    if (res.success) { setAllocating(null); load(); }
    else alert(res.error?.message || '分配失败');
  };

  const handleToggle = async (k: any) => {
    const res = await api.put(`/api/v1/admin/keys/${k.id}/toggle`);
    if (res.success) load();
    else alert(res.error?.message || '操作失败');
  };

  const handleDelete = async (k: any) => {
    if (!confirm(`确定删除 Key "${k.keyName}"？此操作不可撤销。`)) return;
    const res = await api.delete(`/api/v1/admin/keys/${k.id}`);
    if (res.success) load();
  };

  const handleViewKey = async (k: any) => {
    const res = await api.get(`/api/v1/admin/keys/${k.id}/value`);
    if (res.success) setViewKey((res.data as any).keyValue);
  };

  const copyKey = () => {
    if (viewKey) { navigator.clipboard.writeText(viewKey); setCopied(true); setTimeout(() => setCopied(false), 2000); }
  };

  const statusBadge = (s: string) => {
    const map: Record<string, string> = {
      active: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
      pending_quota: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
      revoked: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    };
    const label: Record<string, string> = { active: '正常', pending_quota: '等待配额', revoked: '已禁用' };
    return <span className={`px-2 py-0.5 rounded-full text-xs ${map[s] || ''}`}>{label[s] || s}</span>;
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Key 管理</h1>
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
              <th className="text-left px-4 py-3 text-sm">名称</th>
              <th className="text-left px-4 py-3 text-sm">用户</th>
              <th className="text-left px-4 py-3 text-sm">状态</th>
              <th className="text-left px-4 py-3 text-sm">配额</th>
              <th className="text-left px-4 py-3 text-sm">最近使用</th>
              <th className="text-left px-4 py-3 text-sm w-48">操作</th>
            </tr>
          </thead>
          <tbody>
            {keys.map(k => (
              <tr key={k.id} className="border-b border-gray-100 dark:border-gray-700/50">
                <td className="px-4 py-3 text-sm font-medium">{k.keyName}</td>
                <td className="px-4 py-3 text-sm">{k.user?.username || '—'}</td>
                <td className="px-4 py-3">{statusBadge(k.status)}</td>
                <td className="px-4 py-3 text-sm">{k.quotaUsed}/{k.quotaTotal}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{k.lastUsed ? new Date(k.lastUsed).toLocaleDateString('zh-CN') : '—'}</td>
                <td className="px-4 py-3">
                  {allocating?.id === k.id ? (
                    <div className="flex gap-1">
                      <input value={allocating!.amount} onChange={e => setAllocating({id: k.id, amount: e.target.value})}
                        type="number" className="w-20 px-2 py-0.5 border rounded text-xs" placeholder={String(k.quotaTotal)} />
                      <button onClick={handleAllocate} className="text-xs bg-blue-600 text-white px-2 py-0.5 rounded">修改</button>
                      <button onClick={() => setAllocating(null)} className="text-xs text-gray-500 px-1">取消</button>
                    </div>
                  ) : (
                    <div className="flex gap-1 flex-wrap">
                      <button onClick={() => setAllocating({id: k.id, amount: String(k.quotaTotal)})} className="text-xs text-blue-600 hover:underline">额度</button>
                      <button onClick={() => handleToggle(k)} title={k.status === 'revoked' ? '启用' : '禁用'}
                        className={`text-xs px-1 rounded ${k.status === 'revoked' ? 'text-green-600 hover:bg-green-50' : 'text-orange-600 hover:bg-orange-50'}`}>
                        {k.status === 'revoked' ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
                      </button>
                      <button onClick={() => handleViewKey(k)} className="text-xs text-gray-500 hover:text-gray-700 px-0.5"><Eye size={14} /></button>
                      <button onClick={() => handleDelete(k)} className="text-xs text-red-500 hover:text-red-700 px-0.5"><Trash2 size={14} /></button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 翻页 */}
      <div className="flex justify-between mt-4">
        <span className="text-sm text-gray-500">共 {total} 条</span>
        <div className="flex gap-2">
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} className="px-3 py-1 border rounded text-sm disabled:opacity-30">上一页</button>
          <button onClick={() => setPage(p => p + 1)} disabled={page * 20 >= total} className="px-3 py-1 border rounded text-sm disabled:opacity-30">下一页</button>
        </div>
      </div>

      {/* Key 值弹窗 */}
      {viewKey && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => { setViewKey(null); setCopied(false); }}>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 max-w-lg w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-lg">Key 明文</h3>
              <button onClick={() => { setViewKey(null); setCopied(false); }} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
            </div>
            <div className="flex gap-2">
              <input value={viewKey} readOnly className="flex-1 px-3 py-2 border rounded bg-gray-50 dark:bg-gray-700 text-sm font-mono select-all" />
              <button onClick={copyKey} className="px-3 py-2 bg-blue-600 text-white rounded text-sm flex items-center gap-1">
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? '已复制' : '复制'}
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-3">⚠️ 请妥善保管，Key 值只显示这一次。</p>
          </div>
        </div>
      )}
    </div>
  );
}