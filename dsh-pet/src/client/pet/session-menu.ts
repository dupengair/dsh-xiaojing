/**
 * 「DSH 会话」右键子菜单（网页端）：列会话、标出当前绑定，点击后改绑 / 解绑。
 *
 * 列表来自装配层注入的 sessions / workspaces 服务快照，打开菜单那一刻读一次。
 * 展示所有工作区的主会话（排除子代理），按工作区分组成嵌套子枝，滤掉归档。
 * 服务缺失时整枝不出现，不报错、不影响其它菜单项。
 * 分组 / 过滤 / 菜单构建的纯逻辑在 shared/session-list（与宿主路由、桌面 Helper 共用同一份），
 * 这里 re-export 保持既有引用不变，本文件只留网页端的状态与网络部分。
 * @module dsh-pet/src/client/pet/session-menu
 */
import { fetchSessionBinding, saveSessionBinding, type SessionBindingView } from '../chat/api.ts';
import type { SessionMenuPick, SessionRow, WorkspaceRow, WorkspaceSnapshotLike } from '../../shared/session-list.ts';

export {
  MAX_SESSION_ITEMS,
  UNBIND_LABEL,
  buildSessionMenu,
  groupSessionsByWorkspace,
  sessionTitle,
  workspaceBaseName,
  workspaceGroupLabel,
} from '../../shared/session-list.ts';
export type {
  SessionGroup,
  SessionMenu,
  SessionMenuPick,
  SessionRow,
  WorkspaceRow,
  WorkspaceSnapshotLike,
} from '../../shared/session-list.ts';

/** 会话列表形态：只要求 sessions 服务的 list 提供快照。 */
export interface SessionListLike {
  getSnapshot?: () => unknown;
}

/** 列表来源：装配层注入；返回 undefined 表示本端没有会话服务。 */
export type SessionListSource = () => SessionListLike | undefined | null;

/** 工作区列表形态：只要求 workspaces 服务的 list 提供快照。 */
export interface WorkspaceListLike {
  getSnapshot?: () => unknown;
}

/** 工作区列表来源：装配层注入；返回 undefined 表示本端没有工作区服务。 */
export type WorkspaceListSource = () => WorkspaceListLike | undefined | null;

/** 一次改绑 / 解绑的结果与要说的那句话。 */
export type SessionPickResult =
  | { readonly ok: true; readonly binding: SessionBindingView; readonly text: string }
  | { readonly ok: false; readonly text: string };

let source: SessionListSource | null = null;
let workspaceSource: WorkspaceListSource | null = null;
let cachedBinding: SessionBindingView | null = null;
let loading: Promise<void> | null = null;

/** 装配层注入会话列表来源；服务缺失时传 undefined 清掉。 */
export function setSessionListSource(next: SessionListSource | undefined): void {
  source = next ?? null;
}

/** 装配层注入工作区列表来源；服务缺失时传 undefined 清掉（归档滤除退化为启发式）。 */
export function setWorkspaceListSource(next: WorkspaceListSource | undefined): void {
  workspaceSource = next ?? null;
}

/** 从 sessions 快照里读出 {id,title,…分组字段}；形状不对按空列表处理（不抛错）。 */
export function sessionOptionsFromSnapshot(snapshot: unknown): SessionRow[] {
  if (!snapshot || typeof snapshot !== 'object') return [];
  const byId = (snapshot as { byId?: unknown }).byId;
  if (!byId || typeof byId !== 'object') return [];
  return Object.entries(byId as Record<string, unknown>).map(([id, row]) => {
    const r = (row ?? {}) as {
      title?: unknown;
      cwd?: unknown;
      updatedAt?: unknown;
      parentSessionId?: unknown;
      origin?: unknown;
      blank?: unknown;
      retainedBy?: { mainView?: unknown } | null;
    };
    const mainView = r.retainedBy?.mainView;
    return {
      id,
      title: typeof r.title === 'string' ? r.title : '',
      cwd: typeof r.cwd === 'string' && r.cwd !== '' ? r.cwd : undefined,
      updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : undefined,
      parentSessionId:
        typeof r.parentSessionId === 'string' && r.parentSessionId !== '' ? r.parentSessionId : undefined,
      origin: typeof r.origin === 'string' ? r.origin : undefined,
      blank: r.blank === true,
      mainView: typeof mainView === 'number' && mainView > 0,
    };
  });
}

