/**
 * Demo 入口：把核心库（解析 / 传输 / 调度）接到一个零框架的原生 DOM 界面上。
 * 所有交互只消费 AgentStreamEvent 与 ImageSlot 两个统一模型，
 * 证明「换供应商协议，UI 零改动」的主张。
 */
import './style.css';
import { streamAgentChat, createUnifiedSseStreamer } from '../core/streamer';
import { createImageGenerationRunner } from '../core/runner';
import { isGenerateImageTool, parseGenerateImageOutputUrls } from '../core/agent-sse';
import type { AgentStreamEvent, AgentToolPayload, ImageSlot } from '../core/types';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

/** ---------- ① Agent 对话 ---------- */

const PROTOCOL_URLS: Record<string, string> = {
  openai: '/api/agent/openai/chat',
  agent: '/api/agent/agent/chat',
  events: '/api/agent/events/chat',
};

const PROTOCOL_DESCS: Record<string, string> = {
  openai: 'data = { object: "chat.completion.chunk", content: "增量", isLast }',
  agent: 'data = { conversationId, content: { type: "message_delta", delta } }',
  events: 'data = { type: "TEXT", status, content }（无结束帧，靠连接关闭）',
};

const protocolSelect = $<HTMLSelectElement>('protocol');
const protocolDesc = $('protocol-desc');
const chatInput = $<HTMLTextAreaElement>('chat-input');
const chatSend = $<HTMLButtonElement>('chat-send');
const chatCancel = $<HTMLButtonElement>('chat-cancel');
const chatBox = $('chat');
const agentRaw = $('agent-raw');

let chatController: AbortController | null = null;

function updateProtocolDesc(): void {
  protocolDesc.textContent = PROTOCOL_DESCS[protocolSelect.value] ?? '';
}
protocolSelect.addEventListener('change', updateProtocolDesc);
updateProtocolDesc();

interface ChatTurn {
  root: HTMLElement;
  thinkingText: HTMLElement | null;
  answerText: HTMLElement | null;
  toolsEl: HTMLElement | null;
  toolMap: Map<string, HTMLElement>;
  relatedEl: HTMLElement | null;
}

function createTurn(question: string): ChatTurn {
  const userTurn = document.createElement('div');
  userTurn.className = 'turn user';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = question;
  userTurn.appendChild(bubble);
  chatBox.appendChild(userTurn);

  const aiTurn = document.createElement('div');
  aiTurn.className = 'turn assistant';
  chatBox.appendChild(aiTurn);
  chatBox.scrollTop = chatBox.scrollHeight;

  return { thinkingText: null, answerText: null, toolsEl: null, toolMap: new Map(), relatedEl: null, root: aiTurn };
}

function ensureBlock(turn: ChatTurn, kind: 'thinking' | 'answer', root: HTMLElement): HTMLElement {
  if (kind === 'thinking' && turn.thinkingText) return turn.thinkingText;
  if (kind === 'answer' && turn.answerText) return turn.answerText;

  const block = document.createElement('div');
  block.className = `block ${kind}`;
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = kind === 'thinking' ? '深度思考' : '回答';
  const text = document.createElement('span');
  block.append(label, text);
  root.appendChild(block);
  chatBox.scrollTop = chatBox.scrollHeight;

  if (kind === 'thinking') turn.thinkingText = text;
  else turn.answerText = text;
  return text;
}

