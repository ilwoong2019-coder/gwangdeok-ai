import { createClient } from '@supabase/supabase-js';

// 무료 플랜 12,000 TPM 기준 최적화
// 컨텍스트 ~3,500토큰 + 히스토리 ~600토큰 + 답변 2,048토큰 = ~6,200토큰
const CHUNK_CANDIDATES = 30;   // 검색 후보 수 (많이 가져와서 스코어링)
const MAX_CONTEXT_CHARS = 14000; // ~3,500 토큰 (한국어 4자≈1토큰)
const MAX_HISTORY_MSGS  = 6;    // 최근 3턴만 유지
const MAX_TOKENS        = 2048;

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

async function searchChunks(folderId, query) {
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

  // 키워드 검색 결과 부족 시 순서대로 보충
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

  // 키워드 등장 빈도로 스코어링 후 관련성 높은 순 정렬
  const scored = scoreChunks(chunks, keywords);
  scored.sort((a, b) => b.score - a.score || a.file_name.localeCompare(b.file_name) || a.chunk_index - b.chunk_index);

  // 컨텍스트 한도 내에서 선택
  let total = 0;
  const result = [];
  for (const c of scored) {
    if (total + c.content.length > MAX_CONTEXT_CHARS) break;
    result.push(c);
    total += c.content.length;
  }

  // 파일명→청크 순으로 재정렬 (AI가 읽기 쉽게)
  result.sort((a, b) => a.file_name.localeCompare(b.file_name) || a.chunk_index - b.chunk_index);
  return result;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).send('Method not allowed'); return; }

  const apiKey = process.env.GROQ_API_KEY ?? process.env.VITE_GROQ_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'GROQ_API_KEY (또는 VITE_GROQ_API_KEY) 환경변수가 설정되지 않았습니다.' });
    return;
  }

  try {
    const { folderId, folderName, query, history = [], model, max_tokens } = req.body;

    if (!query) { res.status(400).json({ error: '질문이 없습니다.' }); return; }

    const chunks = await searchChunks(folderId, query);
    const contextText = chunks.map(c => `[${c.file_name}]\n${c.content}`).join('\n\n');

    // 시스템 프롬프트 압축 (토큰 절약)
    const system = `광덕 교사용 교육행정 AI 비서입니다. 폴더: "${folderName ?? ''}"
규칙: ①아래 문서 내용만 근거로 답변 ②출처 파일명 반드시 명시 ③문서에 없으면 "문서에서 확인 불가" ④간결·친절하게

[문서]
${contextText || '(문서 없음)'}`;

    // 히스토리 API에서도 한 번 더 제한 (토큰 절약)
    const trimmedHistory = history.slice(-MAX_HISTORY_MSGS);

    const messages = [
      { role: 'system', content: system },
      ...trimmedHistory,
      { role: 'user', content: query },
    ];

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model ?? 'llama-3.3-70b-versatile',
        messages,
        stream: true,
        max_tokens: max_tokens ?? MAX_TOKENS,
      }),
    });

    if (!groqRes.ok) {
      const err = await groqRes.text();
      res.status(groqRes.status).send(err);
      return;
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of groqRes.body) {
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
