'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAdminAuth } from '@/lib/store';
import { Shield } from 'lucide-react';

export default function AdminLoginPage() {
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const { login } = useAdminAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const result = await login(account, password);
    setLoading(false);
    if (result.success) {
      router.push('/admin/overview');
    } else if (result.isAdmin === false) {
      setError('该账号不是管理员，请使用用户端登录');
    } else {
      setError('账号或密码错误');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-900 to-gray-800">
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl p-8 w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex p-3 bg-blue-100 dark:bg-blue-900/30 rounded-xl mb-3">
            <Shield size={32} className="text-blue-600" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">MaaS 管理后台</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1">仅限管理员登录</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">用户名</label>
            <input type="text" value={account} onChange={e => setAccount(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-blue-500 outline-none"
              placeholder="请输入管理员账号" required />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">密码</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-blue-500 outline-none"
              placeholder="请输入密码" required />
          </div>
          {error && <div className="bg-red-50 dark:bg-red-900/20 text-red-600 text-sm px-4 py-2 rounded-lg">{error}</div>}
          <button type="submit" disabled={loading}
            className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white rounded-lg font-medium transition-colors">
            {loading ? '登录中...' : '管理员登录'}
          </button>
        </form>
        <p className="text-center text-sm text-gray-500 mt-6">
          <a href="http://localhost:3000" className="text-blue-600 hover:underline">← 返回用户端</a>
        </p>
      </div>
    </div>
  );
}
