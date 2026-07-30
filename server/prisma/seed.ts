import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import bcrypt from 'bcrypt';
import CryptoJS from 'crypto-js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://suzhenzhong@localhost:5432/maas_platform' });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('🌱 开始初始化种子数据...\n');

  // 创建管理员
  const adminHash = await bcrypt.hash('admin123', 12);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@maas.com' },
    update: {},
    create: {
      username: 'admin',
      email: 'admin@maas.com',
      passwordHash: adminHash,
      role: 'admin',
    },
  });
  console.log('✅ 管理员账号: admin@maas.com / admin123');

  // 创建测试用户
  const userHash = await bcrypt.hash('test1234', 12);
  const testUser = await prisma.user.upsert({
    where: { email: 'user@maas.com' },
    update: {},
    create: {
      username: 'testuser',
      email: 'user@maas.com',
      passwordHash: userHash,
      role: 'user',
    },
  });
  console.log('✅ 测试用户: user@maas.com / test1234');

  const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'maas-aes-key-32bytes-change-me!!';
  // 创建测试 Key
  const plainKey = 'mks-test-key-for-development-00000000';
  const encryptedKey = CryptoJS.AES.encrypt(plainKey, ENCRYPTION_KEY).toString();
  const { createHash } = await import('crypto');
  const keyHash = createHash('sha256').update(plainKey).digest('hex');
  await prisma.apiKey.upsert({
    where: { keyHash },
    update: {},
    create: {
      userId: testUser.id,
      keyName: '测试Key',
      keyValue: encryptedKey,
      keyHash,
      status: 'active',
      quotaTotal: 1000,
      quotaUsed: 0,
    },
  });
  console.log(`✅ 测试 Key: ${plainKey}`);

  // 创建模型
  const models = [
    // 视频生成
    { name: 'seedance2.0', displayName: 'Seedance 2.0 视频生成', source: 'volcano', modelType: 'video', volcanoModelId: 'doubao-seedance-2-0-260128', description: '最高品质视频生成（文/图/音→视频）', usageHint: '高质量短视频、创意视频制作', unitCost: 0.5 },
    { name: 'seedance2.0-fast', displayName: 'Seedance 2.0 Fast', source: 'volcano', modelType: 'video', volcanoModelId: 'doubao-seedance-2-0-fast-260128', description: '快速版，兼顾速度与质量', usageHint: '实时预览、快速迭代', unitCost: 0.3 },
    { name: 'seedance2.0-mini', displayName: 'Seedance 2.0 Mini', source: 'volcano', modelType: 'video', volcanoModelId: 'doubao-seedance-2-0-mini-260615', description: '迷你版，最低成本方案', usageHint: '批量生成、低成本场景', unitCost: 0.15 },
    // 图片生成
    { name: 'seedream5.0-pro', displayName: 'Seedream 5.0 Pro', source: 'volcano', modelType: 'image', volcanoModelId: 'doubao-seedream-5-0-pro-260628', description: '图片生成（交互编辑、多图融合、多语种文字）', usageHint: 'AI绘图、海报设计、图片编辑', unitCost: 0.2 },
    // 视觉理解
    { name: 'seed2.1-vision', displayName: 'Seed 2.1 视觉理解', source: 'volcano', modelType: 'chat', volcanoModelId: 'doubao-seed-2-1-pro-260628', description: '视频/图片/文档理解', usageHint: '视频分析、图片描述、文档问答', unitCost: 0.1 },
    // 音频理解
    { name: 'seed2.0-audio', displayName: 'Seed 2.0 音频理解', source: 'volcano', modelType: 'audio', volcanoModelId: 'doubao-seed-2-0-lite-260428', description: '音频理解与转写', usageHint: '语音转文字、音频摘要、音色分析', unitCost: 0.05 },
    // 自部署
    { name: 'llama3.2-8b', displayName: 'Llama 3.2 8B', source: 'local', modelType: 'chat', description: '自部署 Meta Llama 3.2 8B 大语言模型', usageHint: '文本生成、对话、翻译', unitCost: 0.01, config: { endpoint: 'http://localhost:11434/v1' } },
    { name: 'stable-diffusion-xl', displayName: 'Stable Diffusion XL', source: 'local', modelType: 'image', description: '自部署 Stable Diffusion XL 图像生成模型', usageHint: 'AI绘画、图片生成', unitCost: 0.05, config: { endpoint: 'http://localhost:7860' } },
  ];

  for (const model of models) {
    await prisma.model.upsert({
      where: { name: model.name },
      update: {},
      create: model as any,
    });
  }
  console.log('✅ 已创建 8 个模型\n');

  console.log('🎉 种子数据初始化完成！');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());