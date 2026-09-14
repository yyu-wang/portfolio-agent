/**
 * 多协议 Agent SSE 解析层。
 *
 * 双层架构：
 *   parseAgentSsePayload  —— 拆分一条 onmessage 中可能合并的多行 data
 *   parseAgentSseDataLine —— 将单条 data 行归一化为 0~N 条 AgentStreamEvent
 *
 * 兼容三种线格式（自动探测，无需调用方声明协议）：
 *   1) OpenAI 兼容扁平 chunk：{ object: "chat.completion.chunk", content, isLast }
 *   2) Agent 嵌套 delta：     { conversationId, content: { type: "message_delta" | "tool_use" | ... } }
 *   3) 大写扁平事件：          { type: "THINKING" | "TEXT" | "FUNCTION" | "RELATED_QUESTIONS", status, content }
 *
 * 同时兼容两种根结构的动态适配（扁平 / 嵌套）、{ data: {...} } 包装解包、
 * 字符串 content 内嵌 JSON 的自动解析 —— 这些都是多供应商接入时真实踩过的坑。
 */
import type { AgentStreamContext, AgentStreamEvent, AgentToolPayload } from './types';

/** 从 AI 生图工具的 content.output 解析图片地址；兼容 markdown 图片、纯 URL、数组、对象 */
export function parseGenerateImageOutputUrls(output: unknown): string[] {
  if (output == null) return [];
  if (typeof output === 'string') {
    const urls: string[] = [];
    const mdImg = /!\[[^\]]*\]\(\s*((?:https?:\/\/|data:image\/)[^)\s]+)\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = mdImg.exec(output)) !== null) {
      urls.push(m[1]);
    }
    if (urls.length) return urls;
    const trimmed = output.trim();
    if (/^(?:https?:\/\/|data:image\/)/i.test(trimmed)) return [trimmed];
    return [];
  }
  if (Array.isArray(output)) {
    return output.flatMap((item) => parseGenerateImageOutputUrls(item));
  }
  if (typeof output === 'object') {
    const o = output as Record<string, unknown>;
    const u = o.url ?? o.imageUrl ?? o.image_url;
    if (typeof u === 'string' && /^(?:https?:\/\/|data:image\/)/i.test(u.trim())) {
      return [u.trim()];
    }
  }
  return [];
}

const GENERATE_IMAGE_CODE = 'generate_image';

export function isGenerateImageTool(t: AgentToolPayload): boolean {
  return (t.functionCode || '').toLowerCase() === GENERATE_IMAGE_CODE;
}

function getGenerateImageUrlsFromTool(t: AgentToolPayload): string[] {
  if (t.status !== 'SUCCEEDED') return [];
  if (!isGenerateImageTool(t)) return [];
  const c = t.content as Record<string, unknown> | undefined;
  if (!c || typeof c !== 'object') return [];
  return parseGenerateImageOutputUrls(c.output);
}

function extractGenerateImagePrompt(t: AgentToolPayload): string {
  const c = t.content as Record<string, unknown> | undefined;
  const input = c?.input as Record<string, unknown> | undefined;
  const args = input?.arguments as Record<string, unknown> | undefined;
  const prompt = args?.prompt;
  return typeof prompt === 'string' ? prompt.trim() : '';
}

export interface GenerateImageQueueItem {
  toolId: string;
  status: string;
  imageUrls: string[];
  prompt: string;
  done: boolean;
  loading: boolean;
  waiting: boolean;
}

export interface GenerateImageToolGroup {
  active: boolean;
  labelName: string;
  mergedImageUrls: string[];
  loading: boolean;
  done: boolean;
  totalCount: number;
  doneCount: number;
  queueItems: GenerateImageQueueItem[];
  memberTools: AgentToolPayload[];
}

/**
 * 同一轮对话里可能出现多条 generate_image 工具事件（多次 STARTED / 多个 toolId），
 * UI 上需要合并成一张「生成队列」卡片：进行中显示队列，结束后展示全部图片。
 */