function renderToolEvent(turn: ChatTurn, payload: AgentToolPayload, root: HTMLElement): void {
  let tool = turn.toolMap.get(payload.toolId);
  if (!tool) {
    if (!turn.toolsEl) {
      turn.toolsEl = document.createElement('div');
      turn.toolsEl.className = 'tools';
      root.appendChild(turn.toolsEl);
    }
    tool = document.createElement('div');
    tool.className = 'tool';
    tool.dataset.status = payload.status;
    const head = document.createElement('div');
    head.className = 'head';
    const name = document.createElement('span');
    name.className = 'name';
    const status = document.createElement('span');
    status.className = 'status';
    head.append(name, status);
    tool.appendChild(head);
    turn.toolsEl.appendChild(tool);
    turn.toolMap.set(payload.toolId, tool);
  }

  tool.dataset.status = payload.status;
  const name = tool.querySelector<HTMLElement>('.name');
  const status = tool.querySelector<HTMLElement>('.status');
  if (name) name.textContent = payload.name;
  if (status) status.textContent = payload.status === 'SUCCEEDED' ? '✓ 完成' : payload.status;

  // 旧 detail / images 替换为新内容
  tool.querySelectorAll('.detail, .images').forEach((el) => el.remove());

  if (payload.status === 'SUCCEEDED') {
    if (isGenerateImageTool(payload)) {
      const content = payload.content as Record<string, unknown> | undefined;
      const urls = parseGenerateImageOutputUrls(content?.output);
      if (urls.length) {
        const images = document.createElement('div');
        images.className = 'images';
        for (const url of urls) {
          const img = document.createElement('img');
          img.src = url;
          img.alt = payload.name;
          images.appendChild(img);
        }
        tool.appendChild(images);
      }
    } else {
      const detail = document.createElement('div');
      detail.className = 'detail';
      detail.textContent = summarizeToolOutput(payload.content);
      tool.appendChild(detail);
    }
  } else {
    const detail = document.createElement('div');
    detail.className = 'detail';
    detail.textContent = payload.functionCode ? `function_code: ${payload.functionCode}` : 'running…';
    tool.appendChild(detail);
  }
  chatBox.scrollTop = chatBox.scrollHeight;
}

function summarizeToolOutput(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content.slice(0, 140);
  try {
    return JSON.stringify(content).slice(0, 140);
  } catch {
    return '';
  }
}

function renderRelatedQuestions(turn: ChatTurn, questions: string[], root: HTMLElement): void {
  turn.relatedEl?.remove();
  const wrap = document.createElement('div');
  wrap.className = 'related';
  for (const q of questions) {
    const btn = document.createElement('button');
    btn.textContent = q;
    btn.addEventListener('click', () => {
      chatInput.value = q;
      void sendChat();
    });
    wrap.appendChild(btn);
  }
  root.appendChild(wrap);
  turn.relatedEl = wrap;
  chatBox.scrollTop = chatBox.scrollHeight;
}

function handleChatEvent(turn: ChatTurn, event: AgentStreamEvent, root: HTMLElement): void {
  switch (event.type) {
    case 'meta':
      return;
    case 'thinking':
      ensureBlock(turn, 'thinking', root).textContent += event.text;
      break;
    case 'answer':
      ensureBlock(turn, 'answer', root).textContent += event.text;
      break;
    case 'tool':
      renderToolEvent(turn, event.payload, root);
      break;
    case 'relatedQuestions':
      renderRelatedQuestions(turn, event.questions, root);
      break;
    case 'done':
      return;
  }
}

async function sendChat(): Promise<void> {
  const question = chatInput.value.trim();
  if (!question || chatController) return;

  chatInput.value = '';
  chatSend.disabled = true;
  chatCancel.disabled = false;
  agentRaw.textContent = '';

  const turn = createTurn(question);
  const root = turn.root;
  chatController = new AbortController();

  const log = (data: string): void => {
    agentRaw.textContent += `${data}\n`;
  };

  try {
    await streamAgentChat({
      url: PROTOCOL_URLS[protocolSelect.value] ?? PROTOCOL_URLS.agent,
      body: { content: question },
      signal: chatController.signal,
      onEvent: (event) => handleChatEvent(turn, event, root),
      onRaw: log,
      onEnd: () => {
        const answer = turn.answerText;
        if (answer && !answer.textContent) answer.textContent = '（流已结束，无正文）';
      },
      onError: (err) => {
        const block = document.createElement('div');
        block.className = 'block';
        block.style.borderColor = 'rgba(255,107,107,0.5)';
        block.textContent = `流式请求失败：${err.message}`;
        root.appendChild(block);
      },
    });
  } finally {
    chatController = null;
    chatSend.disabled = false;
    chatCancel.disabled = true;
  }
}

chatSend.addEventListener('click', () => void sendChat());
chatCancel.addEventListener('click', () => chatController?.abort());
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void sendChat();
});

