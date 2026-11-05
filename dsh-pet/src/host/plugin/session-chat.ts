/**
 * 绑定会话的消息观察器：把绑定 DSH 会话的 user/message / assistant/message / turn/end
 * 折叠成 `sections.sessionChat` 叶子，供桌宠面板的会话模式渲染。
 *
 * 自包含，不 import src/shared（DSH 单文件加载约束）；叶子形状与 shared/state 的
 * readSessionChat 各写一份（与 host/state 的约定一致）。
 * 去重策略：面板不做本地回显——用户在面板发的消息也会从会话事件流回来，
 * 这里的消息列表就是唯一真相，天然不会重复。
 * @module dsh-pet/src/host/plugin/session-chat
 */
import { readSessionBinding, type SessionBinding } from '../config/session-binding.ts';
import type { PollStateStore } from '../state.ts';
import type { ConfigPaths } from '../config/constants.ts';

/** 绑定会话消息窗口的条数上限：面板只要「最近一段」，无限累积会把 /state 撑大。 */
const MAX_MESSAGES = 200;

/** 绑定配置的重读间隔：绑定写在用户配置文件里，事件高频到来，不能每条都读盘。 */
const BINDING_TTL_MS = 1000;

/** 一条消息（与 shared/state 的 SessionChatMessage 同形，两端各写一份）。 */
interface ChatLine {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

/** 观察器输入。 */
export interface SessionChatInput {
  /** 轮询快照（写 sections.sessionChat）。 */
  readonly state: PollStateStore;
  /** 配置路径集（读用户层 sessionBinding）。 */
  readonly configPaths: ConfigPaths;
  /** 绑定会话收到 assistant/message 且抽得出文本时调用（供浮动对话弹窗认领回复）。 */
  readonly onAssistant?: (sessionId: string, text: string) => void;
  /** 绑定会话 turn/end 时调用（供浮动对话弹窗收尾等待）。 */
  readonly onTurnEnd?: (sessionId: string) => void;
}

/** 从一条 message 事件的 content 块里抽出全部文本（reasoning / 工具块不算），用换行拼接。 */
function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown } | null;
    if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') parts.push(b.text);
  }
  return parts.join('\n').trim();
}

/**
 * 创建绑定会话观察器。
 *
 * @returns handleSessionChatEvent(sessionId, event)：session-watch 的第一个监听器对每条
 * session/event 调用一次；内部自己过滤事件类型与会话 id，不关心的直接返回。
 */
export function createSessionChat(deps: SessionChatInput): {
  handleSessionChatEvent: (sessionId: string, event: unknown) => void;
} {
  const { state, configPaths, onAssistant, onTurnEnd } = deps;
  // 绑定缓存（TTL 内不重读文件）；null = 未绑定或形状不对
  let cachedAt = 0;
  let cachedBinding: SessionBinding | null = null;
  // 当前窗口：绑定的会话 id 变了就整窗重建，绝不把旧会话的消息带进新会话
  let sessionId = '';
  let messages: ChatLine[] = [];
  let busy = false;
  // 本回合是否已有一条 assistant 消息：true 时后续 assistant/message 按流式覆盖最后一条，
  // 而不是各追加一行（DSH 一次回合可能对同一段回复发多条事件）
  let assistantOpen = false;

  const publish = (): void => {
    state.writeSection('sessionChat', { sessionId, busy, messages: [...messages] });
  };

  const handleSessionChatEvent = (eventSessionId: string, event: unknown): void => {
    const type = (event as { type?: string } | null)?.type;
    if (type !== 'user/message' && type !== 'assistant/message' && type !== 'turn/end') return;
    const now = Date.now();
    if (now - cachedAt > BINDING_TTL_MS) {
      cachedAt = now;
      cachedBinding = readSessionBinding(configPaths);
    }
    const binding = cachedBinding;
    // 解绑（或从未绑定）：清窗并写一次空叶子，让面板回到未绑定态
    if (binding === null || !binding.enabled) {
      if (sessionId !== '') {
        sessionId = '';
        messages = [];
        busy = false;
        publish();
      }
      return;
    }
    // 换绑：整窗重建
    if (binding.sessionId !== sessionId) {
      sessionId = binding.sessionId;
      messages = [];
      busy = false;
      assistantOpen = false;
    }
    // 只处理绑定会话的事件；其它会话一律忽略
    if (eventSessionId !== sessionId) return;

    if (type === 'user/message') {
      const text = textOfContent((event as { data?: { message?: { content?: unknown } } })?.data?.message?.content);
      if (text === '') return;
      messages.push({ role: 'user', text, ts: Date.now() });
      busy = true;
      assistantOpen = false; // 新一轮提问：下一条 assistant 消息重新开一条
      if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES);
      publish();
      return;
    }
    if (type === 'assistant/message') {
      const text = textOfContent((event as { data?: { message?: { content?: unknown } } })?.data?.message?.content);
      if (text === '') return;
      const last = messages[messages.length - 1];
      if (assistantOpen && last !== undefined && last.role === 'assistant') {
        // 同一回合的后续 assistant 事件：覆盖最后一条（流式 / 修订），不重复堆行
        messages[messages.length - 1] = { role: 'assistant', text, ts: last.ts };
      } else {
        messages.push({ role: 'assistant', text, ts: Date.now() });
        if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES);
      }
      busy = true;
      assistantOpen = true;
      onAssistant?.(sessionId, text);
      publish();
      return;
    }
    // turn/end：回合收尾（无论成败），busy 归位
    busy = false;
    assistantOpen = false;
    onTurnEnd?.(sessionId);
    publish();
  };

  return { handleSessionChatEvent };
}

/** 观察器产出（供装配层按需 Pick）。 */
export type SessionChatWatcher = ReturnType<typeof createSessionChat>;
