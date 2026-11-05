/**
 * JSONC 定点改写 + 会话绑定写盘的单元测试。
 *
 * 钉住的不变式：
 *   - 改一个键之后，文件里手写的 // 与 /* *\/ 注释、缩进、键顺序必须原样还在；
 *   - 键不存在时追加到根对象末尾，同样不动其它内容；
 *   - 结构可疑（根不是对象、括号不闭合）时抛错，不允许「猜着写」；
 *   - 没有用户层文件时写一份最小结构。
 *
 * 跑法：node --experimental-strip-types src/host/config/session-binding.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setJsoncTopLevelValue } from './jsonc-edit.ts';
import { readSessionBinding, writeSessionBinding } from './session-binding.ts';
import type { ConfigPaths } from './constants.ts';

/** 造一组临时 ConfigPaths（只用到 userFile）。 */
function tempPaths(): { paths: ConfigPaths; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-binding-'));
  return {
    paths: { userFile: join(dir, 'main-config.jsonc') } as unknown as ConfigPaths,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const BOUND = { sessionId: 'session-11b7077b-9c5a-4f53-9fa7-ce981255043d', enabled: true };

describe('setJsoncTopLevelValue —— 只动那一段字符', () => {
  test('已有键：注释、缩进、键顺序全部保留', () => {
    const src = [
      '// 桌宠主配置',
      '{',
      '  // 宠物列表（每只一个对象）',
      '  "pets": [{ "id": "main" }],',
      '  "sessionBinding": { "sessionId": "", "enabled": false },',
      '  /* 结尾注释 */',
      '  "voiceEnabled": true',
      '}',
      '',
    ].join('\n');
    const out = setJsoncTopLevelValue(src, 'sessionBinding', BOUND);
    assert.match(out, /\/\/ 桌宠主配置/u);
    assert.match(out, /\/\/ 宠物列表（每只一个对象）/u);
    assert.match(out, /\/\* 结尾注释 \*\//u);
    assert.match(out, /"sessionBinding": \{\n {4}"sessionId": "session-11b7077b/u);
    assert.match(out, /"voiceEnabled": true/u);
    // 键顺序不变：pets 仍在 sessionBinding 之前
    assert.ok(out.indexOf('"pets"') < out.indexOf('"sessionBinding"'));
    const parsed = JSON.parse(out.replace(/\/\/[^\n]*/gu, '').replace(/\/\*[\s\S]*?\*\//gu, '')) as Record<
      string,
      unknown
    >;
    assert.deepEqual(parsed.sessionBinding, BOUND);
    assert.deepEqual(parsed.pets, [{ id: 'main' }]);
  });

  test('键不存在：追加到末尾，带前置逗号，原注释仍在', () => {
    const src = ['{', '  // 只有这些', '  "voiceEnabled": true', '}', ''].join('\n');
    const out = setJsoncTopLevelValue(src, 'sessionBinding', BOUND);
    assert.match(out, /\/\/ 只有这些/u);
    assert.match(out, /"voiceEnabled": true,\n {2}"sessionBinding": \{/u);
    assert.match(out, /\}\n\}[\s\n]*$/u);
  });

  test('空对象：追加时不多出逗号', () => {
    const out = setJsoncTopLevelValue('{}', 'sessionBinding', BOUND);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    assert.deepEqual(parsed, { sessionBinding: BOUND });
    assert.equal(out.includes(',}'), false);
  });

  test('值里带 // 与花括号字符串：不误判注释、不误判结构', () => {
    const src = [
      '{',
      '  "note": "a // b { c }",',
      '  "sessionBinding": { "sessionId": "x", "enabled": false }',
      '}',
      '',
    ].join('\n');
    const out = setJsoncTopLevelValue(src, 'sessionBinding', BOUND);
    assert.match(out, /"note": "a \/\/ b \{ c \}"/u);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    assert.equal(parsed.note, 'a // b { c }');
    assert.deepEqual(parsed.sessionBinding, BOUND);
  });

  test('根不是对象：抛错（不猜着写）', () => {
    assert.throws(() => setJsoncTopLevelValue('[]', 'sessionBinding', BOUND), /not an object/u);
  });
});

describe('writeSessionBinding —— 写盘后读回一致', () => {
  test('带注释的用户配置：写绑定后仍是带注释的 JSONC，且能读回新值', () => {
    const { paths, cleanup } = tempPaths();
    try {
      writeFileSync(
        paths.userFile,
        [
          '// 用户手写',
          '{',
          '  // 尺寸',
          '  "size": 450,',
          '  "sessionBinding": { "sessionId": "", "enabled": false }',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
      writeSessionBinding(paths, BOUND);
      const text = readFileSync(paths.userFile, 'utf8');
      assert.match(text, /\/\/ 用户手写/u);
      assert.match(text, /\/\/ 尺寸/u);
      assert.deepEqual(readSessionBinding(paths), BOUND);
    } finally {
      cleanup();
    }
  });

  test('没有用户层文件：新建最小结构并可读回', () => {
    const { paths, cleanup } = tempPaths();
    try {
      assert.equal(existsSync(paths.userFile), false);
      writeSessionBinding(paths, BOUND);
      assert.deepEqual(readSessionBinding(paths), BOUND);
    } finally {
      cleanup();
    }
  });

  test('解绑：写空 id 后读回是未绑定', () => {
    const { paths, cleanup } = tempPaths();
    try {
      writeSessionBinding(paths, BOUND);
      writeSessionBinding(paths, { sessionId: '', enabled: false });
      assert.equal(readSessionBinding(paths), null);
    } finally {
      cleanup();
    }
  });
});
