const apiKey = process.env.TRANSLATE_API_KEY || process.env.OPENAI_API_KEY || '';
const baseUrl = (process.env.TRANSLATE_BASE_URL || '').replace(/\/$/, '');
const model = process.env.TRANSLATE_MODEL || '';
const text = process.env.TRANSLATE_SMOKE_TEXT || 'hello';
const targetLanguage = process.env.TRANSLATE_SMOKE_TARGET || 'zh-CN';
const requireKey = process.argv.includes('--require-key');

if (!apiKey || !baseUrl || !model) {
  const message = '[接口冒烟] 未完整设置 TRANSLATE_API_KEY/OPENAI_API_KEY、TRANSLATE_BASE_URL、TRANSLATE_MODEL，跳过真实接口冒烟。';
  if (requireKey) {
    console.error(message);
    process.exit(1);
  }

  console.log(message);
  process.exit(0);
}

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30_000);

try {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: `Translate the user text into ${targetLanguage}. Return only the translated text.`
        },
        { role: 'user', content: text }
      ],
      temperature: 0.1
    }),
    signal: controller.signal
  });

  const payload = await readJson(response);
  if (!response.ok) {
    const apiMessage = payload?.error?.message ?? payload?.message ?? `HTTP ${response.status}`;
    throw new Error(`接口请求失败：${apiMessage}`);
  }

  const translatedText = payload?.choices?.[0]?.message?.content?.trim();
  if (!translatedText) {
    throw new Error('接口返回了空翻译结果');
  }

  console.log(`[接口冒烟] 成功：${translatedText}`);
} catch (error) {
  const message = error instanceof Error && error.name === 'AbortError' ? '接口请求超时' : error.message;
  console.error(`[接口冒烟] 失败：${message}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
