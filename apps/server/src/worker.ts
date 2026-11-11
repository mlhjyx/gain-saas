import './shared/load-env.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { loadConfig } from './config/configuration.js';
import { EventConsumerService } from './service/event-consumer.service.js';
import { EngineTokenSigner } from './service/engine-token.signer.js';

// 撤销投递循环只在 web 进程运行；worker 在建 Nest 上下文前标记自己的角色。
process.env.PROCESS_ROLE ??= 'worker';

/**
 * worker 进程:事件消费(SD4)+ 通知派发。无监听端口,独立 systemd 单元
 * gain-saas-worker.service(技术方案 §3)。
 */
async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger('Worker');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error'] });
  await app.get(EngineTokenSigner).init();

  const consumer = app.get(EventConsumerService);
  const enabled = config.EVENT_CONSUMER_ENABLED;
  logger.log(`事件消费 worker 已启动(enabled=${enabled},间隔 ${config.EVENT_CONSUMER_INTERVAL_MS}ms)`);

  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return; // 积压回放时一页可超过 tick 间隔,重入会重复拉页并回退游标
    running = true;
    try {
      const result = await consumer.consumeOnce();
      if (result.pulled > 0 || result.skipped) {
        logger.log(`consume: ${JSON.stringify(result)}`);
      }
    } catch (err) {
      logger.error(`consume 失败(下一轮重试): ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };

  await tick();
  if (enabled) {
    setInterval(() => void tick(), config.EVENT_CONSUMER_INTERVAL_MS);
  }
}

void bootstrap();
