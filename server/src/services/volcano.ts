/**
 * 火山引擎服务模块
 *
 * ⚠️ AK/SK 鉴权（素材管理）必须使用官方 SDK：
 *   pip install volcengine-python-sdk
 *   或 Java SDK: volcengine-java-sdk-ark
 *   调用方式：universal.DoCall(serviceName="ark", action="CreateAsset", version="2024-01-01")
 *
 * 素材入库完整流程：
 *   1. CreateAssetGroup → 创建素材组
 *   2. CreateAsset → 上传素材（图片/视频/音频）
 *   3. 轮询 GetAsset → 等待 Status=Active
 *   4. 用 asset://<asset_id> 在生成请求中引用
 *
 * ⚠️ Seedance 2.0 不支持直接上传含真实人脸的图片，需走已授权真人素材流程。
 *
 * 本模块提供：
 *   1. loadApiKey() — 从数据库读取并解密 API Key
 *   2. loadAksk() — 从数据库读取并解密 AK/SK 对
 */

import prisma from '../config/database';
import { decryptApiKey } from '../utils/apiKey';

/**
 * 从数据库读取并解密火山引擎 API Key
 * 用于：视频生成（Seedance）、图片生成（Seedream）、理解类接口（Responses）
 */
export async function loadApiKey(): Promise<string> {
  const setting = await prisma.systemSetting.findUnique({ where: { key: 'volcano_api_key' } });
  if (!setting?.value) {
    throw new Error('火山引擎 API Key 未配置，请在管理后台「系统配置」中填写');
  }
  return decryptApiKey(setting.value);
}

/**
 * 从数据库读取并解密 AK/SK 对
 * 用于：素材库管理（CreateAsset、GetAsset 等 AK/SK 接口）
 */
export async function loadAksk(): Promise<{ ak: string; sk: string }> {
  const [akSetting, skSetting] = await Promise.all([
    prisma.systemSetting.findUnique({ where: { key: 'volcano_ak' } }),
    prisma.systemSetting.findUnique({ where: { key: 'volcano_sk' } }),
  ]);
  if (!akSetting?.value || !skSetting?.value) {
    throw new Error('火山引擎 AK/SK 未配置，请在管理后台「系统配置」中填写');
  }
  return {
    ak: decryptApiKey(akSetting.value),
    sk: decryptApiKey(skSetting.value),
  };
}