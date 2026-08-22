'use client';

import { useEffect, useState } from 'react';
import { adminApi as api } from '@/lib/api';
import { Trash2, X, Check, Loader2, Users as UsersIcon } from 'lucide-react';

export default function AdminUsersPage() {
  const [users, setUsers] = useState<any[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  // 多选
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // 删除确认提示
  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  const load = (p = page) => {
    setLoading(true);
    api.get(`/api/v1/admin/users?page=${p}`).then(res => {
      if (res.success) { setUsers((res.data as any).items || (res.data as any)); setTotal((res.data as any).total || 0); }
      setLoading(false);
    });
  };
  useEffect(() => { setSelected(new Set()); load(page); }, [page]);

  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 3000); return () => clearTimeout(t); }, [toast]);

  const toggleActive = async (id: number) => {
    await api.put(`/api/v1/admin/users/${id}/toggle`);
    load();
  };

  // 删除确认弹窗（页面内，不用系统 confirm）
  const [confirmDel, setConfirmDel] = useState<{ mode: 'single' | 'batch'; user?: any; count: number } | null>(null);

  // 多选
  const toggleSel = (id: number) => setSelected(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = () => setSelected(users.length === selected.size ? new Set() : new Set(users.map(u => u.id)));
  const clearSel = () => setSelected(new Set());

  // 删除单个
  const handleDelete = async (u: any) => {
    setConfirmDel({ mode: 'single', user: u, count: 1 });
  };

  // 批量删除
  const handleBatchDelete = async () => {
    if (selected.size === 0) { setToast({ type: 'error', msg: '请先勾选要删除的用户' }); return; }
    setConfirmDel({ mode: 'batch', count: selected.size });
  };

  // 执行删除（确认后）
  const doDelete = async () => {
    if (!confirmDel) return;
    let res: any;
    if (confirmDel.mode === 'single') {
      res = await api.delete(`/api/v1/admin/users/${confirmDel.user.id}`);
    } else {
      res = await api.post('/api/v1/admin/users/batch/delete', { userIds: Array.from(selected) });
    }
    setConfirmDel(null);
    setToast(res.success
      ? { type: 'success', msg: res.message || '删除完成' }
      : { type: 'error', msg: res.error?.message || '删除失败' });
    setSelected(new Set());
    load();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">用户管理</h1>
        {selected.size > 0 && (
          <button onClick={handleBatchDelete} className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm rounded-lg flex items-center gap-1.5">
            <Trash2 size={14} /> 批量删除 ({selected.size})
          </button>
        )}
      </div>

      {toast && (
        <div className={`mb-4 px-4 py-3 rounded-lg text-sm flex items-center gap-2 ${toast.type === 'success' ? 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400 border border-green-200 dark:border-green-800' : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400 border border-red-200 dark:border-red-800'}`}>
          {toast.type === 'success' ? <Check size={16} /> : <X size={16} />}
          <span>{toast.msg}</span>
        </div>
      )}

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
              <th className="px-4 py-3 w-10">
                <input type="checkbox" checked={users.length > 0 && selected.size === users.length} onChange={toggleAll} className="accent-red-600" />
              </th>
              <th className="text-left px-4 py-3 text-sm">ID</th>
              <th className="text-left px-4 py-3 text-sm">用户名</th>
              <th className="text-left px-4 py-3 text-sm">邮箱</th>
              <th className="text-left px-4 py-3 text-sm">角色</th>
              <th className="text-left px-4 py-3 text-sm">状态</th>
              <th className="text-left px-4 py-3 text-sm">注册时间</th>
              <th className="text-left px-4 py-3 text-sm">操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id} className={`border-b border-gray-100 dark:border-gray-700/50 ${selected.has(u.id) ? 'bg-red-50/50 dark:bg-red-900/10' : ''}`}>
                <td className="px-4 py-3">
                  <input type="checkbox" checked={selected.has(u.id)} onChange={() => toggleSel(u.id)} className="accent-red-600" disabled={u.role === 'admin'} />
                </td>
                <td className="px-4 py-3 text-sm">{u.id}</td>
                <td className="px-4 py-3 text-sm font-medium">{u.username}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{u.email || '—'}</td>
                <td className="px-4 py-3 text-sm">{u.role === 'admin' ? '管理员' : '用户'}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 text-xs rounded-full ${u.isActive ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                    {u.isActive ? '启用' : '禁用'}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm text-gray-500">{new Date(u.createdAt).toLocaleDateString('zh-CN')}</td>
                <td className="px-4 py-3">
                  <div className="flex gap-1.5 flex-wrap">
                    <button onClick={() => toggleActive(u.id)}
                      className={`text-xs px-2 py-1 rounded ${u.isActive ? 'text-red-600 hover:bg-red-50' : 'text-green-600 hover:bg-green-50'}`}>
                      {u.isActive ? '禁用' : '启用'}
                    </button>
                    <a href={`/admin/logs?userId=${u.id}`} className="text-xs text-blue-600 hover:underline px-1 py-1">日志</a>
                    {u.role !== 'admin' && (
                      <button onClick={() => handleDelete(u)} title="删除用户" className="text-xs text-red-500 hover:text-red-700 px-1 py-1"><Trash2 size={13} /></button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {users.length === 0 && <tr><td colSpan={8} className="text-center py-12 text-gray-500">暂无用户</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="flex justify-between items-center mt-4 text-sm text-gray-500">
        <span className="flex items-center gap-2">
          共 {total} 条
          {selected.size > 0 && <button onClick={clearSel} className="text-red-500 hover:underline">清空选择({selected.size})</button>}
        </span>
        <div className="flex gap-2">
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} className="px-3 py-1 border rounded disabled:opacity-50">上一页</button>
          <button onClick={() => setPage(p => p + 1)} disabled={page * 20 >= total} className="px-3 py-1 border rounded disabled:opacity-50">下一页</button>
        </div>
      </div>

      {/* 删除确认弹窗（页面内） */}
      {confirmDel && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setConfirmDel(null)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl border-t-4 border-red-500" onClick={e => e.stopPropagation()}>
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-50 dark:bg-red-900/20 flex items-center justify-center text-red-500 flex-shrink-0">
                <Trash2 size={20} />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-lg text-red-600">确认删除</h3>
                <p className="text-sm text-gray-600 dark:text-gray-300 mt-2">
                  {confirmDel.mode === 'single'
                    ? <>确定删除用户 <span className="font-bold text-gray-900 dark:text-white">「{confirmDel.user.username}」</span> 吗？</>
                    : <>确定删除选中的 <span className="font-bold text-gray-900 dark:text-white">{confirmDel.count}</span> 位用户吗？</>}
                </p>
                <div className="mt-3 p-3 bg-amber-50 dark:bg-amber-900/20 rounded-lg text-xs text-amber-700 dark:text-amber-400">
                  ⚠️ 将一并删除其 <b>API Key</b> 和 <b>素材</b>，调用日志会保留但不再关联该用户。此操作不可撤销。
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setConfirmDel(null)} className="px-4 py-2 border rounded-lg text-sm">取消</button>
              <button onClick={doDelete} className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm flex items-center gap-1">
                <Trash2 size={14} /> 确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