/** 从 workspaces 快照里读出 {items,archivedSessionIds}；形状不对按「服务不可用」处理（返回 undefined）。 */
export function workspaceInfoFromSnapshot(snapshot: unknown): WorkspaceSnapshotLike | undefined {
  if (!snapshot || typeof snapshot !== 'object') return undefined;
  const rawItems = (snapshot as { items?: unknown }).items;
  if (!Array.isArray(rawItems)) return undefined;
  const items: WorkspaceRow[] = [];
  for (const one of rawItems) {
    if (!one || typeof one !== 'object') continue;
    const r = one as { workspaceId?: unknown; path?: unknown; title?: unknown; sessionIds?: unknown };
    if (typeof r.workspaceId !== 'string' || r.workspaceId === '') continue;
    if (!Array.isArray(r.sessionIds)) continue;
    items.push({
      workspaceId: r.workspaceId,
      path: typeof r.path === 'string' && r.path !== '' ? r.path : undefined,
      title: typeof r.title === 'string' ? r.title : '',
      sessionIds: r.sessionIds.filter((id): id is string => typeof id === 'string'),
    });
  }
  const rawArchived = (snapshot as { archivedSessionIds?: unknown }).archivedSessionIds;
  const archivedSessionIds = Array.isArray(rawArchived)
    ? rawArchived.filter((id): id is string => typeof id === 'string')
    : [];
  return { items, archivedSessionIds };
}

/**
 * 打开菜单那一刻读一次会话列表。
 *
 * @returns 会话行；没有注入来源、服务缺失或读取抛错时 undefined（子菜单整枝不出现）。
 */
export function readSessionOptions(): readonly SessionRow[] | undefined {
  if (source === null) return undefined;
  try {
    const list = source();
    if (!list || typeof list.getSnapshot !== 'function') return undefined;
    return sessionOptionsFromSnapshot(list.getSnapshot());
  } catch {
    return undefined;
  }
}

/**
 * 打开菜单那一刻顺带读一次工作区快照（归档名单 + 分组归属）。
 *
 * @returns 工作区投影；没注入来源、服务缺失、快照形状不对或读取抛错时 undefined（退化为启发式）。
 */
export function readWorkspaceInfo(): WorkspaceSnapshotLike | undefined {
  if (workspaceSource === null) return undefined;
  try {
    const list = workspaceSource();
    if (!list || typeof list.getSnapshot !== 'function') return undefined;
    return workspaceInfoFromSnapshot(list.getSnapshot());
  } catch {
    return undefined;
  }
}

/** 当前缓存的绑定（null = 还没读到 / 请求失败，按未绑定渲染）。 */
export function getCachedBinding(): SessionBindingView | null {
  return cachedBinding;
}

/** 把一次读 / 写的结果写回缓存。 */
export function setCachedBinding(binding: SessionBindingView | null): void {
  cachedBinding = binding;
}

/**
 * 拉一次会话绑定写进缓存；并发调用合并成一次请求，失败保留旧值。
 * 卡片挂载时调一次、每次打开菜单再顺带刷新，菜单本身不等网络。
 */
export function ensureSessionBindingLoaded(): Promise<void> {
  if (loading !== null) return loading;
  loading = fetchSessionBinding()
    .then((binding) => {
      cachedBinding = binding;
    })
    .catch(() => {
      // 读不到就按未绑定渲染，下次打开再试；不能因为读绑定失败连菜单都不弹。
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** 绑定关系里的会话 id：只有 enabled 且非空才算绑定，其余返回空串。 */
export function boundSessionId(binding: SessionBindingView | null): string {
  if (binding === null || !binding.enabled) return '';
  return binding.sessionId.trim();
}

/**
 * 点一项：改绑或解绑，成功后把结果写回缓存。
 *
 * @param pick - 点击目标。
 * @returns 成功时带落盘后的绑定与要说的那句话；失败时说「绑定失败啦」。
 */
export async function applySessionPick(pick: SessionMenuPick): Promise<SessionPickResult> {
  const binding: SessionBindingView =
    pick.sessionId === '' ? { sessionId: '', enabled: false } : { sessionId: pick.sessionId, enabled: true };
  try {
    const result = await saveSessionBinding(binding);
    if (!result.ok) return { ok: false, text: '绑定失败啦' };
    setCachedBinding(result.binding);
    return {
      ok: true,
      binding: result.binding,
      text: pick.sessionId === '' ? '解绑了' : '绑定到「' + pick.title + '」啦',
    };
  } catch {
    return { ok: false, text: '绑定失败啦' };
  }
}
