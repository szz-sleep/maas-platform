'use client';

import { useEffect, useState } from 'react';
import { adminApi as api } from '@/lib/api';
import { Save, Trash2, Eye, EyeOff, Shield, Key, Server, UserCog } from 'lucide-react';

interface Setting {
  key: string;
  value: string;
  type: string;
  description: string;
  masked?: boolean;
}

const SECRET_LABELS: Record<string, { label: string; icon: any; placeholder: string }> = {
  volcano_api_key: { label: '火山引擎 API Key', icon: Key, placeholder: '用于视频/图片生成（Seedance/Seedream）' },
  volcano_ak: { label: '火山引擎 Access Key', icon: Shield, placeholder: '用于素材管理签名' },
  volcano_sk: { label: '火山引擎 Secret Key', icon: Shield, placeholder: '用于素材管理签名' },
  turnstile_site_key: { label: 'Cloudflare Turnstile Site Key', icon: Shield, placeholder: '前端人机验证组件 Key（公开）' },
  turnstile_secret_key: { label: 'Cloudflare Turnstile Secret Key', icon: Shield, placeholder: '后端验证密钥（机密，加密存储）' },
};

const SYSTEM_LABELS: Record<string, { label: string; placeholder: string }> = {
  registration_enabled: { label: '开放用户注册', placeholder: 'true 或 false' },
  call_rate_limit: { label: '每分钟最大调用次数', placeholder: '默认 60' },
  token_retention_days: { label: '日志保留天数', placeholder: '默认 365' },
  volcano_project_name: { label: '项目名称', placeholder: '火山引擎项目名称' },
};

