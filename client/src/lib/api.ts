// API 基础地址
const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
  message?: string;
}

class ApiClient {
  private token: string | null = null;

  setToken(token: string | null) {
    this.token = token;
    if (typeof window !== 'undefined') {
      if (token) localStorage.setItem('access_token', token);
      else localStorage.removeItem('access_token');
    }
  }

  getToken(): string | null {
    if (this.token) return this.token;
    if (typeof window !== 'undefined') {
      return localStorage.getItem('access_token');
    }
    return null;
  }

  private async request<T>(method: string, path: string, body?: any): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const token = this.getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      return { success: false, error: { code: 'NETWORK_ERROR', message: '网络请求失败，请检查服务是否运行' } };
    }

    let data: any;
    try {
      data = await res.json();
    } catch {
      return { success: false, error: { code: 'PARSE_ERROR', message: '服务器返回格式异常' } };
    }

    if (!res.ok && !data.success) {
      if (data.error?.code === 'TOKEN_EXPIRED' || data.error?.code === 'UNAUTHORIZED') {
        this.setToken(null);
        localStorage.removeItem('refresh_token');
        if (typeof window !== 'undefined') {
          window.location.href = '/login';
        }
      }
    }
    return data;
  }

  get<T>(path: string) { return this.request<T>('GET', path); }
  post<T>(path: string, body?: any) { return this.request<T>('POST', path, body); }
  put<T>(path: string, body?: any) { return this.request<T>('PUT', path, body); }
  delete<T>(path: string) { return this.request<T>('DELETE', path); }

  // Auth
  async sendCode(type: 'email' | 'phone', target: string) { return this.post('/api/v1/auth/send-code', { type, target }); }
  async register(data: { username: string; password: string; turnstileToken?: string }) { return this.post('/api/v1/auth/register', data); }
  async login(account: string, password: string) { return this.post('/api/v1/auth/login', { account, password }); }
  async getMe() { return this.get('/api/v1/auth/me'); }

  // Models
  async getModels() { return this.get('/api/v1/models'); }

  // Keys
  async getKeys() { return this.get('/api/v1/keys'); }
  async createKey(data: { keyName: string; description?: string }) { return this.post('/api/v1/keys', data); }
  async deleteKey(id: number) { return this.request<ApiResponse>('DELETE', `/api/v1/keys/${id}`); }
  async updateKeyStatus(id: number, status: string) { return this.put(`/api/v1/keys/${id}`, { status }); }

  // User
  async getProfile() { return this.get('/api/v1/user/profile'); }
  async updateProfile(data: any) { return this.put('/api/v1/user/profile', data); }
  async changePassword(data: { oldPassword: string; newPassword: string }) { return this.put('/api/v1/user/password', data); }

  // Admin
  async getOverview() { return this.get('/api/v1/admin/overview'); }
  async getAdminUsers(page = 1) { return this.get(`/api/v1/admin/users?page=${page}`); }
  async getAdminKeys(page = 1) { return this.get(`/api/v1/admin/keys?page=${page}`); }
  async allocateQuota(keyId: number, amount: number) { return this.put(`/api/v1/admin/keys/${keyId}/quota`, { keyId, amount }); }
  async getAdminLogs(params: any) { return this.get(`/api/v1/admin/logs?${new URLSearchParams(params)}`); }
  async loadModel(modelName: string) { return this.post('/api/v1/admin/models/load', { modelName }); }
  async unloadModel(modelName: string) { return this.post('/api/v1/admin/models/unload', { modelName }); }
  async getModelStatus() { return this.get('/api/v1/admin/models/status'); }
}

export const api = new ApiClient();
export default api;