import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseDuration,
  parseWindow,
  inWindow,
  loadConfig,
} from '../src/config.js';

test('parseDuration: 数字单位', () => {
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('10m'), 600_000);
  assert.equal(parseDuration('1h'), 3_600_000);
  assert.equal(parseDuration('24h'), 86_400_000);
  assert.equal(parseDuration('2d'), 172_800_000);
  assert.equal(parseDuration('500ms'), 500);
});

test('parseDuration: 数字直接当毫秒', () => {
  assert.equal(parseDuration(60), 60_000);
  assert.equal(parseDuration(0), 0);
});

test('parseDuration: 格式错抛错', () => {
  assert.throws(() => parseDuration('abc'), /时长格式不对/);
  assert.throws(() => parseDuration('1y'), /时长格式不对/);
});

test('parseWindow: null / 空字符串 = 全天', () => {
  assert.equal(parseWindow(null), null);
  assert.equal(parseWindow(undefined), null);
  assert.equal(parseWindow(''), null);
  assert.equal(parseWindow('   '), null);
});

test('parseWindow: 跨夜 20:00-08:00', () => {
  const w = parseWindow('20:00-08:00');
  assert.deepEqual(w, { start: 1200, end: 480, always: false, crossNight: true });
});

test('parseWindow: 不跨夜 08:00-20:00', () => {
  const w = parseWindow('08:00-20:00');
  assert.deepEqual(w, { start: 480, end: 1200, always: false, crossNight: false });
});

test('parseWindow: 起止相同 = 始终', () => {
  const w = parseWindow('12:00-12:00');
  assert.equal(w.always, true);
});

test('parseWindow: 格式错抛错', () => {
  assert.throws(() => parseWindow('abc'), /时间窗口格式不对/);
  assert.throws(() => parseWindow('8-20'), /时间窗口格式不对/);  // 缺冒号
});

test('inWindow: 全天始终在窗口', () => {
  assert.equal(inWindow(null), true);
  assert.equal(inWindow({ start: 0, end: 0, always: true }), true);
});

test('inWindow: 跨夜窗口 — 22:00 在内、12:00 在外、04:00 在内', () => {
  const w = parseWindow('20:00-08:00');
  const at = (h, m) => inWindow(w, new Date(2026, 0, 1, h, m));
  assert.equal(at(22, 0), true);   // 22:00 >= 20:00
  assert.equal(at(12, 0), false);  // 12:00 < 20:00 且 >= 08:00
  assert.equal(at(4, 0), true);    // 04:00 < 08:00
  assert.equal(at(8, 0), false);   // 08:00 不在（端点不含）
  assert.equal(at(20, 0), true);   // 20:00 含
});

test('inWindow: 不跨夜窗口 — 09:00 在内、22:00 在外', () => {
  const w = parseWindow('08:00-20:00');
  const at = (h, m) => inWindow(w, new Date(2026, 0, 1, h, m));
  assert.equal(at(9, 0), true);
  assert.equal(at(22, 0), false);
  assert.equal(at(8, 0), true);
  assert.equal(at(20, 0), false);
});

test('loadConfig: 没 yaml 时返回默认值 + 路径', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ovn-cfg-'));
  try {
    const cfg = loadConfig(dir);
    assert.equal(cfg.default_agent, 'opencode');
    assert.equal(cfg.runner.timeoutMs, 3_600_000);     // 60m
    assert.equal(cfg.runner.idleKillMs, 600_000);     // 10m
    assert.equal(cfg.retry.max, 3);
    assert.equal(cfg.paths.root, dir);
    assert.equal(cfg.paths.queue, join(dir, 'queue'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig: yaml 顶层覆盖', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ovn-cfg-'));
  try {
    writeFileSync(join(dir, 'overnight.yaml'), 'retry:\n  max: 7\n');
    const cfg = loadConfig(dir);
    assert.equal(cfg.retry.max, 7);
    assert.equal(cfg.retry.backoffMs, 5 * 60_000);   // 默认 backoff 没被覆盖
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig: schedule.window=null 不能被默认值盖回（deepMerge null 语义）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ovn-cfg-'));
  try {
    writeFileSync(join(dir, 'overnight.yaml'), 'schedule:\n  window: null\n');
    const cfg = loadConfig(dir);
    assert.equal(cfg.schedule.window, null, 'null 必须是显式覆盖');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig: schedule.window=空字符串 也是全天', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ovn-cfg-'));
  try {
    writeFileSync(join(dir, 'overnight.yaml'), 'schedule:\n  window: ""\n');
    const cfg = loadConfig(dir);
    assert.equal(cfg.schedule.window, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig: yaml 解析错抛错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ovn-cfg-'));
  try {
    writeFileSync(join(dir, 'overnight.yaml'), 'foo: [unterminated\n');
    assert.throws(() => loadConfig(dir), /overnight\.yaml 解析失败/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});