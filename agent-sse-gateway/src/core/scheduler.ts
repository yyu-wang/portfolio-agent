/**
 * 多模型并行生图槽位调度器。
 *
 * 核心思路：event:start 到达时按通道顺序一次性「预占位」，
 * 之后乱序到达的进度帧 / 结果帧按通道命中自己的槽位区间，
 * 通道内部用游标顺序回填 —— 用户从提交那一刻起就能看到稳定的布局，
 * 不会因模型返回顺序不同而跳动。
 */
import type { ImageSlot } from './types';

export interface SlotPlanEntry {
  category: string;
  /** 该通道槽位在全局列表中的起始下标 */
  start: number;
  count: number;
}

export interface ImageSlotSchedulerOptions {
  /** 通道顺序决定槽位排布顺序，默认 comfyui → gemini → gpt */
  categories?: string[];
  /** 每次槽位变化回调（浅拷贝快照），任意框架可直接绑定渲染 */
  onChange?: (slots: ImageSlot[]) => void;
}

export type ImageResultItem = string | { imageUrl?: string; url?: string };

const DONE = 100;
const FAILED = -1;

export class ImageSlotScheduler {
  private readonly categories: string[];
  private readonly onChange?: (slots: ImageSlot[]) => void;
  private slots: ImageSlot[] = [];
  private plan: Partial<Record<string, SlotPlanEntry>> = {};
  private cursors: Partial<Record<string, number>> = {};

  constructor(options: ImageSlotSchedulerOptions = {}) {
    this.categories =
      options.categories && options.categories.length
        ? options.categories
        : ['comfyui', 'gemini', 'gpt'];
    this.onChange = options.onChange;
  }

  /** 从 model_result 的 model 字段反查通道：'comfyui/flux-dev' → comfyui */
  getCategoryFromModel(model: unknown): string | null {
    if (!model || typeof model !== 'string') return null;
    const m = model.toLowerCase();
    for (const category of this.categories) {
      if (m.includes(category.toLowerCase())) return category;
    }
    return null;
  }

  /** start 帧后按通道顺序一次性预占位；后端没回数量时兜底单槽位 */
  planSlots(counts: Record<string, number> | Record<string, unknown>, prompt?: string): ImageSlot[] {
    this.plan = {};
    this.cursors = {};
    let cursor = 0;
    for (const category of this.categories) {
      const count = Math.max(0, Number(counts?.[category]) || 0);
      this.plan[category] = { category, start: cursor, count };
      cursor += count;
    }
    let total = cursor;
    if (total <= 0) {
      const fallback = this.categories[0];
      this.plan[fallback] = { category: fallback, start: 0, count: 1 };
      total = 1;
    }

    this.slots = Array.from({ length: total }, (_, index) => ({
      index,
      category: this.categoryOfIndex(index),
      status: 'generating',
      progress: 0,
      prompt,
    }));
    this.emit();
    return this.getSlots();
  }

  /** 通道级进度广播：只更新未完成的槽位 */
  applyProgress(category: string, progress: unknown): void {
    if (!this.plan[category]) return;
    const p = Number(progress);
    if (!Number.isFinite(p) || p < 0 || p >= DONE) return;
    this.patchCategory(category, (slot) =>
      slot.progress === DONE || slot.progress === FAILED
        ? null
        : { status: 'generating', progress: Math.round(p) },
    );
  }

  /** 通道内游标顺序回填结果图片 */
  applyResults(category: string, results: ImageResultItem[]): void {
    const entry = this.plan[category];
    if (!entry || !Array.isArray(results) || !results.length) return;

    let cursor = this.cursors[category] ?? 0;
    for (const item of results) {
      if (cursor >= entry.count) break;
      const imageUrl =
        typeof item === 'string'
          ? item
          : String((item as Record<string, unknown>)?.imageUrl || (item as Record<string, unknown>)?.url || '');
      if (!imageUrl) continue;
      const index = entry.start + cursor;
      if (this.slots[index]) {
        this.slots[index] = { ...this.slots[index], status: 'done', progress: DONE, imageUrl };
      }
      cursor += 1;
    }
    this.cursors[category] = cursor;
    this.emit();
  }

  markCategoryFailed(category: string, error?: string): void {
    this.patchCategory(category, (slot) =>
      slot.progress === DONE
        ? null
        : { status: 'failed', progress: FAILED, error: error || '生图失败' },
    );
  }

  markAllFailed(error?: string): void {
    for (const category of this.categories) {
      this.markCategoryFailed(category, error);
    }
  }

  /** complete 收尾：流结束时仍无结果的槽位统一标记失败（保留重试语义） */
  sweep(error = '生图未完成'): void {
    let mutated = false;
    this.slots = this.slots.map((slot) => {
      if (slot.progress === DONE || slot.progress === FAILED) return slot;
      mutated = true;
      return { ...slot, status: 'failed', progress: FAILED, error: slot.error || error };
    });
    if (mutated) this.emit();
  }

  /** 用户取消状态机：已出图的槽位保留，未出图的标记「已取消」 */
  cancel(reason = '用户取消'): void {
    let mutated = false;
    this.slots = this.slots.map((slot) => {
      if (slot.progress === DONE || slot.progress === FAILED) return slot;
      mutated = true;
      return { ...slot, status: 'cancelled', progress: FAILED, error: reason };
    });
    if (mutated) this.emit();
  }

  getSlots(): ImageSlot[] {
    return this.slots.map((slot) => ({ ...slot }));
  }

  getPlan(): Partial<Record<string, SlotPlanEntry>> {
    return { ...this.plan };
  }

  private categoryOfIndex(index: number): string {
    for (const category of this.categories) {
      const entry = this.plan[category];
      if (entry && index >= entry.start && index < entry.start + entry.count) {
        return category;
      }
    }
    return this.categories[0];
  }

  private patchCategory(
    category: string,
    patch: (slot: ImageSlot) => Partial<ImageSlot> | null,
  ): void {
    const entry = this.plan[category];
    if (!entry) return;
    let mutated = false;
    for (let i = 0; i < entry.count; i++) {
      const index = entry.start + i;
      const slot = this.slots[index];
      if (!slot) continue;
      const patchObj = patch(slot);
      if (!patchObj) continue;
      this.slots[index] = { ...slot, ...patchObj };
      mutated = true;
    }
    if (mutated) this.emit();
  }

  private emit(): void {
    this.onChange?.(this.getSlots());
  }
}
