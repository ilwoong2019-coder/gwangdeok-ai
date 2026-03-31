export default function handler(req, res) {
  const keys = Object.keys(process.env).filter(k =>
    k.includes('GROQ') || k.includes('GROK') || k.includes('GEMINI') || k.includes('VITE') || k.includes('SUPABASE')
  );
  res.json({
    available_keys: keys,
    gemini_set: !!(process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY),
    groq_set:   !!(process.env.GROQ_API_KEY   || process.env.VITE_GROQ_API_KEY),
  });
}
