'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import { Plus, Trash2, Copy, Check, Key, Eye, X } from 'lucide-react';

interface KeyItem {
  id: number;
  keyName: string;
  status: string;
  quotaTotal: string;
  quotaUsed: string;
  lastUsed: string | null;
  createdAt: string;
}

export default function KeysPage() {
  const [keys, setKeys] = useState<KeyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [viewKey, setViewKey] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<KeyItem | null>(null);
  const [copied2, setCopied2] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const loadKeys = async () => {
    const res = await api.getKeys();
    if (res.success) setKeys((res.data as KeyItem[]) || []);
    setLoading(false);
  };

  useEffect(() => { loadKeys(); }, []);

  const handleCreate = async () => {
    if (!keyName.trim()) return;
    const res = await api.createKey({ keyName: keyName.trim() });
    if (res.success) {
      setNewKey((res.data as any).keyValue);
      setKeyName('');
      loadKeys();
    }
  };

  const handleToggle = async (k: KeyItem) => {
    const newStatus = k.status === 'revoked' ? 'active' : 'revoked';
    await api.updateKeyStatus(k.id, newStatus);
    loadKeys();
  };

  const handleDelete = async (k: KeyItem) => {
    setDeleteTarget(k);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const res = await api.deleteKey(deleteTarget.id);
    console.log('删除结果:', res);
    setDeleting(false);
    setDeleteTarget(null);
    loadKeys();
  };

  const handleViewKey = async (id: number) => {
    const res = await api.get(`/api/v1/keys/${id}/value`);
    if (res.success) setViewKey((res.data as any).keyValue);
  };

  const handleCopy = (val: string, setter: (v: boolean) => void) => {
    navigator.clipboard.writeText(val);
    setter(true);
    setTimeout(() => setter(false), 2000);
  };

  const statusMap: Record<string, { label: string; color: string }> = {
    pending_quota: { label: '等待配额', color: 'bg-yellow-100 text-yellow-700' },
    active: { label: '正常', color: 'bg-green-100 text-green-700' },
    revoked: { label: '已禁用', color: 'bg-red-100 text-red-700' },
    expired: { label: '已过期', color: 'bg-gray-100 text-gray-500' },
  };

  if (loading) {
    return <div className="flex justify-center items-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" /></div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Key 管理</h1>
        <button onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors">
          <Plus size={16} />
          申请 Key
        </button>
      </div>

      {newKey && (
        <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl p-4 mb-6">
          <p className="text-green-700 dark:text-green-400 font-medium mb-2">✅ Key 创建成功！请立即复制保存：</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-white dark:bg-gray-900 px-3 py-2 rounded border text-sm font-mono break-all">{newKey}</code>
            <button onClick={() => handleCopy(newKey, setCopied)}
              className="p-2 bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors">
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
          <p className="text-xs text-green-600 dark:text-green-400 mt-2">⚠️ 此 Key 仅显示一次，请立即保存</p>
        </div>
      )}

      {showCreate && (
        <div className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm border border-gray-200 dark:border-gray-700 mb-6">
          <h3 className="font-semibold mb-3">申请新 Key</h3>
          <div className="flex gap-2">
            <input value={keyName} onChange={(e) => setKeyName(e.target.value)}
              className="flex-1 px-3 py-2 border rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-blue-500 outline-none"
              placeholder="Key 名称" />
            <button onClick={handleCreate}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm transition-colors">创建</button>
            <button onClick={() => setShowCreate(false)}
              className="px-4 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 rounded-lg text-sm transition-colors">取消</button>
          </div>
        </div>
      )}

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
              <th className="text-left px-4 py-3 text-sm font-medium">名称</th>
              <th className="text-left px-4 py-3 text-sm font-medium">状态</th>
              <th className="text-left px-4 py-3 text-sm font-medium">配额</th>
              <th className="text-left px-4 py-3 text-sm font-medium">创建时间</th>
              <th className="text-left px-4 py-3 text-sm font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => {
              const status = statusMap[key.status] || { label: key.status, color: 'bg-gray-100' };
              return (
                <tr key={key.id} className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                  <td className="px-4 py-3 text-sm font-medium">{key.keyName}</td>
                  <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded-full text-xs ${status.color}`}>{status.label}</span></td>
                  <td className="px-4 py-3 text-sm">{key.quotaUsed}/{key.quotaTotal}</td>
                  <td className="px-4 py-3 text-sm text-gray-500">{new Date(key.createdAt).toLocaleDateString('zh-CN')}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      {key.status === 'pending_quota' && (
                        <span className="text-xs text-gray-400">等待分配</span>
                      )}
                      {key.status !== 'pending_quota' && (
                        <>
                        <button onClick={() => handleViewKey(key.id)} title="查看Key值"
                          className="p-1 text-gray-400 hover:text-gray-600 rounded"><Eye size={14} /></button>
                        <button onClick={() => handleToggle(key)} title={key.status === 'revoked' ? '启用' : '禁用'}
                          className={`text-xs px-1.5 py-0.5 rounded ${key.status === 'revoked' ? 'text-green-600 hover:bg-green-50' : 'text-orange-600 hover:bg-orange-50'}`}>
                          {key.status === 'revoked' ? '启用' : '禁用'}
                        </button>
                        </>
                      )}
                      <button onClick={() => handleDelete(key)} title="删除"
                        className="text-red-500 hover:text-red-700 px-1"><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {keys.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            <Key size={40} className="mx-auto mb-3 text-gray-300" />
            <p>还没有 Key，点击上方按钮申请</p>
          </div>
        )}
      </div>

      {/* Key 删除确认弹窗 */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setDeleteTarget(null)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-red-100 dark:bg-red-900/20 rounded-full">
                <Trash2 size={20} className="text-red-500" />
              </div>
              <div>
                <h3 className="font-semibold text-lg">删除 Key</h3>
                <p className="text-sm text-gray-500">此操作不可撤销</p>
              </div>
            </div>
            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3 mb-4 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Key 名称</span>
                <span className="font-medium">{deleteTarget.keyName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">状态</span>
                <span className={(statusMap[deleteTarget.status] || {}).color ? `px-2 py-0.5 rounded-full text-xs ${statusMap[deleteTarget.status]?.color}` : ''}>{statusMap[deleteTarget.status]?.label || deleteTarget.status}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">配额消耗</span>
                <span className={Number(deleteTarget.quotaUsed) > 0 ? 'text-orange-600 font-medium' : 'text-gray-600'}>
                  {deleteTarget.quotaUsed} / {deleteTarget.quotaTotal}
                </span>
              </div>
            </div>
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 mb-4 text-sm">
              {Number(deleteTarget.quotaUsed) > 0 ? (
                <p className="text-red-600 dark:text-red-400">
                  ⚠️ 该 Key 已消耗 <strong>{deleteTarget.quotaUsed}</strong> 配额，
                  删除后对应调用记录仍保留但 Key 无法恢复。
                </p>
              ) : (
                <p className="text-red-600 dark:text-red-400">
                  ⚠️ 删除后无法恢复，是否确认？
                </p>
              )}
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setDeleteTarget(null)} disabled={deleting}
                className="px-4 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 rounded-lg text-sm">取消</button>
              <button onClick={confirmDelete} disabled={deleting}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-300 text-white rounded-lg text-sm">
                {deleting ? '删除中...' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Key 值弹窗 */}
      {viewKey && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => { setViewKey(null); setCopied2(false); }}>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 max-w-lg w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-lg">Key 值</h3>
              <button onClick={() => { setViewKey(null); setCopied2(false); }} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
            </div>
            <div className="flex gap-2">
              <input value={viewKey} readOnly className="flex-1 px-3 py-2 border rounded bg-gray-50 dark:bg-gray-700 text-sm font-mono select-all" />
              <button onClick={() => handleCopy(viewKey, setCopied2)} className="px-3 py-2 bg-blue-600 text-white rounded text-sm flex items-center gap-1">
                {copied2 ? <Check size={14} /> : <Copy size={14} />}
                {copied2 ? '已复制' : '复制'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}