export function buildGenerateImageToolGroup(
  tools: AgentToolPayload[] | undefined,
): GenerateImageToolGroup {
  const memberTools = (tools ?? []).filter(isGenerateImageTool);
  if (!memberTools.length) {
    return {
      active: false,
      labelName: '',
      mergedImageUrls: [],
      loading: false,
      done: false,
      totalCount: 0,
      doneCount: 0,
      queueItems: [],
      memberTools: [],
    };
  }

  const seen = new Set<string>();
  const mergedImageUrls: string[] = [];
  for (const t of memberTools) {
    for (const u of getGenerateImageUrlsFromTool(t)) {
      if (!seen.has(u)) {
        seen.add(u);
        mergedImageUrls.push(u);
      }
    }
  }

  const hasStarted = memberTools.some((t) => t.status === 'STARTED');
  const base = memberTools.map((t) => {
    const imageUrls = getGenerateImageUrlsFromTool(t);
    return {
      toolId: t.toolId,
      status: t.status,
      imageUrls,
      prompt: extractGenerateImagePrompt(t),
      done: imageUrls.length > 0 || t.status !== 'STARTED',
    };
  });

  const firstUnfinished = base.findIndex((item) => !item.done);
  const queueItems = base.map((item, idx) => ({
    ...item,
    loading: firstUnfinished !== -1 && idx === firstUnfinished,
    waiting: firstUnfinished !== -1 && idx > firstUnfinished && !item.done,
  }));

  const doneCount = base.filter((item) => item.done).length;
  return {
    active: true,
    labelName: memberTools[0]?.name ?? 'AI 生图',
    mergedImageUrls,
    loading: firstUnfinished !== -1 && hasStarted,
    done: doneCount >= base.length,
    totalCount: base.length,
    doneCount,
    queueItems,
    memberTools,
  };
}

/** ---------- 根结构归一化 ---------- */

function readPayloadContentString(payload: Record<string, unknown>): string {
  const c = payload.content;
  if (typeof c === 'string') return c;
  if (c && typeof c === 'object' && !Array.isArray(c)) {
    const inner = (c as Record<string, unknown>).content;
    if (typeof inner === 'string') return inner;
  }
  return '';
}

/** 解包 { data: {...} } 包装、把 JSON 字符串形式的 content 解析为对象 */
function normalizeAgentSseRoot(root: Record<string, unknown>): Record<string, unknown> {
  let node = root;
  const wrapped = node.data;
  if (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)) {
    node = { ...(wrapped as Record<string, unknown>) };
  }
  const content = node.content;
  if (typeof content === 'string' && content.trim()) {
    try {
      const parsed = JSON.parse(content.trim()) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ...node, content: parsed };
      }
    } catch {
      // content 是普通文本而非 JSON，保持原样
    }
  }
  return node;
}

/**
 * 根结构动态适配：兼容
 *   嵌套 { conversationId, content: { type, ... } }
 *   扁平 { type, content, ... }（整行即 payload）
 */
export function splitRootPayload(root: Record<string, unknown>): {
  conversationId?: string;
  payload: Record<string, unknown> | null;
} {
  const conversationId =
    (root.conversationId as string) || (root.chatId as string) || undefined;
  const inner = root.content;

  if (
    inner &&
    typeof inner === 'object' &&
    !Array.isArray(inner) &&
    typeof (inner as Record<string, unknown>).type === 'string'
  ) {
    return { conversationId, payload: inner as Record<string, unknown> };
  }
  if (typeof root.type === 'string') {
    return { conversationId, payload: root };
  }
  return { conversationId, payload: null };
}

/** ---------- 相关问题（兼容 snake/camel、JSON 字符串、纯数组） ---------- */

function normalizeRelatedQuestionArray(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const questions = raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  return questions.length ? questions : null;
}

function extractRelatedQuestionStrings(payload: Record<string, unknown>): string[] | null {
  const c = payload.content;
  if (c == null) return null;
  if (typeof c === 'string') {
    try {
      return normalizeRelatedQuestionArray(JSON.parse(c) as unknown);
    } catch {
      return null;
    }
  }
  if (Array.isArray(c)) return normalizeRelatedQuestionArray(c);
  if (typeof c === 'object' && !Array.isArray(c)) {
    const o = c as Record<string, unknown>;
    const raw = o.related_questions ?? o.relatedQuestions;
    if (Array.isArray(raw)) return normalizeRelatedQuestionArray(raw);
  }
  return null;
}

/** ---------- 协议 2：Agent 嵌套 delta ---------- */

const AGENT_DELTA_CONTENT_TYPES = new Set([
  'conversation',
  'custom',
  'message_start',
  'message_delta',
  'message_end',
  'run_end',
  'tool_use',
  'tool_result',
  'thinking_delta',
  'related_questions',
]);

