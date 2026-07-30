import { z } from 'zod';

// 发送验证码
export const sendCodeSchema = z.object({
  type: z.enum(['email', 'phone']),
  target: z.string().min(1, '邮箱或手机号不能为空'),
});

// 注册（用户名+密码+Turnstile）
export const registerSchema = z.object({
  username: z.string().min(2, '用户名至少2位').max(32, '用户名最多32位')
    .regex(/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/, '用户名只能包含中英文、数字和下划线'),
  password: z.string().min(8, '密码至少8位').max(128, '密码最多128位'),
  turnstileToken: z.string().optional(),
});

// 登录（用户名+密码）
export const loginSchema = z.object({
  account: z.string().min(1, '请输入用户名'),
  password: z.string().min(1, '请输入密码'),
});

// 申请 Key
export const createKeySchema = z.object({
  keyName: z.string().min(1, '请输入Key名称').max(100),
  description: z.string().optional(),
});

// 修改密码
export const changePasswordSchema = z.object({
  oldPassword: z.string().min(1, '请输入旧密码'),
  newPassword: z.string().min(8, '新密码至少8位').max(64),
});

// 绑定/换绑邮箱
export const bindEmailSchema = z.object({
  email: z.string().email('邮箱格式不正确'),
  code: z.string().length(6, '验证码为6位数字'),
});

// 绑定/换绑手机
export const bindPhoneSchema = z.object({
  phone: z.string().regex(/^1[3-9]\d{9}$/, '手机号格式不正确'),
  code: z.string().length(6, '验证码为6位数字'),
});

// 更新用户信息
export const updateProfileSchema = z.object({
  username: z.string().min(2).max(50).optional(),
  avatarUrl: z.string().url('头像地址格式不正确').optional(),
});

// 分配配额
export const allocateQuotaSchema = z.object({
  keyId: z.number().int().positive(),
  amount: z.number().positive('额度必须大于0'),
  reason: z.string().optional(),
  description: z.string().optional(),
});

// 加载/卸载模型
export const modelActionSchema = z.object({
  modelName: z.string().min(1, '请指定模型名称'),
});

// 模型调用
export const generateSchema = z.object({
  model: z.string().min(1, '请指定模型'),
  prompt: z.string().min(1, '请输入提示词'),
  duration: z.number().int().min(1).max(60).optional(),
  ratio: z.string().optional(),
  resolution: z.string().optional(),
  generate_audio: z.boolean().optional(),
  images: z.array(z.string()).optional(),
  videos: z.array(z.string()).optional(),
  audios: z.array(z.string()).optional(),
});