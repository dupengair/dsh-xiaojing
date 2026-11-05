/**
 * 「DSH 会话」列表的共用纯函数：分组、可见性过滤与菜单枝构建。
 *
 * 网页端（src/client/pet/session-menu.ts）与桌面 Helper 的宿主路由（src/host/routes/session.ts）
 * 共用这一份，避免两端各自维护一套过滤规则后漂移。
 * 只做纯计算：不带状态、不发请求、不碰 DOM；数据形态对齐 sessions / workspaces 客户端服务的快照投影。
 * @module dsh-pet/src/shared/session-list
 */
import type { MenuBranch, MenuLeaf, MenuNode } from './menu/types.ts';

/** 最多列出的会话条数（全工作区合计，不含第一项「不绑定」）。 */
export const MAX_SESSION_ITEMS = 30;

/** 「不绑定」那一项的文案。 */
export const UNBIND_LABEL = '不绑定（解除）';

/** 不属于任何工作区的会话所在分组的名字（与官方侧栏「未分组」一致）。 */
export const UNGROUPED_LABEL = '未分组';

/** dsh-workspace 里表示「默认工作区」的魔数标题；官方 UI 把它翻译成本地化名称。 */
export const DEFAULT_WORKSPACE_TITLE = 'default-workspace';

/** 默认工作区在菜单里显示的名字（官方 zh 字典里 workspace.defaultName 的值）。 */
export const DEFAULT_WORKSPACE_LABEL = '默认工作区';

/** 会话条目的最小形状（网页端 SessionOption 的结构子集，桌面端不依赖 client 类型）。 */
export interface SessionLike {
  readonly id: string;
  readonly title: string;
}

/**
 * 会话行：快照/路由多读出来的分组字段（{@link SessionLike} 的超集）。
 * DSH 官方侧栏同样从 sessions 快照读这些字段按工作区分组
 * （app.asar 内 dsh-client-ui-workspace/lib/client.js：retainedBy.mainView、cwd、updatedAt）。
 */
export interface SessionRow extends SessionLike {
  /** 会话工作目录；冷会话都有，热会话可能缺。 */
  readonly cwd?: string;
  /** 最近活跃时间（毫秒），组内排序与分组排序用它。 */
  readonly updatedAt?: number;
  /** 非空 = 子代理 / 派生会话，菜单里不列。 */
  readonly parentSessionId?: string;
  /** 官方 origin 标记：'subagent' = 子代理派生会话，侧栏不列。 */
  readonly origin?: string;
  /** 未命名占位会话（官方 blank）：只有正被主视图持有的那个才可见。 */
  readonly blank?: boolean;
  /** 该会话当前被主视图持有（官方 retainedBy.mainView > 0），blank 会话只放行这一个。 */
  readonly mainView?: boolean;
}

/** 一个工作区的投影（dsh-workspace 领域记录 / registry 实体的子集）。 */
export interface WorkspaceRow {
  /** 工作区身份键。 */
  readonly workspaceId: string;
  /** 工作区目录的绝对路径（规范化）；与 sessionIds 互补做会话归属兜底。 */
  readonly path?: string;
  /** 用户可改的显示名；空或 'default-workspace' 时回落到 path 末段。 */
  readonly title: string;
  /** 记账在该工作区下的会话 id（权威归属，官方侧栏按它分组）。 */
  readonly sessionIds: readonly string[];
}

/** 工作区投影：分组要用的两个部分。 */
export interface WorkspaceSnapshotLike {
  /** 工作区列表（顺序即官方显示顺序）。 */
  readonly items: readonly WorkspaceRow[];
  /** 全局归档会话 id 集合；在里面的会话菜单里不列。 */
  readonly archivedSessionIds: readonly string[];
}

/** 按工作区分好组的会话：一组 = 菜单里一根嵌套子枝。 */
export interface SessionGroup {
  /** 分组名：工作区显示名（或「未分组」）。 */
  readonly label: string;
  /** 组内会话，updatedAt 降序。 */
  readonly rows: readonly SessionRow[];
}

/** 菜单点击目标：会话 id 空串 = 解绑。 */
export interface SessionMenuPick {
  /** 目标会话 id；空串表示解绑。 */
  readonly sessionId: string;
  /** 菜单上显示的标题（空标题时已回落为 id 前 8 位）。 */
  readonly title: string;
}

