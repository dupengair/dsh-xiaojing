/**
 * 浮动对话弹窗 → 绑定 DSH 会话：把弹窗发来的文本投进绑定会话，并等这一回合的回复正文。
 *
 * 只做「投递 + 等一条回复」这一件事：绑定关系每次现读（面板可能刚改绑），会话服务软取
 * （独立模式没有 → 调用方回落到桌宠直聊）。回复正文来自 session-chat 观察器转发的
 * assistant/message 与 turn/end，不另开事件监听。
 * @module dsh-pet/src/host/plugin/session-prompt
 */
import { randomUUID } from 'node:crypto';
import { readSessionBinding } from '../config/session-binding.ts';
import type { ConfigPaths } from '../config/constants.ts';

/** 投递请求被接受的最长等待：超时按「没投出去」处理，调用方回落老路径。 */
const PROMPT_TIMEOUT_MS = 120_000;

/** 等这一回合回复正文的上限：到点 resolve undefined，不把 HTTP 请求永远挂着。 */
const REPLY_TIMEOUT_MS = 180_000;

/** 投递成功且拿到回复正文时的结果；`undefined` = 没绑定 / 服务缺失 / 投递失败 / 等超时。 */
export type SessionPromptReply = { readonly ok: true; readonly text: string } | undefined;

/** 宿主 sessionController 服务里本模块唯一用到的能力（软取，形状不对就当没有）。 */
interface PromptController {
  prompt(
    request: {
      readonly sessionId: string;
      readonly requestId: string;
      readonly mode: 'queue';
      readonly content: readonly { readonly type: 'text'; readonly text: string }[];
    },
    signal?: AbortSignal,
  ): Promise<unknown>;
}

/** 装配输入。 */
export interface SessionPromptDeps {
  /** 配置路径集（每次调用重读绑定）。 */
  readonly configPaths: ConfigPaths;
  /** 软取宿主可选服务（与 setup 的 optionalService 同语义：缺失返回 undefined）。 */
  readonly service: (name: string) => unknown;
  /** 日志出口；缺省静默（测试与独立模式不必造 logger）。 */
  readonly log?: (msg: string) => void;
}

/** 一次等待中的回复。 */
interface PendingReply {
  /** 本回合最近一条 assistant 文本；空串 = 还没收到。 */
  text: string;
  /** 超时定时器（resolve 时清掉）。 */
  timer: ReturnType<typeof setTimeout>;
  /** 把结果交给 chatInSession 的 await。 */
  resolve: (reply: SessionPromptReply) => void;
}

/**
 * 创建「绑定会话投递器」。
 *
 * @param deps - 配置路径、可选服务取值器与日志出口。
 * @returns chatInSession 供路由调用；handleAssistant / handleTurnEnd 供观察器转发事件。
 */
export function createSessionPrompt(deps: SessionPromptDeps): {
  chatInSession: (petId: string, text: string) => Promise<SessionPromptReply>;
  handleAssistant: (sessionId: string, text: string) => void;
  handleTurnEnd: (sessionId: string) => void;
} {
  const { configPaths, service } = deps;
  const log = deps.log ?? (() => {});
  // 按会话排队的待办：同一会话可能有多个弹窗请求同时在等（Map 的值是 FIFO 队列）。
  const pending = new Map<string, PendingReply[]>();

  /** 从队列里摘掉一个等待并交出结果（清定时器；队列空了连键一起删，防泄漏）。 */
  const finish = (sessionId: string, turn: PendingReply, reply: SessionPromptReply): void => {
    clearTimeout(turn.timer);
    const queue = pending.get(sessionId);
    if (queue !== undefined) {
      const index = queue.indexOf(turn);
      if (index >= 0) queue.splice(index, 1);
      if (queue.length === 0) pending.delete(sessionId);
    }
    turn.resolve(reply);
  };

  /** 挂一个等待：超时按「拿不到正文」收尾，不让路由请求一直挂着。 */
  const waitForReply = (sessionId: string): { promise: Promise<SessionPromptReply>; turn: PendingReply } => {
    let turn!: PendingReply;
    const promise = new Promise<SessionPromptReply>((resolve) => {
      turn = {
        text: '',
        resolve,
        timer: setTimeout(() => finish(sessionId, turn, undefined), REPLY_TIMEOUT_MS),
      };
    });
    // 定时器不该单独拖住进程退出（测试与 DSH 宿主都受益）。
    (turn.timer as { unref?: () => void }).unref?.();
    const queue = pending.get(sessionId);
    if (queue === undefined) pending.set(sessionId, [turn]);
    else queue.push(turn);
    return { promise, turn };
  };

  /**
   * 把一条文本投进绑定会话，并等这一回合结束时的回复正文。
   *
   * @param petId - 发起对话的宠物 id（只用于日志；绑定是全局的）。
   * @param text - 已校验的正文。
   * @returns 回复正文；未绑定 / 服务缺失 / 投递失败 / 等超时一律 undefined（调用方回落）。
   */
  const chatInSession = async (petId: string, text: string): Promise<SessionPromptReply> => {
    // 每次重读：面板改绑 / 解绑后下一条消息就该走新状态，不能按进程缓存。
    const binding = readSessionBinding(configPaths);
    if (binding === null || !binding.enabled || binding.sessionId === '') return undefined;

    const controller = service('sessionController') as Partial<PromptController> | undefined;
    if (typeof controller?.prompt !== 'function') {
      log(`[dsh-xiaojing] 绑定会话不可用（缺少 sessionController）pet=${petId}`);
      return undefined;
    }

    const sessionId = binding.sessionId;
    // 先挂等待再投递：会话事件可能早于 prompt() 的 Promise 落定，后挂会漏掉这一回合的回复。
    const { promise: reply, turn } = waitForReply(sessionId);
    try {
      await controller.prompt(
        {
          sessionId,
          requestId: randomUUID(),
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
        AbortSignal.timeout(PROMPT_TIMEOUT_MS),
      );
    } catch (e) {
      log(`[dsh-xiaojing] 投递会话消息失败 pet=${petId} session=${sessionId}：${e instanceof Error ? e.message : String(e)}`);
      // 撤掉刚挂的等待：不撤的话它会空等到超时，还会被下一回合的 assistant 文本误认领。
      finish(sessionId, turn, undefined);
      return undefined;
    }
    return await reply;
  };

  /** assistant/message：只更新有待办会话里各等待的最新文本（观察器已过滤绑定会话）。 */
  const handleAssistant = (sessionId: string, text: string): void => {
    const queue = pending.get(sessionId);
    if (queue === undefined) return;
    for (const turn of queue) turn.text = text;
  };

  /** turn/end：有待办的会话在此收尾；没收到正文就交 undefined，别把空串当回复气泡。 */
  const handleTurnEnd = (sessionId: string): void => {
    const queue = pending.get(sessionId);
    if (queue === undefined) return;
    pending.delete(sessionId);
    for (const turn of queue) {
      finish(sessionId, turn, turn.text.trim() === '' ? undefined : { ok: true, text: turn.text });
    }
  };

  return { chatInSession, handleAssistant, handleTurnEnd };
}

/** 投递器产出（供装配层按需取用）。 */
export type SessionPrompt = ReturnType<typeof createSessionPrompt>;