export default function AdminSettingsPage() {
  const [settings, setSettings] = useState<Setting[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState('');

  // 管理员账号修改
  const [adminUsername, setAdminUsername] = useState('');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [changingPwd, setChangingPwd] = useState(false);

  const load = async () => {
    // 加载配置
    const res = await api.get('/api/v1/admin/settings');
    if (res.success) {
      const data = (res.data as Setting[]) || [];
      setSettings(data);
      const initEdit: Record<string, string> = {};
      data.forEach(s => { if (!s.masked) initEdit[s.key] = s.value || ''; });
      setEditing(initEdit);
    }
    // 加载管理员信息
    const userRes = await api.get('/api/v1/user/profile');
    if (userRes.success && userRes.data) {
      setAdminUsername((userRes.data as any).username || '');
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const handleSave = async (key: string) => {
    setSaving(prev => ({ ...prev, [key]: true }));
    const res = await api.put('/api/v1/admin/settings', { key, value: editing[key] || '' });
    setSaving(prev => ({ ...prev, [key]: false }));
    if (res.success) {
      setMessage(`✅ ${key} 已保存`);
      setTimeout(() => setMessage(''), 3000);
      load();
    } else {
      setMessage(`❌ ${res.error?.message || '保存失败'}`);
    }
  };

  const handleDelete = async (key: string) => {
    if (!confirm(`确定删除配置 "${key}"？`)) return;
    await api.delete(`/api/v1/admin/settings/${key}`);
    setEditing(prev => ({ ...prev, [key]: '' }));
    load();
  };

  // 修改管理员密码
  const handleChangePassword = async () => {
    if (!oldPassword || !newPassword) {
      setMessage('❌ 请填写旧密码和新密码');
      setTimeout(() => setMessage(''), 3000);
      return;
    }
    if (newPassword.length < 6) {
      setMessage('❌ 新密码至少6位');
      setTimeout(() => setMessage(''), 3000);
      return;
    }
    setChangingPwd(true);
    const res = await api.put('/api/v1/user/password', { oldPassword, newPassword });
    setChangingPwd(false);
    if (res.success) {
      setMessage('✅ 密码修改成功');
      setOldPassword('');
      setNewPassword('');
    } else {
      setMessage(`❌ ${res.error?.message || '修改失败'}`);
    }
    setTimeout(() => setMessage(''), 3000);
  };

  // 修改管理员用户名
  const handleChangeUsername = async () => {
    if (!adminUsername) return;
    const res = await api.put('/api/v1/user/profile', { username: adminUsername });
    if (res.success) {
      setMessage('✅ 用户名已更新');
    } else {
      setMessage(`❌ ${res.error?.message || '更新失败'}`);
    }
    setTimeout(() => setMessage(''), 3000);
  };

  const toggleShow = (key: string) => {
    setShowSecret(prev => ({ ...prev, [key]: !prev[key] }));
  };

  if (loading) return <div className="flex justify-center items-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" /></div>;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">系统配置</h1>
      <p className="text-gray-500 dark:text-gray-400 mb-6">管理 API Key、AK/SK 等敏感配置。所有密钥加密存储。</p>

      {message && (
        <div className={`mb-4 px-4 py-2 rounded-lg text-sm ${message.startsWith('✅') ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {message}
        </div>
      )}

      {/* 敏感配置区域 */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Shield size={20} className="text-red-500" />
          敏感配置（加密存储）
        </h2>
        <div className="space-y-3">
          {Object.entries(SECRET_LABELS).map(([key, { label, icon: Icon, placeholder }]) => {
            const current = settings.find(s => s.key === key);
            const value = editing[key] ?? '';
            const isMasked = current?.masked;
            const hasValue = current?.value || value;

            return (
              <div key={key} className="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm border border-gray-200 dark:border-gray-700">
                <div className="flex items-start gap-3">
                  <div className="p-2 bg-red-50 dark:bg-red-900/20 rounded-lg">
                    <Icon size={18} className="text-red-500" />
                  </div>
                  <div className="flex-1">
                    <label className="text-sm font-medium">{label}</label>
                    <p className="text-xs text-gray-500 mb-2">{placeholder}</p>
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <input
                          type={showSecret[key] ? 'text' : 'password'}
                          value={value}
                          onChange={e => setEditing(prev => ({ ...prev, [key]: e.target.value }))}
                          placeholder={isMasked ? '******（已保存，输入新值覆盖）' : '请输入...'}
                          className="w-full px-3 py-2 pr-10 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                        />
                        <button
                          onClick={() => toggleShow(key)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                        >
                          {showSecret[key] ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      </div>
                      <button
                        onClick={() => handleSave(key)}
                        disabled={saving[key] || !value}
                        className="px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-1"
                      >
                        <Save size={14} />
                        {saving[key] ? '...' : '保存'}
                      </button>
                      {hasValue && (
                        <button
                          onClick={() => handleDelete(key)}
                          className="px-3 py-2 bg-red-50 hover:bg-red-100 text-red-600 rounded-lg text-sm"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 系统参数区域 */}
      <div>
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Server size={20} className="text-blue-500" />
          系统参数
        </h2>
        <div className="space-y-3">
          {Object.entries(SYSTEM_LABELS).map(([key, { label, placeholder }]) => (
            <div key={key} className="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm border border-gray-200 dark:border-gray-700">
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <label className="text-sm font-medium">{label}</label>
                  <p className="text-xs text-gray-500">{placeholder}</p>
                </div>
                <div className="flex gap-2">
                  <input
                    value={editing[key] || ''}
                    onChange={e => setEditing(prev => ({ ...prev, [key]: e.target.value }))}
                    className="w-40 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm text-center focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                  <button
                    onClick={() => handleSave(key)}
                    disabled={saving[key]}
                    className="px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white rounded-lg text-sm"
                  >
                    {saving[key] ? '...' : '保存'}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-6 p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg text-xs text-gray-500">
        <p>🔒 所有敏感配置（API Key、AK/SK）均使用 AES-256 加密后存入数据库。</p>
        <p>⚡ 修改后即时生效，无需重启服务。</p>
      </div>

      {/* 管理员账号 */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <UserCog size={20} className="text-purple-500" />
          管理员账号
        </h2>
        <div className="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm border border-gray-200 dark:border-gray-700 space-y-4">
          {/* 用户名 */}
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium w-20 shrink-0">用户名</label>
            <input
              value={adminUsername}
              onChange={e => setAdminUsername(e.target.value)}
              className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
            />
            <button onClick={handleChangeUsername}
              className="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm">
              保存
            </button>
          </div>
          {/* 密码 */}
          <div className="flex items-start gap-3">
            <label className="text-sm font-medium w-20 shrink-0 pt-2">密码</label>
            <div className="flex-1 flex items-center gap-2">
              <div className="flex-1 space-y-2">
                <input
                  type="password" value={oldPassword}
                  onChange={e => setOldPassword(e.target.value)}
                  placeholder="旧密码"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                />
                <input
                  type="password" value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  placeholder="新密码（至少6位）"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>
              <button onClick={handleChangePassword} disabled={changingPwd}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-300 text-white rounded-lg text-sm shrink-0 self-start">
                {changingPwd ? '...' : '修改密码'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 其他配置项（动态渲染）*/}
      {settings.filter(s => !SECRET_LABELS[s.key] && !SYSTEM_LABELS[s.key]).length > 0 && (
        <div className="mt-8">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Server size={20} className="text-gray-500" />
            其他配置
          </h2>
          <div className="space-y-3">
            {settings.filter(s => !SECRET_LABELS[s.key] && !SYSTEM_LABELS[s.key]).map(s => (
              <div key={s.key} className="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm border border-gray-200 dark:border-gray-700">
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <label className="text-sm font-medium font-mono">{s.key}</label>
                    {s.description && <p className="text-xs text-gray-500">{s.description}</p>}
                  </div>
                  <div className="flex gap-2">
                    <input
                      value={editing[s.key] || ''}
                      onChange={e => setEditing(prev => ({ ...prev, [s.key]: e.target.value }))}
                      className="w-40 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                    />
                    <button onClick={() => handleSave(s.key)} disabled={saving[s.key]}
                      className="px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white rounded-lg text-sm">
                      {saving[s.key] ? '...' : '保存'}
                    </button>
                    <button onClick={() => handleDelete(s.key)}
                      className="px-3 py-2 bg-red-50 hover:bg-red-100 text-red-600 rounded-lg text-sm">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}