/** 构建结果：菜单枝 + 叶子到点击目标的对应表（按对象身份，挂载层传回原叶子）。 */
export interface SessionMenu {
  readonly branch: MenuBranch;
  readonly picks: ReadonlyMap<MenuLeaf, SessionMenuPick>;
}

/** 会话标题：空标题回落成 id 前 8 位（先去掉 `session-` 前缀，免得只显示出一个前缀）。 */
export function sessionTitle(one: SessionLike): string {
  const title = typeof one.title === 'string' ? one.title.trim() : '';
  if (title !== '') return title;
  const bare = one.id.replace(/^session-/u, '');
  return bare.slice(0, 8);
}

/**
 * 目录路径的显示末段（与官方 workspaceTitleOf 同一算法）：
 * 去掉尾部斜杠后取最后一个 `/` 或 `\` 之后的部分；整个路径都是分隔符时原样返回。
 * `D:\Work\DSH\DSH使用` → `DSH使用`；`/` → `/`。
 */
export function workspaceBaseName(cwd: string): string {
  const trimmed = cwd.replace(/[/\\]+$/, '');
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const base = trimmed.slice(separator + 1);
  return base !== '' ? base : cwd;
}

/**
 * 工作区分组名：优先用户改过的 title；空标题或 'default-workspace' 魔数回落
 * path 末段（官方 workspaceDisplayTitle + workspaceLabel 同一套兜底）；path 也缺 → 未分组。
 */
export function workspaceGroupLabel(workspace: WorkspaceRow): string {
  const title = workspace.title.trim();
  if (title !== '' && title !== DEFAULT_WORKSPACE_TITLE) return title;
  if (title === DEFAULT_WORKSPACE_TITLE) return DEFAULT_WORKSPACE_LABEL;
  return workspace.path !== undefined ? workspaceBaseName(workspace.path) : UNGROUPED_LABEL;
}

