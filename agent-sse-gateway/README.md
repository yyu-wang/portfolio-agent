# Agent SSE Gateway

> 多协议 Agent SSE 流式网关 + 多模型并行生图槽位调度器
> —— 从生产级 AI 设计平台前端抽离的通用方案，核心零框架依赖，可直接移植到 Vue / React 项目。

[![CI](https://img.shields.io/github/actions/workflow/status/yyu-wang/agent-sse-gateway/ci.yml?branch=main&label=CI)](https://github.com/yyu-wang/agent-sse-gateway/actions/workflows/ci.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![Zero-dep core](https://img.shields.io/badge/core-零框架依赖-38d9a9)
![Vitest](https://img.shields.io/badge/test-vitest-6da75d)
![License](https://img.shields.io/badge/license-MIT-blue)

## 为什么需要它

接 AI 能力的前端迟早会遇到两类脏活，而且每个都会踩一遍坑：

**1. 供应商协议不一致。** 同一个「Agent 对话流」，不同供应商的 SSE 线格式完全不同——有 OpenAI 兼容的扁平 chunk，有 `content.type` 分发的嵌套 delta，也有大写扁平事件流、甚至没有显式结束帧。如果 UI 直接消费原始帧，每接一家供应商就要改一遍界面代码。

**2. 多模型并行生图的结果乱序返回。** 一次提交同时打到 comfyui / gemini / gpt 三条通道，返回顺序和提交顺序无关（gpt 约 1.6s、gemini 约 3.2s、comfyui 超 5s），中途还有进度帧、失败通道、用户取消、生成中再次提交……如果按到达顺序往列表里 push，图片位置会来回跳动。

本仓库把这两类问题的解法沉淀为两个可独立使用的模块：

- **`streamAgentChat` + 解析层**：三种供应商协议归一化为一套 `AgentStreamEvent`，UI 只消费统一事件模型，**新增供应商时界面零改动**；
- **`ImageSlotScheduler` + `createImageGenerationRunner`**：预占位 + 乱序回填 + 取消状态机 + 幽灵请求治理，**多通道并行生图布局稳定、状态可控**。

## 快速开始

```bash
npm install
npm run dev     # 打开 http://localhost:5173（内置 mock SSE 服务器，零后端可跑）
npm test        # vitest 单测（协议解析 + 槽位调度）
npm run build   # tsc --noEmit + vite build
```

Mock 服务器（`src/mock/sse-mock.ts`，Vite 中间件）完整模拟了三种供应商协议与多模型生图流的真实时序——gpt 先回、gemini 次之、comfyui 最慢并持续吐进度帧，还可模拟指定通道失败。

## Demo 演示什么

**面板 ①：Agent 对话 · 多协议流式解析**

切换「供应商协议」下拉框，观察同一段 UI 代码消费同一套 `AgentStreamEvent`：

- 思考流（thinking 增量）
- 正文流（answer 增量，打字机效果）
- 工具胶囊（tool_use → tool_result 按 toolId 合并；`generate_image` 工具直接展示生成图片）
- 推荐追问（relatedQuestions）
- 中途「取消」体验 abort 语义
- 展开底部「原始 SSE 帧日志」对照线格式与归一化事件的差异

**面板 ②：多模型并行生图 · 槽位调度**

- 三通道并行、乱序返回：`start` 预占位 → gpt 先回 → gemini 次之 → comfyui 最慢
- 勾选「模拟 gemini 失败」体验单通道失败（其它通道不受影响）
- 中途点「取消」体验取消状态机：**有结果保留 / 无结果标记已取消**
- 生成中再次点「生成」体验幽灵请求治理：旧流自动 abort，迟到帧不污染新任务

## 架构

```
┌─────────────────────────────────────────────────────────┐
│ UI 层（任意框架）                                         │
│   只消费 AgentStreamEvent / ImageSlot 两个统一模型        │
└──────────────┬───────────────────────────┬──────────────┘
               │                           │
┌──────────────▼──────────────┐ ┌──────────▼──────────────┐
│ streamAgentChat             │ │ createImageGenerationRunner │
│ Agent 对话流入口            │ │ 生图任务生命周期管理        │
└──────┬──────────────────────┘ └──────┬──────────────────┘
       │                             │
       │                     ┌───────▼───────────────┐
       │                     │ ImageSlotScheduler    │
       │                     │ 预占位 / 乱序回填 /    │
       │                     │ 取消状态机            │
       │                     └───────┬───────────────┘
┌──────▼─────────────────────────────▼───────────────────┐
│ createUnifiedSseStreamer（传输层，fetch-event-source）   │
│   AbortController 取消 · openWhenHidden · 帧分发        │
└──────────────┬──────────────────────────────────────────┘
┌──────────────▼──────────────────────────────────────────┐
│ agent-sse.ts 解析层：三种供应商协议 → 统一事件模型        │
└─────────────────────────────────────────────────────────┘
```

## 协议归一化对照表

### Agent 对话流

| 供应商协议 | 线格式（data 帧） | 结束语义 | 归一化事件 |
|---|---|---|---|
| OpenAI 兼容 | `{ object: "chat.completion.chunk", content: "增量", isLast }` | `isLast: true` | `meta` / `answer` / `done` |
| Agent 嵌套 delta | `{ conversationId, content: { type: "message_delta", delta } }` | `message_end` / `run_end` | `meta` / `thinking` / `answer` / `tool` / `done` |
| 大写扁平事件 | `{ type: "TEXT", status, content }` | 无显式结束帧（靠连接关闭） | `thinking` / `answer` / `tool` / `relatedQuestions` |

统一事件模型（`src/core/types.ts`）：

```ts
type AgentStreamEvent =
  | { type: 'meta'; title?; taskId? }
  | { type: 'thinking'; text }
  | { type: 'answer'; text }
  | { type: 'tool'; payload: AgentToolPayload }   // 按 toolId 合并 STARTED → SUCCEEDED
  | { type: 'relatedQuestions'; questions: string[] }
  | { type: 'done' };
```

### 多模型生图流（命名事件）

| 事件 | 载荷 | 调度器行为 |
|---|---|---|
| `event: start` | `{ comfyuiCount, geminiCount, gptCount }` | 按通道顺序一次性预占位 |
| `event: comfyui_progress` | `{ resp: { progress, result? } }` | 刷新 comfyui 槽位进度 / 增量回填 |
| `event: model_result` | `{ model, status, resp: { progress, result } }` | 按 `model` 反查通道命中槽位区间 |
| `event: complete` | `{ taskId, success }` | 唯一合法的完成判定，触发 sweep 收尾 |

乱序时序（demo 实测）：

```
提交 ──▶ event:start            预占位 [comfyui][gemini][gpt] 布局即刻稳定
t≈0.3s ─▶ comfyui_progress(12%) ┐
t≈0.9s ─▶ comfyui_progress(24%) │ 进度帧持续刷新
t≈1.6s ─▶ model_result(gpt)  ✓  ┘ gpt 槽位先回填（乱序！）
t≈3.2s ─▶ model_result(gemini) ✓  gemini 槽位回填
t≈5.2s ─▶ model_result(comfyui)✓  comfyui 槽位回填
t≈5.4s ─▶ event:complete          sweep：仍无结果的槽位统一标记失败
```

## 核心设计决策（生产踩坑沉淀）

**1. 完成判定必须且只能由 `event: complete` 触发。**
`model_result` 帧里也可能带 `isLast: true`——但它只表示「该模型的流向结束」，此时 comfyui 的进度帧可能还在路上；若提前结束整个流，会直接丢掉后续到达的图片。见 `isUnifiedComplete()`。

**2. 预占位 + 乱序回填，而非按到达顺序 push。**
`start` 到达即按通道顺序占满槽位，用户从第一帧起看到的就是稳定布局；之后乱序到达的结果帧按「通道区间 + 通道内游标」命中槽位。布局不跳动，是用户对「并行生图」的心智预期。

**3. 幽灵请求治理：generation 计数器。**
生成中再次提交，新任务自动 abort 旧流；被 abort 的旧流后续若仍有帧到达（网络层延迟），generation 比对保证迟到帧不会污染新任务的 UI。见 `runner.ts`。

**4. 取消 ≠ 清空。**
用户取消时，已出图的槽位保留、未出图的标记 `cancelled`；流自然结束时仍无结果的槽位统一标记 `failed`（保留重试语义）。三种终态互不覆盖。

**5. `openWhenHidden: true`。**
原生 `EventSource` 在页面切后台时会被浏览器断连；基于 fetch 的实现配合 `openWhenHidden` 保证切后台不断流——生图是长任务，用户切走再切回来必须还在跑。

## 在你的项目中使用

核心代码位于 `src/core/`，零框架依赖，拷过去即可用。

**Agent 对话流：**

```ts
import { streamAgentChat } from './core/streamer';

const controller = new AbortController();
await streamAgentChat({
  url: '/v1/agent/chat',
  body: { content: prompt },
  signal: controller.signal,
  onEvent: (event) => {
    switch (event.type) {
      case 'thinking': appendThinking(event.text); break;
      case 'answer':   appendAnswer(event.text);   break;
      case 'tool':     updateToolCapsule(event.payload); break; // 按 toolId 合并
      case 'relatedQuestions': renderChips(event.questions); break;
    }
  },
  onEnd: () => finishTurn(),
});
```

**多模型并行生图（Vue 3 示例）：**

```ts
import { createUnifiedSseStreamer } from './core/streamer';
import { createImageGenerationRunner } from './core/runner';

const runner = createImageGenerationRunner({
  stream: createUnifiedSseStreamer('/v1/unified/textToImage'),
  onChange: (slots) => (imgList.value = slots),  // 槽位快照直接绑渲染
  onCancel: (slots) => message.info('已取消'),
});

// 提交（生成中再次调用会自动取消上一次 —— 幽灵请求治理）
await runner.run({ body: { prompt, counts: { comfyui: 1, gemini: 1, gpt: 1 } } });

// 用户取消
runner.cancel();
```

同一个流式工厂 `createUnifiedSseStreamer(path)` 适配所有生图场景——文生图 / 线稿渲染 / 多图融合 / 局部重绘 / 配色，只差一个 path。

## 目录结构

```
src/
├── core/               # 核心库（零框架依赖，可直接移植）
│   ├── types.ts        # 统一事件模型 AgentStreamEvent / ImageSlot
│   ├── agent-sse.ts    # 多协议 SSE 解析层（三种供应商协议归一化）
│   ├── streamer.ts     # 传输层（fetch-event-source 封装 + 流式请求工厂）
│   ├── scheduler.ts    # 多模型并行生图槽位调度器
│   └── runner.ts       # 生图 Runner（传输 + 调度 + AbortController 组装）
├── demo/               # 原生 DOM demo 界面（不依赖任何框架）
│   ├── main.ts
│   └── style.css
└── mock/
    └── sse-mock.ts     # Vite 中间件 mock SSE 服务器（真实时序模拟）
tests/                  # vitest 单测（协议解析 / 槽位调度器）
```

## License

[MIT](./LICENSE) · 协议与业务均已脱敏，可自由用于自己的项目。
