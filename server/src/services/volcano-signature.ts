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
 * 生成火山引擎 X-Date 格式的时间戳：YYYYMMDDTHHMMSSZ
 */
function getTimestamp(): string {
  return new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/**
 * 生成日期字符串 YYYYMMDD
 */
function getDate(timestamp: string): string {
  return timestamp.slice(0, 8);
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
 * 火山引擎签名要求必须包含 x-content-sha256 头
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
  const hashedPayload = sha256Hex(body || '');

  // 补齐必要头（必须包含 content-type, host, x-content-sha256, x-date）
  const signedHeaders: Record<string, string> = {
    'Host': headers['Host'] || 'open.volcengineapi.com',
    'X-Date': timestamp,
    'X-Content-Sha256': hashedPayload,
    'Content-Type': headers['Content-Type'] || 'application/json',
  };
  // 合并外部传入的头（不覆盖上面4个核心头）
  for (const k of Object.keys(headers)) {
    const lower = k.toLowerCase();
    if (!['host', 'x-date', 'x-content-sha256', 'content-type'].includes(lower)) {
      signedHeaders[k] = headers[k];
    }
  }

  // Canonical Headers（按 key 小写排序）
  const canonicalHeaders = Object.keys(signedHeaders)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map(k => `${k.toLowerCase()}:${signedHeaders[k].trim().replace(/\s+/g, ' ')}`)
    .join('\n');

  const signedHeaderNames = Object.keys(signedHeaders)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map(k => k.toLowerCase())
    .join(';');

  // Canonical Query String：按键名排序，值需要 URL 编码
  const canonicalQuery = query
    ? query.split('&')
        .map(p => p.split('=', 2))
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v || '')}`)
        .join('&')
    : '';

  // Canonical Request
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

  // Signing Key（HMAC 链：SK → date → region → service → request）
  // 注意：sk 直接用原始字符串，无需 AWS4 前缀
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
    'X-Content-Sha256': hashedPayload,
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

  // 构建 fetch headers（排除 Host，fetch 会自动处理）
  const fetchHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(signedHeaders)) {
    if (k.toLowerCase() !== 'host') {
      fetchHeaders[k] = v;
    }
  }

  return fetch(url, {
    method,
    headers: fetchHeaders,
    body: bodyStr || undefined,
  });
}
