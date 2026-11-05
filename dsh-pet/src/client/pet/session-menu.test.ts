/**
 * 「DSH 会话」右键子菜单（src/client/pet/session-menu.ts）的契约测试。
 *
 * 契约：有绑定时对应项打勾；会话服务不可用时整枝不出现；跨工作区分组标注；
 * 子会话 / 归档会话滤除（服务可用 / 不可用两态）；cwd 缺失兜底；列表全局截断。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_SESSION_ITEMS,
  buildSessionMenu,
  groupSessionsByWorkspace,
  sessionOptionsFromSnapshot,
  sessionTitle,
  workspaceBaseName,
  workspaceGroupLabel,
  workspaceInfoFromSnapshot,
  type SessionRow,
  type WorkspaceRow,
} from './session-menu.ts';

/** 取菜单里各项的文案（子项可能是叶子或子枝）。 */
function labels(menu: NonNullable<ReturnType<typeof buildSessionMenu>>): string[] {
  return menu.branch.children.map((child) => child.label);
}

/** 一个最小工作区行。 */
function ws(row: Partial<WorkspaceRow> & { workspaceId: string }): WorkspaceRow {
  return { path: undefined, title: '', sessionIds: [], ...row };
}

describe('buildSessionMenu —— DSH 会话子菜单', () => {
  test('有绑定时对应项打勾', () => {
    const menu = buildSessionMenu(
      [
        { id: 's1', title: '写代码', cwd: 'D:/w' },
        { id: 's2', title: '改方案', cwd: 'D:/w' },
      ],
      's2',
    );
    assert.ok(menu);
    assert.equal(menu.branch.label, 'DSH 会话');
    // 只有一个分组（都无 cwd → 未分组）时平铺，不加多余的子枝。
    assert.deepEqual(labels(menu), ['不绑定（解除）', '写代码', '改方案 ✓']);
    // 打勾只标一项；点击目标按会话 id 对上。
    assert.deepEqual(
      [...menu.picks.values()].map((pick) => pick.sessionId),
      ['', 's1', 's2'],
    );
  });

  test('无会话服务时不出现', () => {
    assert.equal(buildSessionMenu(undefined, 's1'), null);
    assert.equal(buildSessionMenu(undefined, ''), null);
  });

  test('全局最多列 30 条，「不绑定」始终第一项', () => {
    const sessions = Array.from({ length: MAX_SESSION_ITEMS + 3 }, (_, index) => ({
      id: 's' + index,
      title: '会话' + index,
      cwd: 'D:/w',
      updatedAt: MAX_SESSION_ITEMS + 3 - index, // 越小越旧：截断应从最旧的尾巴截起
    }));
    const menu = buildSessionMenu(sessions, '');
    assert.ok(menu);
    // 同一 cwd → 一个分组平铺：总数封顶。
    assert.equal(menu.branch.children.length, MAX_SESSION_ITEMS + 1);
    assert.equal(labels(menu)[0], '不绑定（解除）');
    assert.equal(labels(menu)[1], '会话0');
    assert.equal(labels(menu)[MAX_SESSION_ITEMS], '会话' + (MAX_SESSION_ITEMS - 1));
  });

  test('多工作区时按工作区嵌套子枝，组内 updatedAt 降序、组间活跃优先', () => {
    const rows: SessionRow[] = [
      { id: 'a1', title: '鱼塘旧', cwd: 'D:/fish', updatedAt: 1 },
      { id: 'a2', title: '鱼塘新', cwd: 'D:/fish', updatedAt: 9 },
      { id: 'b1', title: '家务', cwd: 'D:/home', updatedAt: 5 },
    ];
    const menu = buildSessionMenu(rows, 'b1', {
      items: [
        ws({ workspaceId: 'w1', title: '大肥鱼', path: 'D:/fish', sessionIds: ['a1', 'a2'] }),
        ws({ workspaceId: 'w2', title: '家务区', path: 'D:/home', sessionIds: ['b1'] }),
      ],
      archivedSessionIds: [],
    });
    assert.ok(menu);
    assert.deepEqual(labels(menu), ['不绑定（解除）', '大肥鱼', '家务区']);
    const branch = menu.branch.children[1];
    assert.ok('children' in branch);
    assert.deepEqual(
      branch.children.map((child) => child.label),
      ['鱼塘新', '鱼塘旧'],
    );
    // 打勾落在嵌套叶子身上，点击目标表仍按对象身份对上。
    const homeBranch = menu.branch.children[2];
    assert.ok('children' in homeBranch);
    assert.deepEqual(
      homeBranch.children.map((child) => child.label),
      ['家务 ✓'],
    );
  });

  test('空标题回落成 id 前 8 位', () => {
    assert.equal(sessionTitle({ id: 'abcdefghijk', title: '' }), 'abcdefgh');
    assert.equal(sessionTitle({ id: 'abcdefghijk', title: '  ' }), 'abcdefgh');
    assert.equal(sessionTitle({ id: 'x', title: '有标题' }), '有标题');
  });

  test('没有会话也没有绑定 → 整枝不出现；有绑定但列表空 → 只留「不绑定」', () => {
    assert.equal(buildSessionMenu([], ''), null);
    const menu = buildSessionMenu([], 'gone');
    assert.ok(menu);
    assert.deepEqual(labels(menu), ['不绑定（解除）']);
  });

  test('快照形状不对时按空列表处理', () => {
    assert.deepEqual(sessionOptionsFromSnapshot(null), []);
    assert.deepEqual(sessionOptionsFromSnapshot({ byId: 'bad' }), []);
    // 快照行顺带读出分组字段（cwd / updatedAt / parentSessionId / origin / blank / mainView）。
    assert.deepEqual(sessionOptionsFromSnapshot({ byId: { a: { title: '标题' }, b: null } }), [
      { id: 'a', title: '标题', cwd: undefined, updatedAt: undefined, parentSessionId: undefined, origin: undefined, blank: false, mainView: false },
      { id: 'b', title: '', cwd: undefined, updatedAt: undefined, parentSessionId: undefined, origin: undefined, blank: false, mainView: false },
    ]);
    assert.deepEqual(
      sessionOptionsFromSnapshot({
        byId: {
          m: { title: '主', cwd: 'D:/w', updatedAt: 5, origin: 'subagent', blank: true, retainedBy: { mainView: 2 } },
          sub: { title: '子', cwd: 'D:/w', parentSessionId: 'm', blank: true, retainedBy: {} },
        },
      }),
      [
        { id: 'm', title: '主', cwd: 'D:/w', updatedAt: 5, parentSessionId: undefined, origin: 'subagent', blank: true, mainView: true },
        { id: 'sub', title: '子', cwd: 'D:/w', updatedAt: undefined, parentSessionId: 'm', origin: undefined, blank: true, mainView: false },
      ],
    );
  });
});

