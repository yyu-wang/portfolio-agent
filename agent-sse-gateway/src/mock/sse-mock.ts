/**
 * Mock SSE 服务器（Vite dev 中间件）。
 *
 * 让 demo 在零后端环境下完整跑通三种供应商协议与多模型生图流：
 *   POST /api/agent/openai/chat  —— OpenAI 兼容扁平 chunk（data 帧，isLast 结束）
 *   POST /api/agent/agent/chat   —— Agent 嵌套 delta（content.type 分发，message_end 结束）
 *   POST /api/agent/events/chat  —— 大写扁平事件（无显式结束帧，靠连接关闭）
 *   POST /api/image/generate     —— 命名事件流（start / comfyui_progress / model_result / complete）
 */
import type { ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';

interface MockFrame {
  at: number;
  event?: string;
  data: unknown;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function mockImage(label: string, seed: number): string {
  const hue = (seed * 47) % 360;
  const cx = 200 + ((seed * 17) % 112);
  const cy = 180 + ((seed * 29) % 152);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue},72%,56%)"/>` +
    `<stop offset="1" stop-color="hsl(${(hue + 62) % 360},68%,32%)"/>` +
    `</linearGradient></defs>` +
    `<rect width="512" height="512" fill="url(#g)"/>` +
    `<circle cx="${cx}" cy="${cy}" r="96" fill="rgba(255,255,255,0.14)"/>` +
    `<circle cx="${cy}" cy="${cx}" r="46" fill="rgba(0,0,0,0.10)"/>` +
    `<text x="50%" y="52%" font-family="monospace" font-size="36" fill="rgba(255,255,255,0.92)" text-anchor="middle">${label}</text>` +
    `<text x="50%" y="61%" font-family="monospace" font-size="17" fill="rgba(255,255,255,0.6)" text-anchor="middle">mock #${seed}</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function readBody(req: Connect.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}') as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

async function playTimeline(res: ServerResponse, frames: MockFrame[]): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let prev = 0;
  for (const frame of frames) {
    const wait = Math.max(0, frame.at - prev);
    if (wait > 0) await sleep(wait);
    if (res.destroyed || res.writableEnded) return;
    prev = frame.at;
    if (frame.event) res.write(`event: ${frame.event}\n`);
    res.write(`data: ${JSON.stringify(frame.data)}\n\n`);
  }
  res.end();
}

function buildTimeline() {
  const frames: MockFrame[] = [];
  let t = 0;
  const push = (delay: number, data: unknown, event?: string) => {
    t += delay;
    frames.push({ at: t, data, event });
  };
  return { push, frames };
}

function chunkText(text: string, size = 3): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

/** ---------- 协议 1：OpenAI 兼容扁平 chunk ---------- */

function openAiChatFrames(prompt: string): MockFrame[] {
  const conversationId = `conv-${Date.now().toString(36)}`;
  const reply =
    `针对「${prompt.slice(0, 24)}」，我检索了最新趋势数据：\n\n` +
    `1. 功能性面料与轻量设计继续主导；\n2. 大地色系 + 高饱和点缀是本季主推组合；\n` +
    `3. 建议优先落地 2-3 个系列概念，快速验证市场反应。\n\n已为你生成一张概念图，可继续追问细节。`;

  const tl = buildTimeline();
  tl.push(60, { object: 'chat.completion.chunk', conversationId, title: prompt.slice(0, 12), content: '', isLast: false });
  for (const chunk of chunkText(reply)) {
    tl.push(45, { object: 'chat.completion.chunk', conversationId, content: chunk, isLast: false });
  }
  tl.push(80, { object: 'chat.completion.chunk', conversationId, content: '', isLast: true });
  return tl.frames;
}

/** ---------- 协议 2：Agent 嵌套 delta ---------- */

function agentDeltaChatFrames(prompt: string): MockFrame[] {
  const conversationId = `conv-${Date.now().toString(36)}`;
  const thinking =
    '用户需要趋势分析与概念图。计划：先联网检索本季流行数据，再总结要点，最后调用生图工具输出概念图。';
  const answer =
    `围绕「${prompt.slice(0, 24)}」的结论：\n\n` +
    `- 联网检索命中 3 篇本季趋势报告，功能性面料热度同比上升；\n` +
    `- 配色建议大地色打底、高饱和点缀；\n- 已生成概念图一张，见下方生成队列。`;

  const tl = buildTimeline();
  tl.push(50, { conversationId, content: { type: 'conversation', conversationId } });
  for (const chunk of chunkText(thinking, 5)) {
    tl.push(40, { conversationId, content: { type: 'thinking_delta', delta: chunk } });
  }
  tl.push(120, {
    conversationId,
    content: { type: 'tool_use', toolId: 'tool-search-1', name: '联网搜索', status: 'STARTED', function_code: 'search_by_web' },
  });
  tl.push(700, {
    conversationId,
    content: {
      type: 'tool_result',
      toolId: 'tool-search-1',
      name: '联网搜索',
      status: 'SUCCEEDED',
      function_code: 'search_by_web',
      output: { hitCount: 3, topTitles: ['2026 春夏趋势报告', '面料工艺白皮书', '秀场数据速览'] },
    },
  });
  for (const chunk of chunkText(answer)) {
    tl.push(45, { conversationId, content: { type: 'message_delta', delta: chunk } });
  }
  tl.push(100, {
    conversationId,
    content: { type: 'tool_use', toolId: 'tool-image-1', name: 'AI 生图', status: 'STARTED', function_code: 'generate_image' },
  });
  tl.push(900, {
    conversationId,
    content: {
      type: 'tool_result',
      toolId: 'tool-image-1',
      name: 'AI 生图',
      status: 'SUCCEEDED',
      function_code: 'generate_image',
      output: `![概念图](${mockImage('AGENT', 7)})`,
    },
  });
  tl.push(80, { conversationId, content: { type: 'message_end' } });
  return tl.frames;
}

/** ---------- 协议 3：大写扁平事件 ---------- */

function flatEventsChatFrames(prompt: string): MockFrame[] {
  const thinking = '解析问题 → 检索知识库 → 组织答案。知识库命中 2 段相关内容，相似度 0.92 / 0.87。';
  const answer =
    `根据知识库内容回答「${prompt.slice(0, 24)}」：\n\n` +
    `本季重点在于结构简化与材质对比；建议先出小批量概念系列验证，再放大主推款。`;

  const tl = buildTimeline();
  tl.push(60, { type: 'THINKING', status: 'SUCCEEDED', content: thinking });
  for (const chunk of chunkText(answer)) {
    tl.push(45, { type: 'TEXT', status: 'SUCCEEDED', content: chunk });
  }
  tl.push(120, { type: 'FUNCTION', tool_id: 'tool-kb-1', name: '知识库检索', status: 'STARTED', function_code: 'search_by_dataset' });
  tl.push(600, {
    type: 'FUNCTION',
    tool_id: 'tool-kb-1',
    name: '知识库检索',
    status: 'SUCCEEDED',
    function_code: 'search_by_dataset',
    content: { output: { hits: 2, top: { score: 0.92, chunk: '…本季结构简化与材质对比为两大主线…' } } },
  });
  tl.push(100, { type: 'RELATED_QUESTIONS', status: 'SUCCEEDED', content: ['如何把概念落地成系列？', '预算有限先做哪个渠道？', '给我看竞品同类设计'] });
  return tl.frames;
}

/** ---------- 多模型并行生图 ---------- */

function imageGenerationFrames(body: Record<string, unknown>): MockFrame[] {
  const counts = (body.counts ?? {}) as Record<string, number>;
  const failChannel = typeof body.failChannel === 'string' ? body.failChannel : '';
  const comfyuiCount = Math.max(0, Number(counts.comfyui) || 1);
  const geminiCount = Math.max(0, Number(counts.gemini) || 1);
  const gptCount = Math.max(0, Number(counts.gpt) || 1);
  const taskId = `task-${Date.now().toString(36)}`;

  const tl = buildTimeline();
  tl.push(80, { taskId, comfyuiCount, geminiCount, gptCount }, 'start');

  // gpt 最快返回（~1.6s）
  const gptImages = Array.from({ length: gptCount }, (_, i) => ({ imageUrl: mockImage('GPT', 100 + i) }));
  tl.push(1520, { model: 'gpt-image-1', status: 'success', resp: { progress: 100, result: gptImages } }, 'model_result');

  // gemini 中速（~3.2s），可强制失败演示失败通道
  if (geminiCount > 0) {
    if (failChannel === 'gemini') {
      tl.push(3120, { model: 'gemini-2.5-flash-image', status: 'failed', errorMsg: '通道限流，本次任务失败', resp: { progress: -1 } }, 'model_result');
    } else {
      const geminiImages = Array.from({ length: geminiCount }, (_, i) => ({ imageUrl: mockImage('GEMINI', 200 + i) }));
      tl.push(3120, { model: 'gemini-2.5-flash-image', status: 'success', resp: { progress: 100, result: geminiImages } }, 'model_result');
    }
  }

  // comfyui 最慢（~5.2s），期间持续吐进度帧
  let at = 300;
  for (let p = 12; p <= 88; p += 12) {
    tl.push(at, { resp: { progress: p, result: [] } }, 'comfyui_progress');
    at = 620;
  }
  if (comfyuiCount > 0) {
    const comfyImages = Array.from({ length: comfyuiCount }, (_, i) => ({ imageUrl: mockImage('COMFYUI', 300 + i) }));
    tl.push(4600, { model: 'comfyui/flux-dev', status: 'success', resp: { progress: 100, result: comfyImages } }, 'model_result');
  }

  tl.push(120, { taskId, success: true }, 'complete');
  return tl.frames;
}

/** ---------- Vite 插件 ---------- */

export function sseMockPlugin(): Plugin {
  return {
    name: 'agent-sse-mock',
    configureServer(server) {
      server.middlewares.use(
        async (req: Connect.IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
          if (req.method !== 'POST' || !req.url || !req.url.startsWith('/api/')) {
            next();
            return;
          }
          const path = req.url.split('?')[0];
          const body = await readBody(req);
          const prompt = typeof body.content === 'string' ? body.content : typeof body.text === 'string' ? body.text : '帮我分析最新趋势';

          switch (path) {
            case '/api/agent/openai/chat':
              await playTimeline(res, openAiChatFrames(prompt));
              return;
            case '/api/agent/agent/chat':
              await playTimeline(res, agentDeltaChatFrames(prompt));
              return;
            case '/api/agent/events/chat':
              await playTimeline(res, flatEventsChatFrames(prompt));
              return;
            case '/api/image/generate':
              await playTimeline(res, imageGenerationFrames(body));
              return;
            default:
              next();
          }
        },
      );
    },
  };
}