/** 组内排序：updatedAt 降序（缺 updatedAt 视为 0），并列时按 id 稳定。 */
function sortRowsDesc(rows: SessionRow[]): SessionRow[] {
  return rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * 把会话行按工作区分组（纯函数，网页端与宿主路由共用）。
 *
 * 可见规则照抄官方侧栏 sessionVisible（app.asar dsh-client-ui-workspace/lib/client.js）：
 * ① 排除子代理 / 派生会话（origin === 'subagent' 或带 parentSessionId）；
 * ② blank（未命名占位）会话只有正被主视图持有（retainedBy.mainView > 0）的那个可见；
 * ③ workspaces 可用时按 archivedSessionIds 滤掉归档（官方默认 archivedFilter 行为）。
 * workspaces 为 undefined/null 时退化为启发式：① ② 照做，再滤掉无 cwd 的行（冷会话都有 cwd，
 * 无 cwd 的非子会话多半是归档 / 删除残留），代价是刚建立、还没落 cwd 的热会话可能漏列一轮。
 *
 * 归属：可用时只认 sessionIds 记账（官方权威，与官方 groupByWorkspace 一致），
 * 不做 cwd 匹配兜底——没记上的一律进「未分组」，避免把残留按 cwd 捞进工作区组。
 * 不可用时才按 cwd 末段分组。
 * 组序：按组内最新 updatedAt 降序（活跃工作区靠前），「未分组」永远垫底。
 *
 * @param rows - 全部会话行。
 * @param workspaces - 工作区投影；undefined/null 表示不可用（走启发式）。
 */
export function groupSessionsByWorkspace(
  rows: readonly SessionRow[],
  workspaces?: WorkspaceSnapshotLike | null,
): SessionGroup[] {
  const hasService = workspaces !== undefined && workspaces !== null;
  const archived = new Set<string>(hasService ? workspaces.archivedSessionIds : []);
  const visible = rows.filter((row) => {
    if (row.parentSessionId !== undefined) return false;
    if (row.origin === 'subagent') return false;
    if (row.blank === true && row.mainView !== true) return false;
    if (archived.has(row.id)) return false;
    if (!hasService && row.cwd === undefined) return false;
    return true;
  });
  if (visible.length === 0) return [];

  const byId = new Map<string, SessionRow>(visible.map((row) => [row.id, row]));
  const grouped = new Set<string>();
  const groups: SessionGroup[] = [];

  const takeInto = (label: string, members: SessionRow[]): void => {
    for (const row of members) grouped.add(row.id);
    groups.push({ label, rows: sortRowsDesc(members) });
  };

  if (hasService) {
    for (const workspace of workspaces.items) {
      // 只认 sessionIds 记账（官方 groupByWorkspace 同法）；空组不生成枝。
      const members: SessionRow[] = [];
      for (const id of workspace.sessionIds) {
        const row = byId.get(id);
        if (row === undefined) continue;
        grouped.add(id);
        members.push(row);
      }
      if (members.length > 0) takeInto(workspaceGroupLabel(workspace), members);
    }
  } else {
    const byCwd = new Map<string, SessionRow[]>();
    for (const row of visible) {
      const list = byCwd.get(row.cwd as string);
      if (list === undefined) byCwd.set(row.cwd as string, [row]);
      else list.push(row);
    }
    for (const [cwd, members] of byCwd) takeInto(workspaceBaseName(cwd), members);
  }

  const stray = visible.filter((row) => !grouped.has(row.id));
  const named = groups;
  // 组序：有名组按组内最新 updatedAt 降序（活跃优先）；「未分组」不参与排序、永远垫底。
  named.sort((a, b) => {
    const newest = (group: SessionGroup): number =>
      group.rows.reduce((max, row) => Math.max(max, row.updatedAt ?? 0), 0);
    return newest(b) - newest(a);
  });
  if (stray.length > 0) named.push({ label: UNGROUPED_LABEL, rows: sortRowsDesc(stray) });
  return named;
}

/**
 * 构建「DSH 会话」子菜单枝：按工作区分组成嵌套子枝（挂载层 mountContextMenu 递归支持任意层级）。
 * 全部会话都在一个组里时省掉那层只有一个口的子枝，直接平铺。
 * 条目总数截断到 MAX_SESSION_ITEMS（组序在前者优先，最后一组截尾巴）。
 *
 * @param sessions - 会话行；undefined = 会话数据不可用（返回 null，整枝不出现）。
 * @param current - 当前绑定的会话 id；空串 = 未绑定。
 * @param workspaces - 工作区投影；undefined = 不可用（归档滤除走启发式）。
 * @returns 菜单枝与点击目标；没有任何项时 null。
 */
export function buildSessionMenu(
  sessions: readonly SessionRow[] | undefined,
  current: string,
  workspaces?: WorkspaceSnapshotLike | null,
): SessionMenu | null {
  if (sessions === undefined) return null;
  const bound = current.trim();
  const groups = groupSessionsByWorkspace(sessions, workspaces);
  // 过滤后没有任何可绑会话、也没绑定时没有可点的东西：整枝不出现，免得留一个空壳子菜单。
  if (groups.length === 0 && bound === '') return null;

  const picks = new Map<MenuLeaf, SessionMenuPick>();
  const children: MenuNode[] = [];
  const unbind: MenuLeaf = { label: UNBIND_LABEL, sessionId: '' };
  picks.set(unbind, { sessionId: '', title: '' });
  children.push(unbind);

  const leafOf = (one: SessionRow): MenuLeaf => {
    const title = sessionTitle(one);
    // ✓ 只标在已绑定的那项后面；同一 id 在列表里只可能出现一次。
    // sessionId 挂在叶子上：点击按它分发，菜单树被重建后旧叶子仍然可点。
    const leaf: MenuLeaf = { label: one.id === bound ? title + ' ✓' : title, sessionId: one.id };
    picks.set(leaf, { sessionId: one.id, title });
    return leaf;
  };

  // 全局截断：按组序依次装满 MAX_SESSION_ITEMS，最后一组截尾巴，装满后的组整个丢弃。
  const filled: { group: SessionGroup; slice: SessionRow[] }[] = [];
  let used = 0;
  for (const group of groups) {
    if (used >= MAX_SESSION_ITEMS) break;
    const slice = group.rows.slice(0, MAX_SESSION_ITEMS - used);
    used += slice.length;
    filled.push({ group, slice });
  }

  if (filled.length === 1 && filled[0] !== undefined) {
    for (const one of filled[0].slice) children.push(leafOf(one));
  } else {
    for (const { group, slice } of filled) {
      children.push({ label: group.label, children: slice.map(leafOf) });
    }
  }
  return { branch: { label: 'DSH 会话', children }, picks };
}

