/**
 * 统一事件模型 —— 所有供应商协议最终都被归一化到这里的几种事件，
 * UI 层只消费这一套类型，新增供应商时界面零改动。
 */

/** Agent 供应商协议标识（对应三种真实世界的 SSE 线格式，详见 README 协议对照表） */
export type AgentProtocol = 'openai' | 'agent' | 'events';

/** 工具条事件载荷：按 toolId 合并更新，同一工具从 STARTED 到 SUCCEEDED 复用一条 UI */
export interface AgentToolPayload {
  toolId: string;
  name: string;
  status: string;
  functionCode?: string;
  toolType?: string;
  metadata?: unknown;
  content?: unknown;
}

export interface AgentStreamContext {
  conversationId?: string;
  msgId?: string;
}

export type AgentStreamEvent =
  | ({ type: 'meta'; title?: string; taskId?: string } & AgentStreamContext)
  | ({ type: 'thinking'; text: string } & AgentStreamContext)
  | ({ type: 'answer'; text: string } & AgentStreamContext)
  | ({ type: 'tool'; payload: AgentToolPayload } & AgentStreamContext)
  | ({ type: 'relatedQuestions'; questions: string[] } & AgentStreamContext)
  | ({ type: 'done' } & AgentStreamContext);

/** 生图槽位状态机：generating → done / failed / cancelled */
export type ImageSlotStatus = 'pending' | 'generating' | 'done' | 'failed' | 'cancelled';

export interface ImageSlot {
  index: number;
  /** 生图通道（模型类别），如 comfyui / gemini / gpt */
  category: string;
  status: ImageSlotStatus;
  /** 0-100 生成进度；100 = done；-1 = failed / cancelled */
  progress: number;
  imageUrl?: string;
  prompt?: string;
  error?: string;
}
