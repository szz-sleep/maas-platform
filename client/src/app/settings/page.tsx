'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/store';
import api from '@/lib/api';

export default function SettingsPage() {
  const { user, fetchUser } = useAuthStore();
  const [tab, setTab] = useState('profile');
  const [username, setUsername] = useState(user?.username || '');
  const [message, setMessage] = useState('');

  const tabs = [
    { key: 'profile', label: '个人资料' },
    { key: 'password', label: '修改密码' },
    { key: 'bind', label: '绑定管理' },
    { key: 'danger', label: '账户安全' },
  ];

  const handleUpdateProfile = async () => {
    const res = await api.updateProfile({ username });
    setMessage(res.success ? '✅ 更新成功' : `❌ ${res.error?.message || '更新失败'}`);
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">设置</h1>
      <div className="flex gap-6">
        <nav className="w-48 space-y-1">
          {tabs.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`block w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                tab === t.key ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 font-medium' :
                'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}>{t.label}</button>
          ))}
        </nav>
        <div className="flex-1 bg-white dark:bg-gray-800 rounded-xl p-6 shadow-sm border border-gray-200 dark:border-gray-700 max-w-lg">
          {tab === 'profile' && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold">个人资料</h2>
              <div>
                <label className="text-sm font-medium mb-1 block">用户名</label>
                <input value={username} onChange={(e) => setUsername(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-blue-500 outline-none" />
              </div>
              <button onClick={handleUpdateProfile} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm">保存</button>
              {message && <p className={message.startsWith('✅') ? 'text-green-600 text-sm' : 'text-red-600 text-sm'}>{message}</p>}
            </div>
          )}
          {tab === 'password' && <PasswordForm />}
          {tab === 'bind' && <BindForm onBind={() => fetchUser()} />}
          {tab === 'danger' && <DangerZone />}
        </div>
      </div>
    </div>
  );
}

function PasswordForm() {
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [msg, setMsg] = useState('');

  const handleChange = async () => {
    if (!oldPw || !newPw) return setMsg('请填写完整');
    const res = await api.changePassword({ oldPassword: oldPw, newPassword: newPw });
    setMsg(res.success ? '✅ 密码修改成功' : `❌ ${res.error?.message}`);
  };

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">修改密码</h3>
      <input type="password" value={oldPw} onChange={(e) => setOldPw(e.target.value)}
        className="w-full px-3 py-2 border rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-blue-500 outline-none" placeholder="旧密码" />
      <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} minLength={8}
        className="w-full px-3 py-2 border rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-blue-500 outline-none" placeholder="新密码（至少8位）" />
      <button onClick={handleChange} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm">修改密码</button>
      {msg && <p className={msg.startsWith('✅') ? 'text-green-600 text-sm' : 'text-red-600 text-sm'}>{msg}</p>}
    </div>
  );
}

function BindForm({ onBind }: { onBind: () => void }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'input' | 'verify'>('input');
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState('');

  const handleSendCode = async () => {
    if (!email) return setMsg('请输入邮箱');
    setSending(true);
    const res = await api.sendCode('email', email);
    setSending(false);
    if (res.success) { setStep('verify'); setMsg('验证码已发送'); }
    else setMsg(`❌ ${res.error?.message || '发送失败'}`);
  };

  const handleVerify = async () => {
    if (!code) return;
    const res = await api.put('/api/v1/user/bind-email', { email, code });
    setMsg(res.success ? '✅ 邮箱绑定成功' : `❌ ${res.error?.message || '验证失败'}`);
    if (res.success) { setStep('input'); setEmail(''); setCode(''); onBind(); }
  };

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">绑定/更换邮箱</h3>
      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
        className="w-full px-3 py-2 border rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-blue-500 outline-none" placeholder="输入邮箱地址" />
      {step === 'input' ? (
        <button onClick={handleSendCode} disabled={sending}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white rounded-lg text-sm">
          {sending ? '发送中...' : '发送验证码'}
        </button>
      ) : (
        <div className="space-y-3">
          <input type="text" value={code} onChange={(e) => setCode(e.target.value)}
            className="w-full px-3 py-2 border rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-blue-500 outline-none" placeholder="输入验证码" />
          <button onClick={handleVerify}
            className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm">验证并绑定</button>
        </div>
      )}
      {msg && <p className={msg.startsWith('✅') ? 'text-green-600 text-sm' : 'text-red-600 text-sm'}>{msg}</p>}
    </div>
  );
}

function DangerZone() {
  const router = useRouter();
  const { logout } = useAuthStore();
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState('');

  const handleDelete = async () => {
    if (!password) return setMsg('请输入密码以确认');
    setLoading(true);
    // delete 请求带 body 用底层 request
    const res = await (api as any).request('DELETE', '/api/v1/user/account', { password });
    setLoading(false);
    if (res.success) {
      logout();
      router.push('/login');
    } else {
      setMsg(`❌ ${res.error?.message || '注销失败'}`);
    }
  };

  return (
    <div>
      {!confirming ? (
        <div>
          <p className="text-sm text-gray-500 mb-4">注销账户后所有数据将被永久删除。此操作不可恢复。</p>
          <button onClick={() => setConfirming(true)} className="px-4 py-2 bg-red-100 text-red-700 hover:bg-red-200 rounded-lg text-sm">
            注销账户
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-red-600 font-medium">请输入密码以确认注销：</p>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)}
            className="w-full px-3 py-2 border border-red-300 rounded-lg bg-white dark:bg-gray-700 focus:ring-2 focus:ring-red-500 outline-none"
            placeholder="输入密码" />
          <div className="flex gap-2">
            <button onClick={handleDelete} disabled={loading}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-300 text-white rounded-lg text-sm">
              {loading ? '注销中...' : '确认注销'}
            </button>
            <button onClick={() => setConfirming(false)}
              className="px-4 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 rounded-lg text-sm">取消</button>
          </div>
          {msg && <p className={msg.startsWith('✅') ? 'text-green-600 text-sm' : 'text-red-600 text-sm'}>{msg}</p>}
        </div>
      )}
    </div>
  );
}