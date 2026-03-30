export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'GROQ_API_KEY 환경변수가 설정되지 않았습니다.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { messages, model, max_tokens } = await req.json();

  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model ?? 'llama-3.3-70b-versatile',
      messages,
      stream: true,
      max_tokens: max_tokens ?? 4096,
    }),
  });

  if (!groqRes.ok) {
    const err = await groqRes.text();
    return new Response(err, { status: groqRes.status });
  }

  // SSE 스트림에서 텍스트 content만 추출해서 클라이언트로 전달
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  const transform = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.delta?.content ?? '';
          if (content) controller.enqueue(encoder.encode(content));
        } catch {}
      }
    },
  });

  return new Response(groqRes.body.pipeThrough(transform), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