const AGENT_DELTA_TYPE_ALIASES: Record<string, string> = {
  messagedelta: 'message_delta',
  messagestart: 'message_start',
  messageend: 'message_end',
  thinkingdelta: 'thinking_delta',
  runend: 'run_end',
  tooluse: 'tool_use',
  toolresult: 'tool_result',
  relatedquestions: 'related_questions',
};

function normalizeAgentDeltaContentType(type: unknown): string {
  if (typeof type !== 'string') return '';
  const lower = type.trim().toLowerCase();
  return AGENT_DELTA_TYPE_ALIASES[lower] || lower;
}

function isAgentDeltaContentPayload(payload: Record<string, unknown> | null): boolean {
  const type = normalizeAgentDeltaContentType(payload?.type);
  return !!type && AGENT_DELTA_CONTENT_TYPES.has(type);
}

function pickDeltaContext(
  root: Record<string, unknown>,
  payload: Record<string, unknown>,
): AgentStreamContext {
  const conversationId =
    (root.conversationId as string) ||
    (payload.conversationId as string) ||
    undefined;
  const msgId = (root.msgId as string) || (root.msg_id as string) || undefined;
  return { conversationId, msgId };
}

function parseAgentDeltaRoot(
  root: Record<string, unknown>,
  payload: Record<string, unknown>,
): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  const ctx = pickDeltaContext(root, payload);
  const contentType = normalizeAgentDeltaContentType(payload.type);
  const threadId = (payload.threadId as string) || (root.threadId as string) || undefined;

  switch (contentType) {
    case 'conversation': {
      const conversationId = (payload.conversationId as string) || ctx.conversationId;
      if (conversationId || ctx.msgId || threadId) {
        events.push({ type: 'meta', conversationId, msgId: ctx.msgId, taskId: threadId });
      }
      break;
    }
    case 'message_delta': {
      const delta = payload.delta ?? payload.text ?? payload.content;
      const text = typeof delta === 'string' ? delta : delta != null ? String(delta) : '';
      if (text) events.push({ type: 'answer', text, ...ctx });
      break;
    }
    case 'thinking_delta': {
      const delta = payload.delta ?? payload.text;
      if (typeof delta === 'string' && delta.length > 0) {
        events.push({ type: 'thinking', text: delta, ...ctx });
      }
      break;
    }
    case 'message_end':
    case 'run_end':
      events.push({ type: 'done', ...ctx });
      break;
    case 'tool_use': {
      const toolId = payload.toolId ?? payload.tool_id ?? payload.id;
      if (toolId != null) {
        events.push({
          type: 'tool',
          ...ctx,
          payload: buildToolPayload(payload, 'STARTED'),
        });
      }
      break;
    }
    case 'tool_result': {
      const toolId = payload.toolId ?? payload.tool_id ?? payload.id;
      if (toolId != null) {
        events.push({
          type: 'tool',
          ...ctx,
          payload: buildToolPayload(payload, 'SUCCEEDED'),
        });
      }
      break;
    }
    case 'related_questions': {
      const questions = extractRelatedQuestionStrings(payload);
      if (questions?.length) events.push({ type: 'relatedQuestions', questions, ...ctx });
      break;
    }
    default:
      break;
  }
  return events;
}

function buildToolPayload(
  payload: Record<string, unknown>,
  defaultStatus: string,
): AgentToolPayload {
  return {
    toolId: String(payload.toolId ?? payload.tool_id ?? payload.id),
    name: String(payload.name ?? payload.tool_name ?? '工具'),
    status: String(payload.status ?? defaultStatus),
    functionCode: payload.function_code != null ? String(payload.function_code) : undefined,
    toolType: payload.tool_type != null ? String(payload.tool_type) : undefined,
    metadata: payload.metadata ?? payload.input,
    content: payload.content ?? payload.output,
  };
}

function tryParseAgentDeltaEvents(root: Record<string, unknown>): AgentStreamEvent[] | null {
  const normalized = normalizeAgentSseRoot(root);
  const { payload } = splitRootPayload(normalized);

  if (payload && isAgentDeltaContentPayload(payload)) {
    return parseAgentDeltaRoot(normalized, payload);
  }

  const rootDelta = normalized.delta ?? normalized.text;
  if (typeof rootDelta === 'string') {
    return [{ type: 'answer', text: rootDelta, ...pickDeltaContext(normalized, normalized) }];
  }
  return null;
}

