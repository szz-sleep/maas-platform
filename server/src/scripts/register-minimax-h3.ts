/**
 * Register/update MiniMax-H3 runtime configuration in MaaS.
 *
 * Run from server/:
 *   npx tsx src/scripts/register-minimax-h3.ts
 */

import prisma from '../config/database';

async function main() {
  const endpointFL2VA =
    process.env.MINIMAX_H3_ENDPOINT_FL2VA ||
    process.env.MINIMAX_H3_ENDPOINT ||
    'http://127.0.0.1:8004';

  const endpointRef2VA =
    process.env.MINIMAX_H3_ENDPOINT_REF2VA ||
    null;

  const ref2vaEnabled =
    process.env.MINIMAX_H3_REF2VA_ENABLED === 'true';

  const maxDuration =
    Number(
      process.env.MINIMAX_H3_MAX_DURATION ||
      15,
    );

  const config = {
    videoProvider: 'minimax-h3',

    // Backward compatibility.
    endpoint: endpointFL2VA,

    endpointFL2VA,
    endpointRef2VA,
    ref2vaEnabled,

    deployment: {
      partition: 'FL2VA',
      gpuCount: 4,
      topology: 'TP2xUSP2',
    },

    capabilities: {
      t2va: true,
      fl2va: true,
      firstFrame: true,

      // Reserved route only, not enabled until Ref2VA is deployed/tested.
      ref2va: ref2vaEnabled && Boolean(endpointRef2VA),
      referenceImages: false,
      referenceVideos: false,
      referenceAudios: false,

      lastFrame: false,
      firstLastFrame: false,

      generatedAudio: true,

      fps: [24],
      durations: {
        min: 1,
        max: maxDuration,
      },
      ratios: [
        '16:9',
        '9:16',
        '1:1',
      ],
      resolutions: [
        '720p',
        '1080p',
      ],
    },

    defaults: {
      fps: 24,
      resolution: '720p',
      duration: 4,
      numInferenceSteps: 30,
      flowShift: 12,
      audioFlowShift: 3.0,
    },

    limits: {
      minDuration: 1,
      maxDuration,
      minInferenceSteps: 10,
      maxInferenceSteps: 40,
      mediaFetchTimeoutMs: 30000,
      maxReferenceBytes: 26214400,
    },
  };

  const model = await prisma.model.upsert({
    where: {
      name: 'minimax-h3',
    },

    update: {
      displayName: 'MiniMax H3',
      description:
        '本地 MiniMax-H3 / vLLM-Omni 视频+同步音频生成',
      usageHint:
        '支持 T2VA、FL2VA 首帧图生视频；Ref2VA 双端点接口已预留，部署验证后可启用',
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
      description:
        '本地 MiniMax-H3 / vLLM-Omni 视频+同步音频生成',
      usageHint:
        '支持 T2VA、FL2VA 首帧图生视频；Ref2VA 双端点接口已预留，部署验证后可启用',
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
