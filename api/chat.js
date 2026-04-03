import { createClient } from '@supabase/supabase-js';
import { REGULATION_INDEX } from './regulation_index.js';

const CHUNK_CANDIDATES = 50;

// 제공자별 설정 (컨텍스트·토큰·히스토리 한도)
const PROVIDERS = {
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model: 'gemini-2.0-flash',
    contextChars: 52000,
    maxTokens: 3500,
    maxHistory: 8,
    regCtxChars: 5000,
    includeIndex: true,
  },
  groq_70b: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
    contextChars: 9000,
    maxTokens: 2048,
    maxHistory: 4,
    regCtxChars: 2500,
    includeIndex: true,
  },
  groq_8b: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.1-8b-instant',
    contextChars: 2500,
    maxTokens: 1000,
    maxHistory: 0,
    regCtxChars: 1200,
    includeIndex: false,
  },
};

// 한국어 인식 키워드 추출 (조사 제거 + 복합어 분리)
function extractKeywords(query) {
  const cleaned = query.replace(/[^\w\s가-힣0-9]/g, ' ');
  const rawWords = cleaned.split(/\s+/).filter(w => w.length > 1);

  const keywords = new Set();
  for (const word of rawWords) {
    keywords.add(word);
    // 한국어 단어: 끝 1글자(조사) 제거한 어간도 추가
    if (/[가-힣]/.test(word) && word.length >= 3) {
      keywords.add(word.slice(0, -1));
    }
    // 4글자 이상이면 앞 3글자도 추가 (복합명사 분리 근사)
    if (/[가-힣]/.test(word) && word.length >= 4) {
      keywords.add(word.slice(0, 3));
    }
  }
  return [...keywords].slice(0, 14);
}

// 청크 키워드 점수 계산
function scoreChunks(chunks, keywords) {
  return chunks.map(c => {
    const lower = c.content.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      const re = new RegExp(kw.toLowerCase(), 'g');
      const count = lower.match(re)?.length ?? 0;
      if (count > 0) {
        score += count;
        score += 1; // 매칭 보너스
      }
    }
    return { ...c, score };
  });
}