/** ---------- 协议 1：OpenAI 兼容扁平 chunk ---------- */

function isChatCompletionChunk(root: Record<string, unknown>): boolean {
  return root.object === 'chat.completion.chunk';
}

function parseChatCompletionChunk(root: Record<string, unknown>): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  const conversationId = (root.conversationId as string) || (root.id as string) || undefined;
  const msgId = (root.id as string) || conversationId;

  if (conversationId || msgId) {
    events.push({ type: 'meta', conversationId, msgId });
  }
  const delta = root.content;
  if (typeof delta === 'string' && delta.length > 0) {
    events.push({ type: 'answer', text: delta, conversationId, msgId });
  }
  if (root.isLast === true) {
    events.push({ type: 'done', conversationId, msgId });
  }
  return events;
}

/** ---------- 扁平事件的 meta 提取 ---------- */

function extractMetaFromRoot(root: Record<string, unknown>): {
  conversationId?: string;
  title?: string;
  taskId?: string;
} {
  const data = root.data as Record<string, unknown> | undefined;
  const conversationId =
    (root.conversationId as string) ||
    (root.chatId as string) ||
    (data?.conversationId as string) ||
    (data?.chatId as string);
  const title = (root.title as string) || (root.userFristInputMsg as string);
  const taskId = (root.taskId as string) || (root.task_id as string);
  return { conversationId, title, taskId };
}

/** ---------- 对外 API：双层解析 ---------- */

/**
 * 第二层：将单条 SSE data 行转为 0~N 条业务事件。
 * 解析顺序即协议探测顺序：Agent 嵌套 delta → OpenAI chunk → 大写扁平事件。
 */
export function parseAgentSseDataLine(raw: string): AgentStreamEvent[] {
  let trimmed = raw.trim();
  if (!trimmed || trimmed === '[DONE]') return [];
  // 兼容整行自带 `data: {...}` 前缀的录屏/代理格式
  if (trimmed.startsWith('data:')) {
    trimmed = trimmed.slice(5).trimStart();
  }

  let root: Record<string, unknown>;
  try {
    root = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }

  root = normalizeAgentSseRoot(root);

  const deltaEvents = tryParseAgentDeltaEvents(root);
  if (deltaEvents?.length) return deltaEvents;

  if (isChatCompletionChunk(root)) {
    return parseChatCompletionChunk(root);
  }

  const events: AgentStreamEvent[] = [];
  const meta = extractMetaFromRoot(root);
  if (meta.conversationId || meta.title || meta.taskId) {
    events.push({ type: 'meta', ...meta });
  }

  const { payload } = splitRootPayload(root);
  if (!payload) return events;

  if (isAgentDeltaContentPayload(payload)) {
    return [...events, ...parseAgentDeltaRoot(root, payload)];
  }

  const type = payload.type as string | undefined;
  const status = payload.status as string | undefined;

  if (type === 'THINKING' && status === 'SUCCEEDED') {
    const text = readPayloadContentString(payload);
    if (text) events.push({ type: 'thinking', text });
  }

  if (type === 'TEXT' && status === 'SUCCEEDED') {
    const text = readPayloadContentString(payload);
    if (text) events.push({ type: 'answer', text });
  }

  if (type === 'FUNCTION' && payload.tool_id != null) {
    events.push({
      type: 'tool',
      payload: {
        toolId: String(payload.tool_id),
        name: String(payload.name ?? ''),
        status: String(payload.status ?? ''),
        functionCode:
          payload.function_code != null ? String(payload.function_code) : undefined,
        toolType: payload.tool_type != null ? String(payload.tool_type) : undefined,
        metadata: payload.metadata,
        content: payload.content,
      },
    });
  }

  if (type === 'RELATED_QUESTIONS' && status === 'SUCCEEDED') {
    const questions = extractRelatedQuestionStrings(payload);
    if (questions?.length) events.push({ type: 'relatedQuestions', questions });
  }

  return events;
}

/**
 * 第一层：一条 onmessage 回调里可能合并了多行 data（部分网关/代理会合并帧），
 * 先按行拆分再逐行交给 parseAgentSseDataLine。
 */
export function parseAgentSsePayload(raw: string): AgentStreamEvent[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line !== '[DONE]');
  const chunks = lines.length ? lines : [trimmed];
  const events: AgentStreamEvent[] = [];
  for (const chunk of chunks) {
    events.push(...parseAgentSseDataLine(chunk));
  }
  return events;
}
