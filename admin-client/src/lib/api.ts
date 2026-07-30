// 管理端 API 客户端
const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
  message?: string;
}

class AdminApi {
  private token: string | null = null;

  setToken(token: string | null) {
    this.token = token;
    if (typeof window !== 'undefined') {
      if (token) localStorage.setItem('admin_token', token);
      else localStorage.removeItem('admin_token');
    }
  }

  getToken(): string | null {
    if (this.token) return this.token;
    if (typeof window !== 'undefined') {
      return localStorage.getItem('admin_token');
    }
    return null;
  }

  private async request<T>(method: string, path: string, body?: any): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = this.getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch {
      return { success: false, error: { code: 'NETWORK_ERROR', message: '网络请求失败' } };
    }

    let data: any;
    try { data = await res.json(); } catch {
      return { success: false, error: { code: 'PARSE_ERROR', message: '服务器返回异常' } };
    }

    if (!res.ok && !data.success) {
      if (data.error?.code === 'TOKEN_EXPIRED' || data.error?.code === 'UNAUTHORIZED') {
        this.setToken(null);
        localStorage.removeItem('admin_refresh_token');
        if (typeof window !== 'undefined') window.location.href = '/login';
      }
    }
    return data;
  }

  get<T>(path: string) { return this.request<T>('GET', path); }
  post<T>(path: string, body?: any) { return this.request<T>('POST', path, body); }
  put<T>(path: string, body?: any) { return this.request<T>('PUT', path, body); }
  delete<T>(path: string) { return this.request<T>('DELETE', path); }

  // Auth
  async login(account: string, password: string) { return this.post('/api/v1/auth/login', { account, password }); }
  async getMe() { return this.get('/api/v1/auth/me'); }
}

export const adminApi = new AdminApi();
export type { ApiResponse };
