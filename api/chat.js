import { createClient } from '@supabase/supabase-js';
import { REGULATION_INDEX } from './regulation_index.js';

const CHUNK_CANDIDATES = 30;
const MAX_HISTORY_MSGS = 4;

// 제공자별 설정
// contextChars: PDF 청크 최대 길이 / regCtxChars: 규정 본문 최대 길이 / includeIndex: 규정 인덱스 포함 여부
const PROVIDERS = {
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model: 'gemini-2.0-flash',
    contextChars: 44000,
    maxTokens: 2048,
    maxHistory: 6,
    regCtxChars: 3000,
    includeIndex: true,
  },
  groq_70b: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
    contextChars: 6000,
    maxTokens: 1800,
    maxHistory: 2,
    regCtxChars: 1500,
    includeIndex: true,
  },
  groq_8b: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.1-8b-instant',
    contextChars: 1500,
    maxTokens: 600,
    maxHistory: 0,
    regCtxChars: 800,
    includeIndex: false,
  },
};

function scoreChunks(chunks, keywords) {
  return chunks.map(c => {
    const lower = c.content.toLowerCase();
    const score = keywords.reduce((s, kw) => {
      const re = new RegExp(kw.toLowerCase(), 'g');
      return s + (lower.match(re) ?? []).length;
    }, 0);
    return { ...c, score };
  });
}

async function searchChunks(folderId, query, maxContextChars) {
  const sbUrl = process.env.VITE_SUPABASE_URL;
  const sbKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!sbUrl || !sbKey || !folderId) return [];

  const sb = createClient(sbUrl, sbKey);

  const keywords = query
    .replace(/[^\w\s가-힣]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1)
    .slice(0, 6);

  let chunks = [];

  if (keywords.length > 0) {
    const orFilter = keywords.map(kw => `content.ilike.%${kw}%`).join(',');
    const { data } = await sb
      .from('document_chunks')
      .select('file_name, chunk_index, content')
      .eq('folder_id', folderId)
      .or(orFilter)
      .order('file_name')
      .order('chunk_index')
      .limit(CHUNK_CANDIDATES);
    chunks = data ?? [];
  }

  if (chunks.length < 5) {
    const { data } = await sb
      .from('document_chunks')
      .select('file_name, chunk_index, content')
      .eq('folder_id', folderId)
      .order('file_name')
      .order('chunk_index')
      .limit(CHUNK_CANDIDATES);
    const seen = new Set(chunks.map(c => `${c.file_name}_${c.chunk_index}`));
    for (const c of (data ?? [])) {
      if (!seen.has(`${c.file_name}_${c.chunk_index}`)) {
        chunks.push(c);
        seen.add(`${c.file_name}_${c.chunk_index}`);
      }
    }
  }

  const scored = scoreChunks(chunks, keywords);
  scored.sort((a, b) => b.score - a.score || a.file_name.localeCompare(b.file_name) || a.chunk_index - b.chunk_index);

  let total = 0;
  const result = [];
  for (const c of scored) {
    if (total + c.content.length > maxContextChars) break;
    result.push(c);
    total += c.content.length;
  }

  result.sort((a, b) => a.file_name.localeCompare(b.file_name) || a.chunk_index - b.chunk_index);
  return result;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).send('Method not allowed'); return; }

  const geminiKey = process.env.GEMINI_API_KEY ?? process.env.VITE_GEMINI_API_KEY;
  const groqKey   = process.env.GROQ_API_KEY ?? process.env.VITE_GROQ_API_KEY;

  // 사용 가능한 제공자 순서 결정 (Gemini 우선)
  const queue = [];
  if (geminiKey) queue.push({ ...PROVIDERS.gemini,    key: geminiKey });
  if (groqKey)   queue.push({ ...PROVIDERS.groq_70b,  key: groqKey });
  if (groqKey)   queue.push({ ...PROVIDERS.groq_8b,   key: groqKey });

  if (!queue.length) {
    res.status(500).json({ error: 'API 키가 설정되지 않았습니다. GEMINI_API_KEY 또는 GROQ_API_KEY를 확인하세요.' });
    return;
  }

  try {
    const { folderId, folderName, query, history = [], regulationContext = '' } = req.body;
    if (!query) { res.status(400).json({ error: '질문이 없습니다.' }); return; }

    let finalRes = null;

    for (const provider of queue) {
      const trimmedHistory = history.slice(-provider.maxHistory);
      const chunks = await searchChunks(folderId, query, provider.contextChars);
      const contextText = chunks.map(c => `[${c.file_name}]\n${c.content}`).join('\n\n');

      const regCtx = regulationContext.slice(0, provider.regCtxChars);
      const system = `광덕고등학교 교사용 교육행정 AI 비서입니다. 폴더: "${folderName ?? ''}"
규칙: ①아래 문서·규정집 내용을 근거로 답변 ②출처(규정명·조항·페이지) 반드시 명시 ③문서에 없으면 "문서에서 확인 불가" ④간결·친절하게
${provider.includeIndex ? `\n[광덕고 규정집 인덱스]\n${REGULATION_INDEX}\n` : ''}
[업로드 문서]
${contextText || '(문서 없음)'}${regCtx ? `\n\n[광덕 규정집 본문]\n${regCtx}` : ''}`;

      const messages = [
        { role: 'system', content: system },
        ...trimmedHistory,
        { role: 'user', content: query },
      ];

      try {
        const r = await fetch(provider.url, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${provider.key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: provider.model, messages, stream: true, max_tokens: provider.maxTokens }),
        });

        if (r.ok) { finalRes = r; break; }

        // 한도 초과나 요청 오류면 다음 제공자로
        if (r.status === 429 || r.status === 413 || r.status === 400) continue;

        // 그 외 오류(401 등)는 바로 반환
        const err = await r.text();
        res.status(r.status).send(err);
        return;
      } catch {
        // 네트워크 오류 시 다음 제공자로
        continue;
      }
    }

    if (!finalRes) {
      res.status(429).json({ error: '모든 AI 제공자의 한도가 초과됐습니다. 잠시 후 다시 시도해주세요.' });
      return;
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of finalRes.body) {
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
          if (content) res.write(content);
        } catch {}
      }
    }
    res.end();
  } catch (e) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
}
