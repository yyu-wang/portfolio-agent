import { describe, expect, it } from 'vitest';
import { parseAgentSsePayload, parseGenerateImageOutputUrls } from '../src/core/agent-sse';

describe('parseAgentSsePayload · OpenAI 兼容协议', () => {
  it('解析扁平 chunk 的正文增量', () => {
    const frame = JSON.stringify({ object: 'chat.completion.chunk', content: '你好', isLast: false });
    const events = parseAgentSsePayload(`data: ${frame}`);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('answer');
    expect((events[0] as { text: string }).text).toBe('你好');
  });

  it('带 conversationId 的帧额外产出 meta 事件', () => {
    const frame = JSON.stringify({ object: 'chat.completion.chunk', conversationId: 'c1', content: '你好', isLast: false });
    const events = parseAgentSsePayload(`data: ${frame}`);
    expect(events.map((e) => e.type)).toEqual(['meta', 'answer']);
  });

  it('isLast: true 归一化为 done 事件', () => {
    const frame = JSON.stringify({ object: 'chat.completion.chunk', content: '', isLast: true });
    const events = parseAgentSsePayload(`data: ${frame}`);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('空 content 且非结束的帧不产出事件', () => {
    const frame = JSON.stringify({ object: 'chat.completion.chunk', content: '', isLast: false });
    expect(parseAgentSsePayload(frame)).toEqual([]);
  });
});

describe('parseAgentSsePayload · Agent 嵌套 delta 协议', () => {
  it('conversation 帧归一化为 meta', () => {
    const frame = JSON.stringify({ conversationId: 'c2', content: { type: 'conversation', conversationId: 'c2' } });
    const events = parseAgentSsePayload(`data: ${frame}`);
    expect(events[0].type).toBe('meta');
  });

  it('thinking_delta / message_delta 归一化为 thinking / answer', () => {
    const t1 = JSON.stringify({ conversationId: 'c2', content: { type: 'thinking_delta', delta: '先检索' } });
    const t2 = JSON.stringify({ conversationId: 'c2', content: { type: 'message_delta', delta: '结论是' } });
    const events = parseAgentSsePayload(`${t1}\n${t2}`);
    expect(events.map((e) => e.type)).toEqual(['thinking', 'answer']);
  });

  it('tool_use → tool 事件，toolId 透传', () => {
    const frame = JSON.stringify({
      conversationId: 'c2',
      content: { type: 'tool_use', toolId: 't1', name: '联网搜索', status: 'STARTED', function_code: 'search_by_web' },
    });
    const events = parseAgentSsePayload(`data: ${frame}`);
    expect(events[0].type).toBe('tool');
    expect((events[0] as { payload: { toolId: string; name: string } }).payload).toMatchObject({
      toolId: 't1',
      name: '联网搜索',
    });
  });

  it('message_end 归一化为 done', () => {
    const frame = JSON.stringify({ conversationId: 'c2', content: { type: 'message_end' } });
    const events = parseAgentSsePayload(frame);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });
});

describe('parseAgentSsePayload · 大写扁平事件协议', () => {
  it('THINKING / TEXT 增量归一化', () => {
    const frames = [
      JSON.stringify({ type: 'THINKING', status: 'SUCCEEDED', content: '分析中' }),
      JSON.stringify({ type: 'TEXT', status: 'SUCCEEDED', content: '答案' }),
    ].join('\n');
    const events = parseAgentSsePayload(frames);
    expect(events.map((e) => e.type)).toEqual(['thinking', 'answer']);
  });

  it('FUNCTION 事件带 tool_id 时归一化为 tool 事件', () => {
    const frame = JSON.stringify({ type: 'FUNCTION', tool_id: 'kb-1', name: '知识库', status: 'STARTED', function_code: 'search_by_dataset' });
    const events = parseAgentSsePayload(`data: ${frame}`);
    expect(events[0].type).toBe('tool');
  });

  it('RELATED_QUESTIONS 归一化为 relatedQuestions', () => {
    const frame = JSON.stringify({ type: 'RELATED_QUESTIONS', status: 'SUCCEEDED', content: ['追问1', '追问2'] });
    const events = parseAgentSsePayload(frame);
    expect(events[0].type).toBe('relatedQuestions');
    expect((events[0] as { questions: string[] }).questions).toEqual(['追问1', '追问2']);
  });
});

describe('parseAgentSsePayload · 容错', () => {
  it('忽略 [DONE]、空行与非 JSON 行', () => {
    expect(parseAgentSsePayload('')).toEqual([]);
    expect(parseAgentSsePayload('[DONE]')).toEqual([]);
    expect(parseAgentSsePayload('data: [DONE]')).toEqual([]);
    expect(parseAgentSsePayload('data: not-json')).toEqual([]);
  });

  it('一次网络帧携带多行 data 时全部解析', () => {
    const a = JSON.stringify({ type: 'TEXT', status: 'SUCCEEDED', content: 'A' });
    const b = JSON.stringify({ type: 'TEXT', status: 'SUCCEEDED', content: 'B' });
    const events = parseAgentSsePayload(`data: ${a}\ndata: ${b}`);
    expect(events).toHaveLength(2);
  });
});

describe('parseGenerateImageOutputUrls', () => {
  it('解析 markdown 图片', () => {
    const urls = parseGenerateImageOutputUrls('![概念图](https://cdn.example.com/a.png)');
    expect(urls).toEqual(['https://cdn.example.com/a.png']);
  });

  it('解析 data URI 与对象数组', () => {
    expect(parseGenerateImageOutputUrls('data:image/svg+xml;charset=utf-8,abc')).toEqual([
      'data:image/svg+xml;charset=utf-8,abc',
    ]);
    expect(parseGenerateImageOutputUrls([{ imageUrl: 'https://x/1.png' }, { url: 'https://x/2.png' }])).toEqual([
      'https://x/1.png',
      'https://x/2.png',
    ]);
  });

  it('非图片内容返回空数组', () => {
    expect(parseGenerateImageOutputUrls({ output: { hitCount: 3 } })).toEqual([]);
    expect(parseGenerateImageOutputUrls(null)).toEqual([]);
  });
});
