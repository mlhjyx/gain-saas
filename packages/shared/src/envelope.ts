/**
 * 引擎响应信封(envelope)与 BFF 透传信封的类型。
 * 引擎响应形如 { data, ...page 字段 };BFF 失败时返回 { error: {...}, meta? }。
 */

export interface EngineErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/** BFF 给前端的错误响应:用户文案三层 + 技术详情(前端折叠)。 */
export interface ClientErrorBody {
  error: {
    code: string;
    userCopy: {
      title: string;
      why: string;
      next: string;
    };
  };
  meta?: {
    /** 引擎原始错误码与 trace,前端「技术详情」折叠区展示 */
    engineCode: string;
    engineMessage: string;
    traceId?: string;
  };
}
