/**
 * Register/update the current MiniMax-H3 deployment in MaaS.
 *
 * Run from server/:
 *   npx tsx src/scripts/register-minimax-h3.ts
 */

import prisma from '../config/database';

async function main() {
  const endpoint =
    process.env.MINIMAX_H3_ENDPOINT ||
    'http://127.0.0.1:8004';

  const maxDuration =
    Number(process.env.MINIMAX_H3_MAX_DURATION || 8);

  const config = {
    videoProvider: 'minimax-h3',
    endpoint,
    deployment: {
      partition: 'FL2VA',
      gpuCount: 4,
      topology: 'TP2xUSP2',
    },
    capabilities: {
      t2va: true,
      fl2va: true,
      firstFrame: true,
      lastFrame: false,
      firstLastFrame: false,
      ref2va: false,
      generatedAudio: true,
      fps: [24],
      ratios: ['16:9', '9:16', '1:1'],
    },
    defaults: {
      fps: 24,
      numInferenceSteps: 30,
      flowShift: 12,
      audioFlowShift: 3.0,
    },
    limits: {
      maxDuration,
      mediaFetchTimeoutMs: 30000,
      maxReferenceBytes: 26214400,
    },
  };

  const model = await prisma.model.upsert({
    where: { name: 'minimax-h3' },
    update: {
      displayName: 'MiniMax H3',
      description: '本地 MiniMax-H3 / vLLM-Omni 视频+同步音频生成',
      usageHint: '支持 T2VA、FL2VA 首帧/尾帧；当前 FL2VA-only 服务不开放 Ref2VA 参考音视频',
      source: 'local',
      modelType: 'video',
      unitCost: 0,
      unitCostPerSecond: 0,
      config,
      status: 'online',
      isHot: false,
      loadTime: new Date(),
    },
    create: {
      name: 'minimax-h3',
      displayName: 'MiniMax H3',
      description: '本地 MiniMax-H3 / vLLM-Omni 视频+同步音频生成',
      usageHint: '支持 T2VA、FL2VA 首帧/尾帧；当前 FL2VA-only 服务不开放 Ref2VA 参考音视频',
      source: 'local',
      modelType: 'video',
      unitCost: 0,
      unitCostPerSecond: 0,
      config,
      status: 'online',
      isHot: false,
      loadTime: new Date(),
    },
  });

  console.log('MiniMax-H3 registered:', {
    id: model.id,
    name: model.name,
    source: model.source,
    modelType: model.modelType,
    status: model.status,
    config: model.config,
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
