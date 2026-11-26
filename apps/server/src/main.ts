import './shared/load-env.js';
import 'reflect-metadata';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import expressLib from 'express';
import cookieParser from 'cookie-parser';
import type { Request, Response, NextFunction } from 'express';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { loadConfig } from './config/configuration.js';
import { EngineTokenSigner } from './service/engine-token.signer.js';
import { EngineBudgetGrantSigner } from './service/engine-budget-grant.signer.js';
import { BffGuard, BffHandler, registerBffMiddleware } from './bff/bff.module.js';
import { registerSellerDocumentUploadMiddleware } from './bff/seller-document-upload.middleware.js';
import { SessionService } from './tenant/session.service.js';
import { GlobalHttpExceptionFilter } from './shared/http-exception.filter.js';
import { registerPublicCooperationCors } from './cooperation/public-cooperation-cors.js';
import { startR4TlsServers } from './r4/r4-tls.server.js';

/**
 * web 进程:Nest HTTP(三域)+ SPA 静态托管(vben build 产物,仿中台生产模式)。
 * worker 进程见 worker.ts。
 */
async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['log', 'warn', 'error'] });
  app.enableShutdownHooks();
  app.useGlobalFilters(new GlobalHttpExceptionFilter());

  // 信任本机反代/socket 转发;cookie 在 M1 全量落地
  app.set('trust proxy', 'loopback');
  app.use(cookieParser());

  // BFF(SD7):先于 SPA 静态注册;/api/auth、/api/members 由 Nest 控制器处理。
  // BFF 动态路由注册在 Nest 的 parser middleware 之前,POST/PATCH 的 JSON body 必须在这里先解析,
  // 否则 req.body 为空,引擎会把缺字段报成 "website must be a URL address"。
  const expressInstance = app.getHttpAdapter().getInstance();
  // Ring-1 P0 安全响应头（无新增依赖，防 MIME 嗅探 / 点击劫持 / Referrer 泄漏）。
  expressInstance.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    if (config.NODE_ENV === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });
  // 官网合作意向公开端点的 CORS / 体积 / 安全响应头（只作用于该路径前缀）。
  // 注册在 JSON parser 之前：16KB 上限在解析前就按 content-length 拒绝。
  registerPublicCooperationCors(expressInstance, config.PUBLIC_COOPERATION_ALLOWED_ORIGINS);
  // 资料库上传:注册在 JSON parser 之前并校验真实 saas_session 后才缓冲 51MB 二进制体，
  // 防止未登录大包 DoS 或 application/json 上传绕过上传鉴权进入 expressLib.json()（raw 已消费流后 json() 会跳过）。
  registerSellerDocumentUploadMiddleware(expressInstance, app.get(SessionService));
  expressInstance.use(expressLib.json({ limit: '8mb' }));
  expressInstance.use(expressLib.urlencoded({ extended: true, limit: '8mb' }));
  const bffHandler = app.get(BffHandler);
  const bffGuard = app.get(BffGuard);
  registerBffMiddleware(expressInstance, bffHandler, bffGuard);

  // 密钥形态在启动即校验:PEM 非法直接拒绝启动(技术方案 §3)
  const signer = app.get(EngineTokenSigner);
  await signer.init();
  const budgetSigner = app.get(EngineBudgetGrantSigner);
  await budgetSigner.init();

  const distDir = join(process.cwd(), config.SPA_DIST_DIR);
  if (existsSync(distDir)) {
    const express = app.getHttpAdapter().getInstance();
    express.use('/assets', expressLib.static(join(distDir, 'assets')));
    // ACME HTTP-01 challenge（Let's Encrypt 经隧道回源）；dotfiles 默认被 static 忽略。
    express.use('/.well-known/acme-challenge', expressLib.static(join(distDir, '.well-known/acme-challenge'), { dotfiles: 'allow', fallthrough: false }));
    express.use(expressLib.static(distDir, { index: 'index.html', extensions: ['html'] }));
    // SPA fallback:非 /api /health /ops /.well-known /v1 的 GET 回 index.html
    express.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method === 'GET' && !/^\/(api|health|\.well-known|v1)(\/|$)/.test(req.path)) {
        return res.sendFile(join(distDir, 'index.html'));
      }
      next();
    });
  } else {
    new Logger('Bootstrap').warn(`SPA 产物不存在(${distDir}),仅提供 API —— 开发期属预期`);
  }

  const httpServer = await app.listen(config.PORT, config.HOST);
  // 放宽单次 HTTP 请求总超时至 15 分钟，避免弱网/远程隧道上传 40-50MB 企业 PDF 画册撞上 Node 默认 5 分钟 requestTimeout。
  httpServer.requestTimeout = 15 * 60 * 1000;

  // R4 内部 mTLS 监听：与主监听并存，未配置或 PLATFORM_AUTHORITY_MODE=internal_db 时不启动（P5b/Wave 3）。
  const r4Tls = await startR4TlsServers(app, config);
  for (const handle of r4Tls) console.log(`[r4] TLS listening on ${config.R4_TLS_HOST}:${handle.port}`);
  new Logger('Bootstrap').log(
    `gain-saas web 已启动 http://${config.HOST}:${config.PORT}(JWKS: /.well-known/jwks.json, budgetMode=${config.LEGACY_EXECUTION_BUDGET_MODE}, authorityMode=${config.PLATFORM_AUTHORITY_MODE})`,
  );
}

void bootstrap();