async function searchChunks(folderId, query, maxContextChars) {
  const sbUrl = process.env.VITE_SUPABASE_URL;
  const sbKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!sbUrl || !sbKey || !folderId) return [];

  const sb = createClient(sbUrl, sbKey);
  const keywords = extractKeywords(query);

  let chunks = [];

  if (keywords.length > 0) {
    // 상위 키워드로 DB 필터링 (OR 조건)
    const orFilter = keywords.slice(0, 10).map(kw => `content.ilike.%${kw}%`).join(',');
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

  // 매칭 청크 부족 시 전체에서 보충
  if (chunks.length < 8) {
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

  // 점수 계산 후 상위 청크 선택
  const scored = scoreChunks(chunks, keywords);
  scored.sort((a, b) => b.score - a.score || a.file_name.localeCompare(b.file_name) || a.chunk_index - b.chunk_index);

  const topChunks = scored.filter(c => c.score > 0).slice(0, 20);

  // 인접 청크 추가 (앞뒤 문맥 확보)
  const chunkMap = new Map(chunks.map(c => [`${c.file_name}_${c.chunk_index}`, c]));
  const selected = new Set(topChunks.map(c => `${c.file_name}_${c.chunk_index}`));

  for (const c of [...topChunks]) {
    const prevKey = `${c.file_name}_${c.chunk_index - 1}`;
    const nextKey = `${c.file_name}_${c.chunk_index + 1}`;
    if (!selected.has(prevKey) && chunkMap.has(prevKey)) {
      topChunks.push({ ...chunkMap.get(prevKey), score: 0 });
      selected.add(prevKey);
    }
    if (!selected.has(nextKey) && chunkMap.has(nextKey)) {
      topChunks.push({ ...chunkMap.get(nextKey), score: 0 });
      selected.add(nextKey);
    }
  }

  // 파일명·청크 순서대로 정렬 (논리적 흐름 유지)
  topChunks.sort((a, b) => a.file_name.localeCompare(b.file_name) || a.chunk_index - b.chunk_index);

  // 컨텍스트 한도 내에서 자르기
  let total = 0;
  const result = [];
  for (const c of topChunks) {
    if (total + c.content.length > maxContextChars) break;
    result.push(c);
    total += c.content.length;
  }

  return result;
}

// 파일별로 청크를 그룹핑하여 가독성 높은 컨텍스트 생성
function buildContextText(chunks) {
  if (!chunks.length) return '(현재 업로드된 문서가 없습니다)';
  const fileGroups = {};
  for (const c of chunks) {
    if (!fileGroups[c.file_name]) fileGroups[c.file_name] = [];
    fileGroups[c.file_name].push(c.content);
  }
  return Object.entries(fileGroups)
    .map(([fileName, contents]) => `【 ${fileName} 】\n${contents.join('\n')}`)
    .join('\n\n');
}

// 정교한 시스템 프롬프트 생성
function buildSystemPrompt(folderName, contextText, regCtx, includeIndex) {
  return `당신은 광덕고등학교 교사를 위한 전문 교육행정 AI 비서입니다.
현재 참조 폴더: "${folderName ?? '미지정'}"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【 핵심 원칙 】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. 근거 기반 답변: 반드시 아래 [업로드 문서] 또는 [광덕 규정집 본문]에 명시된 내용만으로 답변합니다.
2. 출처 필수 명시: 모든 답변에 출처(규정명·조항번호·페이지)를 반드시 표기합니다.
3. 없는 내용 처리: 문서에서 찾을 수 없는 내용은 절대 추측·창작하지 않으며, 반드시 다음 문구로 안내합니다:
   "업로드된 문서에서 해당 내용을 찾을 수 없습니다. 관련 문서를 업로드하시거나 담당 부서에 직접 문의해 주세요."
4. 전문성 유지: 교육행정 전문 용어를 정확히 사용하고, 교사에게 적합한 공손하고 명확한 문체로 답변합니다.
5. 완전한 답변: 질문이 여러 해석 가능하면 모든 관련 내용을 포괄적으로 다룹니다.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【 답변 형식 지침 】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• 핵심 답변 우선: 질문의 핵심에 대한 결론을 첫 문단에 간결하게 제시합니다.
• 구조화: 세부 내용은 항목별(번호·불릿) 마크다운으로 정리합니다.
• 출처 표기: 각 내용 끝에 (출처: 규정명 제X조) 형식으로 명시하거나, 답변 하단에 [참고 출처] 섹션으로 정리합니다.
• 단계 안내: 절차·프로세스가 있으면 ① ② ③ 형식으로 순서대로 안내합니다.
• 주의사항 강조: 중요한 예외·기한·주의사항은 **굵게** 또는 별도 항목으로 강조합니다.
• 숫자·날짜 정확: 기한, 학점 수, 조항 번호 등은 문서 원문에서 그대로 정확하게 인용합니다.
• 중복 금지: 동일한 내용을 반복하지 않고 명료하게 작성합니다.
${includeIndex ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[광덕고 규정집 인덱스 - 참고용 목차]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${REGULATION_INDEX}
` : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[업로드 문서]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${contextText}${regCtx ? `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[광덕 규정집 본문]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${regCtx}` : ''}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).send('Method not allowed'); return; }

  const geminiKey = process.env.GEMINI_API_KEY ?? process.env.VITE_GEMINI_API_KEY;
  const groqKey   = process.env.GROQ_API_KEY ?? process.env.VITE_GROQ_API_KEY;

  const queue = [];
  if (geminiKey) queue.push({ ...PROVIDERS.gemini,   key: geminiKey });
  if (groqKey)   queue.push({ ...PROVIDERS.groq_70b, key: groqKey });
  if (groqKey)   queue.push({ ...PROVIDERS.groq_8b,  key: groqKey });

  if (!queue.length) {
    res.status(500).json({ error: 'API 키가 설정되지 않았습니다. GEMINI_API_KEY 또는 GROQ_API_KEY를 확인하세요.' });
    return;
  }

  try {
    const { folderId, folderName, query, history = [], regulationContext = '' } = req.body;
    if (!query) { res.status(400).json({ error: '질문이 없습니다.' }); return; }

    // Supabase 검색은 한 번만 수행 (최대 컨텍스트로)
    const allChunks = await searchChunks(folderId, query, 65000);

    let finalRes = null;
    const errors = [];

    for (const provider of queue) {
      // 제공자 컨텍스트 한도에 맞게 청크 자르기
      let total = 0;
      const providerChunks = [];
      for (const c of allChunks) {
        if (total + c.content.length > provider.contextChars) break;
        providerChunks.push(c);
        total += c.content.length;
      }

      const contextText = buildContextText(providerChunks);
      const trimmedHistory = history.slice(-provider.maxHistory);
      const regCtx = regulationContext.slice(0, provider.regCtxChars);
      const system = buildSystemPrompt(folderName, contextText, regCtx, provider.includeIndex);

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

        const errText = await r.text().catch(() => '');
        errors.push(`${provider.model}(${r.status}): ${errText.slice(0, 120)}`);

        if ([429, 413, 400, 500, 502, 503, 504].includes(r.status)) continue;

        res.status(r.status).send(errText);
        return;
      } catch (e) {
        errors.push(`${provider.model}(network): ${e?.message ?? e}`);
        continue;
      }
    }

    if (!finalRes) {
      res.status(429).json({ error: `모든 AI 제공자 응답 실패. 잠시 후 다시 시도해주세요.\n${errors.join('\n')}` });
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
