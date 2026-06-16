import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('download page platform cards', () => {
  it('only exposes currently published Windows and Android installers', async () => {
    const html = await readFile(path.resolve('server/public/download.html'), 'utf8');

    expect(html).toContain("key: 'windows'");
    expect(html).toContain("key: 'android'");
    expect(html).not.toContain("key: 'macos'");
    expect(html).not.toContain("key: 'ios'");
    expect(html).not.toContain('Mac 端');
    expect(html).not.toContain('iPhone / iPad');
    expect(html).toContain("return 'unsupported'");
    expect(html).toContain('仅支持 Windows 和 Android 安装包');
    expect(html).toContain("latestLink.classList.add('hidden')");
    expect(html).toContain("pathname.endsWith('/download')");
  });

  it('streams demo translation output through the backend token stream endpoint', async () => {
    const html = await readFile(path.resolve('server/public/download.html'), 'utf8');

    expect(html).toContain("apiUrl('/api/translate/stream')");
    expect(html).toContain("event.type === 'delta'");
    expect(html).toContain('event.totalChunks || chunkCount');
    expect(html).toContain('readDemoStreamEvents');
  });

  it('only autoplays the interface carousel while the interface view is visible', async () => {
    const html = await readFile(path.resolve('server/public/download.html'), 'utf8');

    expect(html).toContain('function setCarouselAutoplay(enabled)');
    expect(html).toContain("setCarouselAutoplay(normalizedView === 'interface')");
    expect(html).toContain('if (image.dataset.currentAsset !== slide.image)');
    expect(html).not.toContain('resetCarouselTimer();\n\n      document.querySelector');
  });

  it('keeps the demo result panel nonblank while waiting for late stream deltas', async () => {
    const html = await readFile(path.resolve('server/public/download.html'), 'utf8');

    expect(html).toContain("setDemoPendingResult('正在等待模型输出...')");
    expect(html).toContain('function animateDemoResultText(targetText, requestId)');
    expect(html).toContain('void animateDemoResultText(event.result?.translatedText');
    expect(html).not.toContain("demoResult.textContent = '';");
  });
});
