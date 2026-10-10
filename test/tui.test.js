import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visWidth, padTo, wrapLine } from '../src/tui.js';

test('visWidth: ASCII 宽度=1', () => {
  assert.equal(visWidth('hello'), 5);
  assert.equal(visWidth(''), 0);
});

test('visWidth: CJK 双宽=2', () => {
  assert.equal(visWidth('中'), 2);
  assert.equal(visWidth('中文'), 4);
  assert.equal(visWidth('中文 hello'), 4 + 1 + 5);
});

test('visWidth: emoji 双宽=2', () => {
  assert.equal(visWidth('🎉'), 2);
});

test('padTo: 补空格到指定宽度', () => {
  assert.equal(padTo('hi', 6), 'hi    ');
  assert.equal(padTo('中文', 6), '中文  ');
  assert.equal(padTo('hello', 3), 'hello');  // 已超长不截
});

test('wrapLine: 按显示宽度折行', () => {
  assert.deepEqual(wrapLine('hello', 10), ['hello']);
  assert.deepEqual(wrapLine('hello world', 5), ['hello', ' worl', 'd']);
});

test('wrapLine: CJK 双宽折行 — 不能把双宽字符切成两半', () => {
  // "中文中文中文" 各 2 列 = 12 列，宽 6 → 6/6
  assert.deepEqual(wrapLine('中文中文中文', 6), ['中文中', '文中文']);
  // 宽度 4：装"a"+"中"(共 3 列) → 加"文"(w+2=5>4) push 'a中'，cur='文'
  assert.deepEqual(wrapLine('a中文', 4), ['a中', '文']);
  // 严格边界：宽 6 装"中文中"刚好，再多就溢出
  assert.deepEqual(wrapLine('中文中文', 6), ['中文中', '文']);
});

test('wrapLine: 宽度<=0 返回 [""]', () => {
  assert.deepEqual(wrapLine('abc', 0), ['']);
  assert.deepEqual(wrapLine('abc', -5), ['']);
});