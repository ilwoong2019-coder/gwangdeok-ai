export default function handler(req, res) {
  const keys = Object.keys(process.env).filter(k =>
    k.includes('GROQ') || k.includes('GROK') || k.includes('VITE') || k.includes('SUPABASE')
  );
  res.json({ available_keys: keys });
}
