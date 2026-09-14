/**
 * 传输层：基于 @microsoft/fetch-event-source 的两个流式入口。
 *
 * 1. streamAgentChat           —— Agent 对话流（解析层见 agent-sse.ts）
 * 2. createUnifiedSseStreamer  —— 统一流式请求工厂，适用于所有生图类接口
 *    协议：event:start / event:comfyui_progress / event:model_result / event:complete
 */
import { fetchEventSource } from '@microsoft/fetch-event-source';
import { parseAgentSsePayload } from './agent-sse';
import type { AgentStreamEvent } from './types';

/** ---------- Agent 对话流 ---------- */

export interface StreamAgentChatOptions {
  url: string;
  body?: Record<string, unknown>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** 归一化后的业务事件（推荐 UI 只消费这个） */
  onEvent: (event: AgentStreamEvent) => void;
  /** 原始 data 行回调，用于调试日志 */
  onRaw?: (data: string) => void;
  /** 流结束（done 帧、连接关闭或异常都会触发，保证只触发一次） */
  onEnd?: () => void;
  onError?: (err: Error) => void;
}

export async function streamAgentChat(options: StreamAgentChatOptions): Promise<void> {
  const { url, body, signal, headers, onEvent, onRaw, onEnd, onError } = options;
  let ended = false;
  const finish = () => {
    if (!ended) {
      ended = true;
      onEnd?.();
    }
  };

  try {
    await fetchEventSource(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body ?? {}),
      signal,
      // 切后台不断流（原生 EventSource 在页面隐藏时会被浏览器断开）
      openWhenHidden: true,
      async onopen(response) {
        if (!response.ok) {
          const t = await response.text().catch(() => '');
          throw new Error(t || `HTTP ${response.status}`);
        }
      },
      onmessage(ev) {
        if (ev.data == null || ev.data === '') return;
        onRaw?.(ev.data);
        const events = parseAgentSsePayload(String(ev.data));
        for (const event of events) {
          onEvent(event);
          if (event.type === 'done') finish();
        }
      },
      onclose() {
        // 部分供应商没有显式结束帧，靠连接关闭收尾
        finish();
      },
      onerror(err) {
        throw err instanceof Error ? err : new Error(String(err));
      },
    });
    finish();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (error.name !== 'AbortError') onError?.(error);
  }
}

/** ---------- 统一生图流 ---------- */

export interface UnifiedStreamChunk {
  eventType: string;
  payload: Record<string, unknown>;
  raw: string;
  timestamp: number;
}

export interface UnifiedStreamImage {
  imageUrl: string;
  source?: string;
}

export interface UnifiedStreamOptions {
  body?: Record<string, unknown>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  onChunk?: (chunk: UnifiedStreamChunk) => void;
  onImages?: (images: UnifiedStreamImage[]) => void;
  onComplete?: () => void;
  onError?: (err: Error) => void;
}

export type UnifiedStreamFn = (options: UnifiedStreamOptions) => Promise<void>;

export interface UnifiedStreamerOptions {
  baseUrl?: string;
  headers?: () => Record<string, string>;
}

export function parseUnifiedSseData(raw: string): Record<string, unknown> | null {
  let trimmed = String(raw ?? '').trim();
  if (!trimmed || trimmed === '[DONE]') return null;
  if (trimmed.startsWith('data:')) trimmed = trimmed.slice(5).trimStart();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return { _raw: trimmed };
  }
}

/**
 * 完成判定必须且只能由 event:complete 触发。
 * model_result 帧里也可能带 isLast:true —— 它只表示"该模型的流向结束"，
 * 此时其它通道（如 comfyui 的进度帧）可能尚未回填完毕；
 * 若提前结束整个流，会直接丢掉后续到达的图片。这是踩过坑后固化的不变量。
 */
export function isUnifiedComplete(_payload: Record<string, unknown>, eventType: string): boolean {
  return eventType === 'complete';
}

/** 从流式帧中尽量兼容地提取图片结果（多供应商字段命名不一致） */
export function extractImagesFromUnifiedPayload(payload: Record<string, unknown>): UnifiedStreamImage[] {
  if (!payload || payload.success === false) return [];

  const data = payload.data as Record<string, unknown> | undefined;
  const resp = payload.resp as Record<string, unknown> | undefined;
  const resultList =
    (data?.result as unknown[]) ??
    (resp?.result as unknown[]) ??
    (payload.result as unknown[]) ??
    (Array.isArray(payload.data) ? (payload.data as unknown[]) : null);

  if (!Array.isArray(resultList)) return [];

  const images: UnifiedStreamImage[] = [];
  for (const item of resultList) {
    if (typeof item === 'string') {
      if (item) images.push({ imageUrl: item, source: payload.source as string | undefined });
      continue;
    }
    if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const imageUrl = o.imageUrl || o.url;
      if (typeof imageUrl === 'string' && imageUrl) {
        images.push({ imageUrl, source: payload.source as string | undefined });
      }
    }
  }
  return images;
}

/**
 * 通用 SSE 流式请求工厂 —— 一个工厂适配所有生图场景
 * （文生图 / 线稿渲染 / 多图融合 / 局部重绘 / 配色 …，只差一个 path）。
 * 携带 AbortController 取消能力；新一次提交前 abort 上一次即可实现幽灵请求治理。
 */
export function createUnifiedSseStreamer(
  path: string,
  options: UnifiedStreamerOptions = {},
): UnifiedStreamFn {
  const baseUrl = options.baseUrl ?? '';
  return function streamUnified({
    body,
    signal,
    headers,
    onChunk,
    onImages,
    onComplete,
    onError,
  }: UnifiedStreamOptions): Promise<void> {
    const url = `${baseUrl}${path}`;
    let completed = false;
    const finish = () => {
      if (!completed) {
        completed = true;
        onComplete?.();
      }
    };

    return fetchEventSource(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(options.headers?.() ?? {}), ...headers },
      body: JSON.stringify(body ?? {}),
      signal,
      openWhenHidden: true,
      async onopen(response) {
        if (!response.ok) {
          const t = await response.text().catch(() => '');
          throw new Error(t || `HTTP ${response.status}`);
        }
      },
      onmessage(ev) {
        if (ev.data == null || ev.data === '') return;
        const payload = parseUnifiedSseData(ev.data);
        if (!payload) return;

        const eventType = ev.event || 'message';
        onChunk?.({ eventType, payload, raw: ev.data, timestamp: Date.now() });

        if (payload.success === false) {
          onError?.(new Error(String(payload.errorMsg || payload.msg || '请求失败')));
          finish();
          return;
        }

        const images = extractImagesFromUnifiedPayload(payload);
        if (images.length) onImages?.(images);

        if (isUnifiedComplete(payload, eventType)) finish();
      },
      onclose() {
        finish();
      },
      onerror(err) {
        throw err instanceof Error ? err : new Error(String(err));
      },
    })
      .then(() => finish())
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (!completed && error.name !== 'AbortError') onError?.(error);
        throw error;
      });
  };
}
