import crypto from 'crypto';
import CryptoJS from 'crypto-js';
import { config } from '../config';

// 生成 API Key 原文
export function generateApiKeyValue(): string {
  return `mks-${crypto.randomBytes(24).toString('hex')}`;
}

// 加密 API Key 存入数据库
export function encryptApiKey(plain: string): string {
  return CryptoJS.AES.encrypt(plain, config.apiKey.encryptionKey).toString();
}

// 解密 API Key
export function decryptApiKey(encrypted: string): string {
  const bytes = CryptoJS.AES.decrypt(encrypted, config.apiKey.encryptionKey);
  return bytes.toString(CryptoJS.enc.Utf8);
}

// 计算哈希（用于日志脱敏）
export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}