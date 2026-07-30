/**
 * 火山引擎 API Signature V4 签名工具
 *
 * 用于需要 AK/SK 鉴权的接口（素材管理 CreateAsset、GetAsset 等）
 * 参考：火山引擎官方签名文档
 *
 * 签名流程：
 *   1. 构造 CanonicalRequest（规范化请求）
 *   2. 生成 StringToSign
 *   3. 计算 Signature（HMAC-SHA256）
 *   4. 组合 Authorization Header
 */

import { createHmac, createHash } from 'crypto';

/**
 * 生成 ISO8601 格式的时间戳（UTC）
 */
function getTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * 生成日期字符串 YYYYMMDD
 */
function getDate(timestamp: string): string {
  return timestamp.slice(0, 10).replace(/-/g, '');
}

/**
 * HMAC-SHA256
 */
function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/**
 * SHA256 哈希（hex 输出）
 */
function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * 签名请求头
 */
export function signRequest(
  accessKey: string,
  secretKey: string,
  method: string,
  path: string,
  query: string,
  body: string,
  headers: Record<string, string>,
  service: string = 'ark',
  region: string = 'cn-beijing'
): Record<string, string> {
  const timestamp = getTimestamp();
  const date = getDate(timestamp);

  // 补齐必要头
  const signedHeaders: Record<string, string> = {
    'Host': headers['Host'] || 'open.volcengineapi.com',
    'X-Date': timestamp,
    'Content-Type': headers['Content-Type'] || 'application/json',
    ...headers,
  };

  // Canonical Headers（按 key 小写排序，空格压缩值）
  const canonicalHeaders = Object.keys(signedHeaders)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map(k => `${k.toLowerCase()}:${signedHeaders[k].trim().replace(/\s+/g, ' ')}`)
    .join('\n');

  const signedHeaderNames = Object.keys(signedHeaders)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map(k => k.toLowerCase())
    .join(';');

  // Canonical Request
  const canonicalQuery = query
    ? query.split('&').sort().join('&')
    : '';
  const hashedPayload = sha256Hex(body || '');
  const canonicalRequest = [
    method.toUpperCase(),
    path,
    canonicalQuery,
    canonicalHeaders,
    '',
    signedHeaderNames,
    hashedPayload,
  ].join('\n');

  // String to Sign
  const credentialScope = `${date}/${region}/${service}/request`;
  const stringToSign = [
    'HMAC-SHA256',
    timestamp,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  // Signing Key
  const kDate = hmacSha256(Buffer.from(secretKey, 'utf-8'), date);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, 'request');

  // Signature
  const signature = hmacSha256(kSigning, stringToSign).toString('hex');

  // Authorization Header
  const authorization = [
    'HMAC-SHA256',
    `Credential=${accessKey}/${credentialScope}`,
    'SignedHeaders=' + signedHeaderNames,
    `Signature=${signature}`,
  ].join(', ');

  return {
    'Authorization': authorization,
    'X-Date': timestamp,
    'Content-Type': signedHeaders['Content-Type'] || 'application/json',
    'Host': signedHeaders['Host'],
  };
}

/**
 * 发送带 AK/SK 签名的 HTTP 请求
 */
export async function signedRequest(
  accessKey: string,
  secretKey: string,
  options: {
    method: string;
    host?: string;
    path: string;
    query?: string;
    body?: any;
    headers?: Record<string, string>;
    service?: string;
    region?: string;
  }
): Promise<Response> {
  const {
    method = 'POST',
    host = 'open.volcengineapi.com',
    path,
    query = '',
    body,
    headers = {},
    service = 'ark',
    region = 'cn-beijing',
  } = options;

  const bodyStr = body ? JSON.stringify(body) : '';
  const url = `https://${host}${path}${query ? '?' + query : ''}`;

  const signedHeaders = signRequest(
    accessKey, secretKey, method, path, query, bodyStr,
    { ...headers, Host: host },
    service, region
  );

  return fetch(url, {
    method,
    headers: signedHeaders,
    body: bodyStr || undefined,
  });
}
