export default function handler(req, res) {
  // 모든 환경변수 이름 출력 (값은 숨김)
  const all = Object.keys(process.env).sort();
  const relevant = all.filter(k =>
    k.includes('GROQ') || k.includes('GROK') || k.includes('GEMINI') ||
    k.includes('VITE') || k.includes('SUPABASE') || k.includes('API')
  );
  res.json({
    all_keys: all,
    relevant_keys: relevant,
    gemini_set: !!(process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY),
    groq_set:   !!(process.env.GROQ_API_KEY   || process.env.VITE_GROQ_API_KEY),
  });
}