describe('workspaceInfoFromSnapshot —— workspaces 快照投影', () => {
  test('读出 items 与归档名单；字段形状不对的行跳过', () => {
    assert.deepEqual(
      workspaceInfoFromSnapshot({
        items: [
          { workspaceId: 'w1', title: '大肥鱼', path: 'D:/fish', sessionIds: ['a', 'b'] },
          { workspaceId: '', title: '坏行', sessionIds: [] },
          'junk',
          { workspaceId: 'w2', path: 'D:/home', sessionIds: [1, 'c'] },
        ],
        archivedSessionIds: ['b', 42],
      }),
      {
        items: [
          { workspaceId: 'w1', title: '大肥鱼', path: 'D:/fish', sessionIds: ['a', 'b'] },
          { workspaceId: 'w2', title: '', path: 'D:/home', sessionIds: ['c'] },
        ],
        archivedSessionIds: ['b'],
      },
    );
  });

  test('形状不对（null / 缺 items）→ undefined（视为服务不可用）', () => {
    assert.equal(workspaceInfoFromSnapshot(null), undefined);
    assert.equal(workspaceInfoFromSnapshot({}), undefined);
    assert.equal(workspaceInfoFromSnapshot({ items: 'bad' }), undefined);
  });
});

describe('workspaceGroupLabel / workspaceBaseName —— 分组名取法', () => {
  test('用户改过的名字优先', () => {
    assert.equal(workspaceGroupLabel(ws({ workspaceId: 'w', title: '大肥鱼', path: 'D:/fish' })), '大肥鱼');
  });

  test('空标题回落 path 末段；default-workspace 魔数译成「默认工作区」', () => {
    assert.equal(workspaceGroupLabel(ws({ workspaceId: 'w', title: '', path: 'D:\\Work\\DSH\\DSH使用' })), 'DSH使用');
    assert.equal(workspaceGroupLabel(ws({ workspaceId: 'w', title: 'default-workspace', path: 'D:/x' })), '默认工作区');
    assert.equal(workspaceGroupLabel(ws({ workspaceId: 'w' })), '未分组');
  });

  test('末段算法兼容两种分隔符与尾部斜杠', () => {
    assert.equal(workspaceBaseName('D:\\Work\\DSH\\DSH使用'), 'DSH使用');
    assert.equal(workspaceBaseName('/home/user/proj/'), 'proj');
    assert.equal(workspaceBaseName('C:/'), 'C:');
  });
});

