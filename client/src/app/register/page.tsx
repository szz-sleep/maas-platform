'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/lib/store';
import api from '@/lib/api';

export default function RegisterPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [siteKey, setSiteKey] = useState('');
  const turnstileRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const router = useRouter();
  const { register } = useAuthStore();

  // 从公开接口读取 Turnstile Site Key
  useEffect(() => {
    api.get('/api/v1/public/settings').then(res => {
      const data = res.data as { turnstileSiteKey?: string } | undefined;
      if (res.success && data?.turnstileSiteKey) {
        setSiteKey(data.turnstileSiteKey);
      }
    }).catch(() => {});
  }, []);

  // 加载 Turnstile widget
  useEffect(() => {
    if (!siteKey) return;
    const loadWidget = () => {
      if (window.turnstile && turnstileRef.current) {
        if (widgetIdRef.current) window.turnstile.reset(widgetIdRef.current);
        widgetIdRef.current = window.turnstile.render(turnstileRef.current, {
          sitekey: siteKey,
          callback: (token: string) => setTurnstileToken(token),
          'expired-callback': () => setTurnstileToken(''),
        });
      }
    };
    if (!window.turnstile) {
      // 避免重复加载 script
      if (document.querySelector('script[src*="turnstile"]')) {
        // script 已存在，等待加载
        const check = setInterval(() => {
          if (window.turnstile) { clearInterval(check); loadWidget(); }
        }, 200);
        return () => clearInterval(check);
      }
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.onload = loadWidget;
      document.head.appendChild(script);
    } else {
      loadWidget();
    }
    return () => {
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.reset(widgetIdRef.current);
      }
    };
  }, [siteKey]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (siteKey && !turnstileToken) {
      setError('请完成人机验证');
      return;
    }
    setLoading(true);
    const success = await register({ username, password, turnstileToken: turnstileToken || '' });
    setLoading(false);
    if (success) {
      router.push('/dashboard');
    } else {
      setError('注册失败，请检查用户名是否已被占用');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-gray-100 dark:from-gray-900 dark:to-gray-800">
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8 w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">创建账号</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-2">注册 MaaS 平台账号</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">用户名</label>
            <input type="text" value={username} onChange={(e) => setUsername(e.target.value)}
              className="w-full px-4 py-2 border rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-blue-500 outline-none transition"
              placeholder="2-32位，中英文/数字/下划线" required minLength={2} maxLength={32} />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">密码</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-2 border rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-blue-500 outline-none transition"
              placeholder="至少8位字符" required minLength={8} />
          </div>

          {/* Cloudflare Turnstile — 管理员配置后才显示 */}
          {siteKey && <div ref={turnstileRef} className="flex justify-center" />}

          {error && <div className="bg-red-50 dark:bg-red-900/20 text-red-600 text-sm px-4 py-2 rounded-lg">{error}</div>}

          <button type="submit" disabled={loading}
            className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white rounded-lg font-medium transition-colors">
            {loading ? '注册中...' : '注册'}
          </button>
        </form>

        <p className="text-center text-sm text-gray-500 dark:text-gray-400 mt-6">
          已有账号？<Link href="/login" className="text-blue-600 hover:text-blue-700 font-medium">登录</Link>
        </p>
      </div>
    </div>
  );
}