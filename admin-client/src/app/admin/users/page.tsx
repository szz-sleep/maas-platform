'use client';

import { useEffect, useState } from 'react';
import { adminApi as api } from '@/lib/api';

export default function AdminUsersPage() {
  const [users, setUsers] = useState<any[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.get(`/api/v1/admin/users?page=${page}`).then(res => {
      if (res.success) { setUsers((res.data as any).items || (res.data as any)); setTotal((res.data as any).total || 0); }
      setLoading(false);
    });
  }, [page]);

  const toggleActive = async (id: number) => {
    await api.put(`/api/v1/admin/users/${id}/toggle`);
    api.get(`/api/v1/admin/users?page=${page}`).then(res => { if (res.success) setUsers((res.data as any).items || (res.data as any)); });
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">用户管理</h1>
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
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
              <tr key={u.id} className="border-b border-gray-100 dark:border-gray-700/50">
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
                  <button onClick={() => toggleActive(u.id)}
                    className={`text-xs px-2 py-1 rounded ${u.isActive ? 'text-red-600 hover:bg-red-50' : 'text-green-600 hover:bg-green-50'}`}>
                    {u.isActive ? '禁用' : '启用'}
                  </button>
                  <a href={`/admin/logs?userId=${u.id}`} className="text-xs text-blue-600 hover:underline ml-2">日志</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex justify-between items-center mt-4 text-sm text-gray-500">
        <span>共 {total} 条</span>
        <div className="flex gap-2">
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} className="px-3 py-1 border rounded disabled:opacity-50">上一页</button>
          <button onClick={() => setPage(p => p + 1)} disabled={page * 20 >= total} className="px-3 py-1 border rounded disabled:opacity-50">下一页</button>
        </div>
      </div>
    </div>
  );
}