import { describe, expect, it } from 'vitest';
import { ImageSlotScheduler } from '../src/core/scheduler';

function createScheduler(): { scheduler: ImageSlotScheduler; snapshots: ReturnType<ImageSlotScheduler['getSlots']>[] } {
  const snapshots: ReturnType<ImageSlotScheduler['getSlots']>[] = [];
  const scheduler = new ImageSlotScheduler({ onChange: (slots) => snapshots.push(slots) });
  return { scheduler, snapshots };
}

describe('ImageSlotScheduler · 预占位', () => {
  it('start 后按 comfyui → gemini → gpt 顺序一次性占位', () => {
    const { scheduler } = createScheduler();
    const slots = scheduler.planSlots({ comfyui: 2, gemini: 1, gpt: 1 });
    expect(slots).toHaveLength(4);
    expect(slots.map((s) => s.category)).toEqual(['comfyui', 'comfyui', 'gemini', 'gpt']);
    expect(slots.every((s) => s.status === 'generating')).toBe(true);
  });

  it('后端未回数量时兜底单槽位', () => {
    const { scheduler } = createScheduler();
    const slots = scheduler.planSlots({});
    expect(slots).toHaveLength(1);
    expect(slots[0].category).toBe('comfyui');
  });
});

describe('ImageSlotScheduler · 乱序回填', () => {
  it('model 字段反查通道（comfyui/flux-dev → comfyui）', () => {
    const { scheduler } = createScheduler();
    expect(scheduler.getCategoryFromModel('comfyui/flux-dev')).toBe('comfyui');
    expect(scheduler.getCategoryFromModel('GPT-Image-1')).toBe('gpt');
    expect(scheduler.getCategoryFromModel('unknown-model')).toBeNull();
  });

  it('gpt 先回、gemini 后回也能命中各自槽位（顺序无关）', () => {
    const { scheduler } = createScheduler();
    scheduler.planSlots({ comfyui: 1, gemini: 1, gpt: 1 });

    scheduler.applyResults('gpt', ['https://x/gpt.png']);
    scheduler.applyResults('gemini', ['https://x/gemini.png']);

    const slots = scheduler.getSlots();
    expect(slots[1]).toMatchObject({ category: 'gemini', status: 'done', imageUrl: 'https://x/gemini.png' });
    expect(slots[2]).toMatchObject({ category: 'gpt', status: 'done', imageUrl: 'https://x/gpt.png' });
    expect(slots[0].status).toBe('generating');
  });

  it('通道内游标顺序回填多图', () => {
    const { scheduler } = createScheduler();
    scheduler.planSlots({ comfyui: 2 });
    scheduler.applyResults('comfyui', ['https://x/1.png']);
    scheduler.applyResults('comfyui', ['https://x/2.png']);
    const slots = scheduler.getSlots();
    expect(slots[0].imageUrl).toBe('https://x/1.png');
    expect(slots[1].imageUrl).toBe('https://x/2.png');
  });

  it('进度帧只更新未完成槽位，不覆盖已回填结果', () => {
    const { scheduler } = createScheduler();
    scheduler.planSlots({ comfyui: 2 });
    scheduler.applyResults('comfyui', ['https://x/1.png']);
    scheduler.applyProgress('comfyui', 60);
    const slots = scheduler.getSlots();
    expect(slots[0]).toMatchObject({ status: 'done', progress: 100 });
    expect(slots[1]).toMatchObject({ status: 'generating', progress: 60 });
  });

  it('超过计划数量的结果不会越界', () => {
    const { scheduler } = createScheduler();
    scheduler.planSlots({ comfyui: 1, gpt: 1 });
    scheduler.applyResults('comfyui', ['https://x/1.png', 'https://x/2.png', 'https://x/3.png']);
    const slots = scheduler.getSlots();
    expect(slots[0].imageUrl).toBe('https://x/1.png');
    expect(slots[1].status).toBe('generating');
  });
});

describe('ImageSlotScheduler · 状态机', () => {
  it('markCategoryFailed 只影响该通道未完成槽位', () => {
    const { scheduler } = createScheduler();
    scheduler.planSlots({ comfyui: 1, gemini: 1 });
    scheduler.applyResults('comfyui', ['https://x/1.png']);
    scheduler.markCategoryFailed('gemini', '通道限流');
    const slots = scheduler.getSlots();
    expect(slots[0].status).toBe('done');
    expect(slots[1]).toMatchObject({ status: 'failed', error: '通道限流' });
  });

  it('sweep：流结束时仍无结果的槽位统一标记失败', () => {
    const { scheduler } = createScheduler();
    scheduler.planSlots({ comfyui: 1, gemini: 1, gpt: 1 });
    scheduler.applyResults('gpt', ['https://x/gpt.png']);
    scheduler.sweep();
    const slots = scheduler.getSlots();
    expect(slots[0].status).toBe('failed');
    expect(slots[1].status).toBe('failed');
    expect(slots[2].status).toBe('done');
  });

  it('cancel：已出图保留，未出图标记已取消', () => {
    const { scheduler } = createScheduler();
    scheduler.planSlots({ comfyui: 1, gemini: 1 });
    scheduler.applyResults('gemini', ['https://x/gemini.png']);
    scheduler.cancel('用户取消');
    const slots = scheduler.getSlots();
    expect(slots[0]).toMatchObject({ status: 'cancelled', error: '用户取消' });
    expect(slots[1]).toMatchObject({ status: 'done' });
  });

  it('每次变化回调返回浅拷贝快照，外部修改不影响内部状态', () => {
    const { scheduler, snapshots } = createScheduler();
    scheduler.planSlots({ gpt: 1 });
    const snapshot = snapshots[0];
    snapshot[0].status = 'done';
    expect(scheduler.getSlots()[0].status).toBe('generating');
  });
});
