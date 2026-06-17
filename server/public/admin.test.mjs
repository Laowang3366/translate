import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('admin dashboard translation usage chart', () => {
  it('renders a daily translation call line chart from admin metrics', async () => {
    const html = await readFile(path.resolve('server/public/admin.html'), 'utf8');

    expect(html).toContain('过去 7 天翻译调用趋势');
    expect(html).toContain('id="translation-usage-chart"');
    expect(html).toContain('function renderTranslationUsageTrend()');
    expect(html).toContain('metrics.translations');
    expect(html).toContain('polyline');
  });

  it('renders translation cache and latency summary fields', async () => {
    const html = await readFile(path.resolve('server/public/admin.html'), 'utf8');

    expect(html).toContain('id="data-cache-hit-rate"');
    expect(html).toContain('id="data-provider-request-total"');
    expect(html).toContain('id="data-average-first-chunk-ms"');
    expect(html).toContain('id="data-average-duration-ms"');
    expect(html).toContain('缓存命中率');
    expect(html).toContain('平均首段耗时');
    expect(html).toContain('translations.cacheHitRate');
    expect(html).toContain('translations.averageFirstChunkMs');
  });

  it('keeps provider configuration in a dialog card with a custom type input', async () => {
    const html = await readFile(path.resolve('server/public/admin.html'), 'utf8');

    expect(html).toContain('id="provider-dialog"');
    expect(html).toContain('id="open-provider-dialog-button"');
    expect(html).toContain('id="provider-type-suggestions"');
    expect(html).toContain('<input id="provider-type"');
    expect(html).toContain('id="request-timeout-minutes"');
    expect(html).toContain('请求超时（分钟）');
    expect(html).not.toContain('<select id="provider-type"');
    expect(html).toContain('function openProviderDialog(');
    expect(html).toContain('function closeProviderDialog()');
  });

  it('supports revealing and hiding saved provider API keys in the admin page', async () => {
    const html = await readFile(path.resolve('server/public/admin.html'), 'utf8');

    expect(html).toContain('data-provider-action="reveal-key"');
    expect(html).toContain('data-provider-action="hide-key"');
    expect(html).toContain('/secret');
    expect(html).toContain('查看密钥');
    expect(html).toContain('隐藏密钥');
  });

  it('does not inject a hard-coded fallback model into provider configuration', async () => {
    const html = await readFile(path.resolve('server/public/admin.html'), 'utf8');

    expect(html).not.toContain('gpt-5.4-mini');
    expect(html).toContain('请先获取模型列表');
  });

  it('exposes an admin account security view for changing email and password', async () => {
    const html = await readFile(path.resolve('server/public/admin.html'), 'utf8');

    expect(html).toContain('data-view="account"');
    expect(html).toContain('id="account-view"');
    expect(html).toContain('id="admin-email"');
    expect(html).toContain('id="admin-current-password"');
    expect(html).toContain('id="admin-new-password"');
    expect(html).toContain('/api/admin/profile');
    expect(html).toContain('function loadAdminProfile()');
    expect(html).toContain('function saveAdminProfile(');
  });

  it('exposes notification management for client popup announcements', async () => {
    const html = await readFile(path.resolve('server/public/admin.html'), 'utf8');

    expect(html).toContain('data-view="notifications"');
    expect(html).toContain('id="notifications-view"');
    expect(html).toContain('id="notification-form"');
    expect(html).toContain('id="notification-list"');
    expect(html).toContain('/api/admin/notifications');
    expect(html).toContain('function loadNotifications()');
    expect(html).toContain('function saveNotification(');
    expect(html).toContain('function platformLabel(');
    expect(html).toContain('function notificationSeverityLabel(');
  });

  it('exposes a standalone anonymous visitor analytics module', async () => {
    const html = await readFile(path.resolve('server/public/admin.html'), 'utf8');

    expect(html).toContain('data-view="visitors"');
    expect(html).toContain('id="visitors-view"');
    expect(html).toContain('访问统计');
    expect(html).toContain('id="visitor-total"');
    expect(html).toContain('id="visitor-unique-total"');
    expect(html).toContain('id="visitor-usage-chart"');
    expect(html).toContain('id="visitor-device-list"');
    expect(html).toContain('id="visitor-ip-list"');
    expect(html).toContain('id="visitor-referrer-list"');
    expect(html).toContain('id="visitor-recent-table"');
    expect(html).toContain('访问 IP');
    expect(html).toContain('设备指纹');
    expect(html).toContain('function renderVisitorStats()');
    expect(html).toContain('metrics.visitors');
  });
});