/** ---------- ② 多模型并行生图 ---------- */

const genPrompt = $<HTMLInputElement>('gen-prompt');
const genRun = $<HTMLButtonElement>('gen-run');
const genCancel = $<HTMLButtonElement>('gen-cancel');
const genStatus = $('gen-status');
const slotsBox = $('slots');
const genLog = $('gen-log');

const streamImageGenerate = createUnifiedSseStreamer('/api/image/generate');

const runner = createImageGenerationRunner({
  stream: streamImageGenerate,
  onChange: (slots) => renderSlots(slots),
  onFrame: (chunk) => {
    genLog.textContent += `event:${chunk.eventType}  ${JSON.stringify(chunk.payload).slice(0, 160)}\n`;
  },
  onComplete: (slots) => setStatus(`完成 · ${countOf(slots)} / ${slots.length} 张成功`),
  onCancel: (slots) => setStatus(`已取消 · ${countOf(slots)} / ${slots.length} 张成功`),
  onError: (err) => setStatus(`失败 · ${err.message}`),
});

function setStatus(text: string): void {
  genStatus.textContent = text;
}

function countOf(slots: ImageSlot[]): number {
  return slots.filter((s) => s.status === 'done').length;
}

function renderSlots(slots: ImageSlot[]): void {
  if (!slots.length) {
    slotsBox.innerHTML = '<div class="empty">尚未提交任务 —— 点击「生成」体验三通道并行调度</div>';
    return;
  }

  slotsBox.innerHTML = '';
  for (const slot of slots) {
    const card = document.createElement('div');
    card.className = 'slot';
    card.dataset.status = slot.status;
    card.dataset.category = slot.category;

    const head = document.createElement('div');
    head.className = 'slot-head';
    const cat = document.createElement('span');
    cat.className = 'slot-cat';
    cat.textContent = slot.category.toUpperCase();
    const state = document.createElement('span');
    state.textContent = stateText(slot);
    head.append(cat, state);

    const body = document.createElement('div');
    body.className = 'slot-body';

    if (slot.status === 'done' && slot.imageUrl) {
      const img = document.createElement('img');
      img.src = slot.imageUrl;
      img.alt = slot.prompt ?? slot.category;
      body.appendChild(img);
    } else if (slot.status === 'failed' || slot.status === 'cancelled') {
      body.textContent = slot.error || stateText(slot);
    } else {
      const pct = document.createElement('span');
      pct.className = 'pct';
      pct.textContent = `${slot.progress}%`;
      const track = document.createElement('div');
      track.className = 'progress-track';
      const fill = document.createElement('div');
      fill.className = 'progress-fill';
      fill.style.width = `${Math.max(4, slot.progress)}%`;
      track.appendChild(fill);
      body.append(pct, track);
    }

    card.append(head, body);
    slotsBox.appendChild(card);
  }
}

function stateText(slot: ImageSlot): string {
  switch (slot.status) {
    case 'pending':
      return '排队中';
    case 'generating':
      return '生成中';
    case 'done':
      return '完成';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已取消';
    default:
      return slot.status;
  }
}

async function runGeneration(): Promise<void> {
  genLog.textContent = '';
  const counts = {
    comfyui: clampCount('count-comfyui'),
    gemini: clampCount('count-gemini'),
    gpt: clampCount('count-gpt'),
  };

  setStatus('已提交 · 等待 start 帧…');
  await runner.run({
    body: {
      prompt: genPrompt.value.trim(),
      counts,
      failChannel: ($<HTMLInputElement>('fail-gemini').checked ? 'gemini' : ''),
    },
  });
}

function clampCount(id: string): number {
  const el = $<HTMLInputElement>(id);
  return Math.min(4, Math.max(0, Number(el.value) || 0));
}

function refreshGenButtons(): void {
  genCancel.disabled = !runner.isRunning();
}

genRun.addEventListener('click', () => {
  void runGeneration().finally(refreshGenButtons);
  refreshGenButtons();
});
genCancel.addEventListener('click', () => {
  runner.cancel();
  refreshGenButtons();
});

renderSlots([]);
setStatus('等待提交');
