/**
 * 生图 Runner：组装 传输工厂 + 槽位调度器 + AbortController。
 *
 * 一次 run 的生命周期：
 *   提交 → (新任务自动 abort 旧流) → start 预占位 → 乱序回填 → complete 收尾 sweep
 * 取消语义：
 *   - 用户主动取消：有结果保留 / 无结果标记「已取消」
 *   - 新任务取代：旧流 abort，未完成槽位标记「被新任务取代」（幽灵请求治理）
 *   - 传输错误：全部通道标记失败并回调 onError
 */
import { ImageSlotScheduler, type ImageResultItem } from './scheduler';
import type { UnifiedStreamChunk, UnifiedStreamFn } from './streamer';
import type { ImageSlot } from './types';

export interface ImageGenerationRunnerOptions {
  stream: UnifiedStreamFn;
  categories?: string[];
  onChange: (slots: ImageSlot[]) => void;
  /** 每个原始帧回调（调试日志用） */
  onFrame?: (chunk: UnifiedStreamChunk) => void;
  onComplete?: (slots: ImageSlot[]) => void;
  onCancel?: (slots: ImageSlot[]) => void;
  onError?: (err: Error, slots: ImageSlot[]) => void;
}

export interface ImageGenerationRunner {
  run: (options: { body: Record<string, unknown> }) => Promise<void>;
  cancel: (reason?: string) => void;
  isRunning: () => boolean;
}

interface ActiveRun {
  controller: AbortController;
  scheduler: ImageSlotScheduler;
  cancelledByUser: boolean;
  cancelReason: string;
  superseded: boolean;
}

export function createImageGenerationRunner(
  options: ImageGenerationRunnerOptions,
): ImageGenerationRunner {
  let active: ActiveRun | null = null;
  let generation = 0;

  function cancel(reason = '用户取消'): void {
    if (!active || active.cancelledByUser) return;
    active.cancelledByUser = true;
    active.cancelReason = reason;
    active.controller.abort();
  }

  async function run({ body }: { body: Record<string, unknown> }): Promise<void> {
    generation += 1;
    const gen = generation;

    if (active) {
      active.superseded = true;
      active.controller.abort();
    }

    const controller = new AbortController();
    const scheduler = new ImageSlotScheduler({
      categories: options.categories,
      onChange: (slots) => {
        // 迟到的旧流状态不再进入 UI
        if (gen === generation) options.onChange(slots);
      },
    });
    active = { controller, scheduler, cancelledByUser: false, cancelReason: '', superseded: false };

    try {
      await options.stream({
        body,
        signal: controller.signal,
        onChunk: (chunk) => {
          if (gen !== generation) return;
          options.onFrame?.(chunk);
          handleFrame(scheduler, chunk);
        },
        onComplete: () => scheduler.sweep(),
      });
      if (gen === generation) options.onComplete?.(scheduler.getSlots());
    } catch (err) {
      if (gen !== generation) return;
      const slots = scheduler.getSlots();
      if (active.cancelledByUser) {
        scheduler.cancel(`已取消（${active.cancelReason || '用户主动停止'}）`);
        options.onCancel?.(scheduler.getSlots());
      } else if (active.superseded) {
        scheduler.cancel('已取消（被新任务取代）');
      } else {
        const error = err instanceof Error ? err : new Error(String(err));
        scheduler.markAllFailed(error.message);
        options.onError?.(error, slots);
      }
    } finally {
      if (active && active.controller === controller) {
        active = null;
      }
    }
  }

  return { run, cancel, isRunning: () => active !== null };
}

function handleFrame(scheduler: ImageSlotScheduler, chunk: UnifiedStreamChunk): void {
  const { eventType, payload } = chunk;

  switch (eventType) {
    case 'start': {
      const prompt = typeof payload.prompt === 'string' ? payload.prompt : undefined;
      scheduler.planSlots(payload as Record<string, number>, prompt);
      return;
    }
    case 'comfyui_progress': {
      const resp = (payload.resp ?? {}) as Record<string, unknown>;
      const results = Array.isArray(resp.result) ? (resp.result as ImageResultItem[]) : [];
      if (results.length) {
        scheduler.applyResults('comfyui', results);
      } else {
        scheduler.applyProgress('comfyui', resp.progress);
      }
      return;
    }
    case 'model_result': {
      const category = scheduler.getCategoryFromModel(payload.model);
      if (!category) return;
      const resp = (payload.resp ?? {}) as Record<string, unknown>;
      const results = Array.isArray(resp.result) ? (resp.result as ImageResultItem[]) : [];

      if (payload.status === 'failed' || (typeof resp.progress === 'number' && resp.progress < 0)) {
        scheduler.markCategoryFailed(category, String(payload.errorMsg || ''));
        return;
      }
      if (payload.status === 'success') {
        if (results.length) {
          scheduler.applyResults(category, results);
        } else {
          scheduler.markCategoryFailed(category, String(payload.errorMsg || ''));
        }
        return;
      }
      scheduler.applyProgress(category, resp.progress);
      return;
    }
    default:
      return;
  }
}