describe('groupSessionsByWorkspace —— 全工作区分组', () => {
  test('workspaces 服务可用：按 sessionIds 归组，归档滤除，未记账（含 cwd 同目录）进「未分组」', () => {
    const rows: SessionRow[] = [
      { id: 'a', title: '鱼塘', cwd: 'D:/fish', updatedAt: 3 },
      { id: 'b', title: '家务', cwd: 'D:/home', updatedAt: 9 },
      { id: 'c', title: '没记账但同目录', cwd: 'D:/fish', updatedAt: 1 },
      { id: 'd', title: '孤儿', cwd: 'D:/nowhere', updatedAt: 2 },
      { id: 'dead', title: '归档残留', cwd: 'D:/home', updatedAt: 8 },
      { id: 'sub', title: '子代理', cwd: 'D:/home', parentSessionId: 'a' },
    ];
    const groups = groupSessionsByWorkspace(rows, {
      items: [
        ws({ workspaceId: 'w1', title: '大肥鱼', path: 'D:/fish', sessionIds: ['a'] }),
        ws({ workspaceId: 'w2', title: '', path: 'D:/home', sessionIds: ['b', 'dead'] }),
      ],
      archivedSessionIds: ['dead'],
    });
    assert.deepEqual(
      groups.map((g) => ({ label: g.label, ids: g.rows.map((r) => r.id) })),
      [
        // b（updatedAt 9）最活跃 → home 组在前；c 没记账，即使 cwd==path 也不进大肥鱼组，
        // 与官方侧栏一致（残留按 cwd 捞进组正是上一版混入归档残留的原因）。
        { label: 'home', ids: ['b'] },
        { label: '大肥鱼', ids: ['a'] },
        { label: '未分组', ids: ['d', 'c'] },
      ],
    );
  });

  test('官方可见规则：origin=subagent 滤除；blank 只放行 mainView 持有的那个', () => {
    const rows: SessionRow[] = [
      { id: 'main', title: '主', cwd: 'D:/w', updatedAt: 5 },
      { id: 'bot', title: '子代理', cwd: 'D:/w', origin: 'subagent', updatedAt: 9 },
      { id: 'newBlank', title: '', cwd: 'D:/w', blank: true, updatedAt: 8 },
      { id: 'heldBlank', title: '', cwd: 'D:/w', blank: true, mainView: true, updatedAt: 7 },
    ];
    const groups = groupSessionsByWorkspace(rows, { items: [], archivedSessionIds: [] });
    // 无记账 → 全部可见的进「未分组」；bot 与 newBlank 被滤。
    assert.deepEqual(groups[0]?.rows.map((r) => r.id), ['heldBlank', 'main']);
    // 服务不可用的启发式分支同样滤 blank / subagent。
    assert.deepEqual(
      groupSessionsByWorkspace(rows, undefined)[0]?.rows.map((r) => r.id),
      ['heldBlank', 'main'],
    );
  });

  test('组间按最新 updatedAt 降序，「未分组」永远最后', () => {
    const rows: SessionRow[] = [
      { id: 'old', title: '旧组', cwd: 'D:/old', updatedAt: 1 },
      { id: 'hot', title: '热组', cwd: 'D:/hot', updatedAt: 99 },
      { id: 'stray', title: '孤儿', cwd: 'D:/x', updatedAt: 50 },
    ];
    const groups = groupSessionsByWorkspace(rows, {
      items: [
        ws({ workspaceId: 'w1', title: '旧区', path: 'D:/old', sessionIds: ['old'] }),
        ws({ workspaceId: 'w2', title: '热区', path: 'D:/hot', sessionIds: ['hot'] }),
      ],
      archivedSessionIds: [],
    });
    assert.deepEqual(
      groups.map((g) => g.label),
      ['热区', '旧区', '未分组'],
    );
  });

  test('服务不可用：归档滤除退化为「无 cwd 的非子会话不列」启发式，按 cwd 末段分组', () => {
    const rows: SessionRow[] = [
      { id: 'a', title: 'A', cwd: 'D:/fish', updatedAt: 1 },
      { id: 'residue', title: '疑似残留' },
      { id: 'sub', title: '子', cwd: 'D:/fish', parentSessionId: 'a' },
    ];
    const groups = groupSessionsByWorkspace(rows, undefined);
    assert.deepEqual(
      groups.map((g) => ({ label: g.label, ids: g.rows.map((r) => r.id) })),
      [{ label: 'fish', ids: ['a'] }],
    );
  });

  test('服务可用时不丢热会话：无 cwd 但已记账的照列（进对应组）', () => {
    const rows: SessionRow[] = [{ id: 'hot', title: '热会话' }];
    const groups = groupSessionsByWorkspace(rows, {
      items: [ws({ workspaceId: 'w', title: '大肥鱼', path: 'D:/fish', sessionIds: ['hot'] })],
      archivedSessionIds: [],
    });
    assert.deepEqual(
      groups.map((g) => ({ label: g.label, ids: g.rows.map((r) => r.id) })),
      [{ label: '大肥鱼', ids: ['hot'] }],
    );
  });

  test('子代理 / 派生会话一律滤除（服务可用与否都一样）', () => {
    const rows: SessionRow[] = [
      { id: 'a', title: 'A', cwd: 'D:/w' },
      { id: 's1', title: '子1', cwd: 'D:/w', parentSessionId: 'a' },
    ];
    assert.deepEqual(groupSessionsByWorkspace(rows)[0]?.rows.map((r) => r.id), ['a']);
    assert.deepEqual(
      groupSessionsByWorkspace(rows, { items: [], archivedSessionIds: [] })[0]?.rows.map((r) => r.id),
      ['a'],
    );
  });

  test('全部被归档 / 滤除 → 空分组列表（沿用空菜单契约）', () => {
    const rows: SessionRow[] = [
      { id: 'a', title: 'A', cwd: 'D:/w' },
      { id: 's', title: '子', parentSessionId: 'a' },
    ];
    assert.deepEqual(
      groupSessionsByWorkspace(rows, { items: [], archivedSessionIds: ['a'] }),
      [],
    );
    assert.equal(buildSessionMenu(rows, '', { items: [], archivedSessionIds: ['a'] }), null);
  });
});
