import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI } from '@google/genai';
import * as pdfjsLib from 'pdfjs-dist';
import ReactMarkdown from 'react-markdown';
import {
  Upload, FileText, Trash2, Plus, FolderPlus, X, Menu,
  Download, Copy, Check, Printer, Mic, MicOff, Sun, Moon,
  ZoomIn, ZoomOut, ArrowUp, History, Share2, Folder,
  RefreshCw, Bot, User, Loader2, AlertCircle, Sparkles,
  MessageSquare, FileSearch, LayoutGrid, Paperclip,
  Lock, LockOpen,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

// ── Types ─────────────────────────────────────────────────
interface FileData { id: string; name: string; text: string; }
interface FolderData { id: string; name: string; files: FileData[]; }
interface Message { role: 'user' | 'bot'; content: string; ts: number; }

// ── Constants ─────────────────────────────────────────────
const MODEL = 'gemini-2.0-flash';
const DEV_PASSWORD = 'gwangdeok2026'; // 관리자 비밀번호 (변경 가능)
const LS = {
  folders:  'gd2-folders',
  folderId: 'gd2-folder',
  messages: 'gd2-messages',
  theme:    'gd2-theme',
  size:     'gd2-size',
};
const DEFAULT_FOLDER: FolderData = { id: 'default', name: '학교 규정 및 자료', files: [] };

function lsGet<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}

// ── App ───────────────────────────────────────────────────
export default function App() {
  const [folders,  setFolders]  = useState<FolderData[]>(() => lsGet(LS.folders, [DEFAULT_FOLDER]));
  const [folderId, setFolderId] = useState<string>(() => localStorage.getItem(LS.folderId) ?? 'default');
  const [messages, setMessages] = useState<Message[]>(() =>
    lsGet<any[]>(LS.messages, []).map((m: any) => ({ ...m, ts: m.ts ?? Date.now() }))
  );
  const [theme,    setTheme]    = useState<'light' | 'dark'>(() =>
    (localStorage.getItem(LS.theme) as 'light' | 'dark') ?? 'light'
  );
  const [fontSize, setFontSize] = useState(() => Number(localStorage.getItem(LS.size)) || 15);

  const [input,      setInput]      = useState('');
  const [loading,    setLoading]    = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [drag,       setDrag]       = useState(false);
  const [copiedIdx,  setCopiedIdx]  = useState<number | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [shareOk,    setShareOk]    = useState(false);
  const [newName,    setNewName]    = useState('');
  const [addingFolder, setAddingFolder] = useState(false);
  const [listening,  setListening]  = useState(false);
  const [devMode,    setDevMode]    = useState(() => sessionStorage.getItem('gd-dev') === '1');
  const [showDevModal, setShowDevModal] = useState(false);
  const [devPwInput,   setDevPwInput]   = useState('');
  const [devPwError,   setDevPwError]   = useState(false);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [uploadTarget,     setUploadTarget]     = useState<string>('');

  const fileRef   = useRef<HTMLInputElement>(null);
  const endRef    = useRef<HTMLDivElement>(null);
  const recRef    = useRef<any>(null);
  const inputRef  = useRef<HTMLTextAreaElement>(null);

  const dark   = theme === 'dark';
  const folder = folders.find(f => f.id === folderId) ?? folders[0];

  // shorthand: d(light, dark)
  const d = (l: string, dk: string) => dark ? dk : l;

  // ── Persistence ───────────────────────────────────────────
  useEffect(() => { try { localStorage.setItem(LS.folders, JSON.stringify(folders)); } catch {} }, [folders]);
  useEffect(() => { localStorage.setItem(LS.folderId, folderId); }, [folderId]);
  useEffect(() => { try { localStorage.setItem(LS.messages, JSON.stringify(messages)); } catch {} }, [messages]);
  useEffect(() => {
    localStorage.setItem(LS.theme, theme);
    document.documentElement.style.colorScheme = theme;
  }, [theme]);
  useEffect(() => { localStorage.setItem(LS.size, String(fontSize)); }, [fontSize]);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(t);
  }, [error]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, loading]);

  // ── AI helper ─────────────────────────────────────────────
  const getAI = () => {
    const key = (import.meta as any).env?.VITE_GEMINI_API_KEY;
    if (!key) throw new Error('Gemini API 키가 설정되지 않았습니다.');
    return new GoogleGenAI({ apiKey: key });
  };

  // ── PDF extraction ────────────────────────────────────────
  const extractPdf = async (file: File): Promise<string> => {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const c = await page.getTextContent();
      text += c.items.map((item: any) => item.str).join(' ') + '\n';
    }
    if (!text.trim()) throw new Error(`"${file.name}"에서 텍스트를 추출할 수 없습니다. 스캔 이미지 PDF일 수 있습니다.`);
    return text;
  };

  // ── File upload ───────────────────────────────────────────
  const uploadFiles = async (files: File[], targetId?: string) => {
    const pdfs = files.filter(f => f.type === 'application/pdf');
    if (!pdfs.length) { setError('PDF 파일만 업로드 가능합니다.'); return; }
    const tid = targetId ?? folderId;
    setProcessing(true); setError(null);
    try {
      const added: FileData[] = [];
      for (const f of pdfs) {
        const text = await extractPdf(f);
        added.push({ id: crypto.randomUUID(), name: f.name, text });
      }
      setFolders(prev => prev.map(f =>
        f.id === tid ? { ...f, files: [...f.files, ...added] } : f
      ));
      // 업로드한 폴더로 자동 이동
      setFolderId(tid);
      const targetFolder = folders.find(f => f.id === tid);
      addBot(`✅ **${targetFolder?.name ?? '폴더'}**에 ${added.length}개 파일이 추가됐습니다.\n\n${added.map(f => `• \`${f.name}\``).join('\n')}\n\n이제 이 폴더의 문서에 대해 자유롭게 질문해주세요!`);
    } catch (e: any) {
      setError(e.message ?? '파일 처리 오류');
    } finally {
      setProcessing(false);
      setUploadTarget('');
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const addBot = (content: string) =>
    setMessages(prev => [...prev, { role: 'bot', content, ts: Date.now() }]);

  // ── Drag & drop ───────────────────────────────────────────
  const onDragOver  = (e: React.DragEvent) => { e.preventDefault(); setDrag(true); };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    if (!(e.currentTarget as Element).contains(e.relatedTarget as Node)) setDrag(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDrag(false);
    if (!devMode) { setError('파일 업로드는 관리자만 가능합니다.'); return; }
    if (e.dataTransfer?.files?.length) uploadFiles(Array.from(e.dataTransfer.files), folderId);
  };

  // ── Send message ──────────────────────────────────────────
  const sendMessage = async (override?: string) => {
    const msg = (override ?? input).trim();
    if (!msg || loading) return;
    if (!override) setInput('');
    setMessages(prev => [...prev, { role: 'user', content: msg, ts: Date.now() }]);
    setLoading(true); setError(null);
    try {
      const ai  = getAI();
      const ctx = (folder?.files ?? []).map(f => `### 파일: ${f.name}\n${f.text}`).join('\n\n');
      if (!ctx.trim()) {
        addBot('현재 폴더에 파일이 없습니다. 왼쪽 사이드바에서 PDF를 먼저 업로드해주세요.');
        return;
      }
      const system = `당신은 광덕 교사들을 돕는 교육 행정 AI 비서입니다.
현재 폴더: "${folder?.name}"

[답변 원칙]
1. 반드시 업로드된 문서 내용을 근거로 답변하세요.
2. 출처 파일명을 명시하세요 (예: "[규정.pdf]에 따르면...").
3. 문서에 없는 내용은 "제공된 문서에서 확인이 어렵습니다"라고 답하세요.
4. 명확하고 친절한 어조로 실무에 바로 활용할 수 있게 답변하세요.

[문서 내용]
${ctx.substring(0, 30000)}`;

      const stream = await ai.models.generateContentStream({
        model: MODEL,
        contents: [{ parts: [{ text: msg }] }],
        config: { systemInstruction: system },
      });
      let full = '';
      setMessages(prev => [...prev, { role: 'bot', content: '', ts: Date.now() }]);
      for await (const chunk of stream) {
        full += chunk.text ?? '';
        setMessages(prev => {
          const a = [...prev];
          a[a.length - 1] = { ...a[a.length - 1], content: full };
          return a;
        });
      }
    } catch (e: any) {
      setError(e.message ?? 'AI 오류가 발생했습니다.');
      setMessages(prev => {
        const last = prev[prev.length - 1];
        return last?.role === 'bot' && !last.content ? prev.slice(0, -1) : prev;
      });
    } finally { setLoading(false); }
  };

  // ── Refresh last response ─────────────────────────────────
  const refreshLast = () => {
    if (loading) return;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        const text = messages[i].content;
        setMessages(messages.slice(0, i));
        setTimeout(() => sendMessage(text), 30);
        return;
      }
    }
  };

  // ── Folder / file ops ─────────────────────────────────────
  const addFolder = () => {
    const name = newName.trim();
    if (!name) return;
    const nf: FolderData = { id: crypto.randomUUID(), name, files: [] };
    setFolders(prev => [...prev, nf]);
    setFolderId(nf.id);
    setAddingFolder(false); setNewName('');
  };

  const deleteFolder = (id: string) => {
    if (folders.length <= 1) { setError('마지막 폴더는 삭제할 수 없습니다.'); return; }
    if (!confirm('폴더와 모든 파일을 삭제할까요?')) return;
    const rest = folders.filter(f => f.id !== id);
    setFolders(rest);
    if (folderId === id) setFolderId(rest[0].id);
  };

  const deleteFile = (fileId: string) => {
    setFolders(prev => prev.map(f =>
      f.id === folderId ? { ...f, files: f.files.filter(fl => fl.id !== fileId) } : f
    ));
  };

  // ── Chat ops ──────────────────────────────────────────────
  const clearChat = () => {
    if (!messages.length || !confirm('대화 내용을 모두 삭제할까요?')) return;
    setMessages([]); setShowHistory(false);
  };

  const exportChat = () => {
    if (!messages.length) return;
    const txt = messages.map(m =>
      `[${new Date(m.ts).toLocaleString('ko-KR')}] ${m.role === 'user' ? '교사' : 'AI'}\n${m.content}`
    ).join('\n\n─────────────\n\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain;charset=utf-8' }));
    a.download = `대화기록_${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(a.href);
  };

  const copyMsg = (content: string, idx: number) => {
    navigator.clipboard.writeText(content).then(() => {
      setCopiedIdx(idx); setTimeout(() => setCopiedIdx(null), 2000);
    });
  };

  const shareApp = () => {
    navigator.clipboard.writeText(window.location.href);
    setShareOk(true); setTimeout(() => setShareOk(false), 2500);
  };

  // ── Dev mode ─────────────────────────────────────────────
  const requestUpload = () => {
    if (!devMode) { setShowDevModal(true); return; }
    if (folders.length > 1) {
      setShowFolderPicker(true);
    } else {
      setUploadTarget(folders[0].id);
      fileRef.current?.click();
    }
  };

  const confirmDevPassword = () => {
    if (devPwInput === DEV_PASSWORD) {
      setDevMode(true);
      sessionStorage.setItem('gd-dev', '1');
      setShowDevModal(false);
      setDevPwInput('');
      setDevPwError(false);
      setTimeout(() => fileRef.current?.click(), 100);
    } else {
      setDevPwError(true);
      setDevPwInput('');
    }
  };

  const exitDevMode = () => {
    setDevMode(false);
    sessionStorage.removeItem('gd-dev');
  };

  // ── Voice input ───────────────────────────────────────────
  const toggleVoice = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { setError('이 브라우저는 음성 인식을 지원하지 않습니다.'); return; }
    if (listening) { recRef.current?.stop(); setListening(false); return; }
    const r = new SR();
    r.lang = 'ko-KR'; r.continuous = false; r.interimResults = false;
    r.onstart = () => setListening(true);
    r.onend   = () => setListening(false);
    r.onerror = () => setListening(false);
    r.onresult = (ev: any) => setInput(p => p + ev.results[0][0].transcript);
    recRef.current = r; r.start();
  };

  // ── Auto-resize textarea ──────────────────────────────────
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  // ── Render ────────────────────────────────────────────────
  const bg   = d('bg-gray-50',   'bg-gray-950');
  const text = d('text-gray-900','text-gray-100');
  const sidebar_bg = d('bg-white',  'bg-gray-900');
  const sidebar_border = d('border-gray-200', 'border-gray-800');
  const card = d('bg-white', 'bg-gray-800');
  const muted = d('text-gray-500','text-gray-400');
  const hover_light = d('hover:bg-gray-100','hover:bg-gray-800');

  return (
    <div
      className={`flex h-screen overflow-hidden font-sans ${bg} ${text} transition-colors`}
      style={{ fontFamily: "'Pretendard Variable', 'Pretendard', system-ui, sans-serif" }}
      onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
    >

      {/* ── Drag overlay ── */}
      <AnimatePresence>
        {drag && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-blue-600/90 backdrop-blur-sm flex flex-col items-center justify-center pointer-events-none"
          >
            <div className="border-4 border-dashed border-white/60 rounded-[48px] p-16 text-center text-white">
              <Upload className="w-16 h-16 mx-auto mb-4" />
              <p className="text-2xl font-bold">PDF 파일을 여기에 놓으세요</p>
              <p className="mt-2 opacity-80">"{folder?.name}" 폴더에 추가됩니다</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Error toast ── */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }}
            className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-red-600 text-white px-4 py-3 rounded-2xl shadow-xl flex items-center gap-2 max-w-md w-full mx-4"
          >
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span className="text-sm flex-1">{error}</span>
            <button onClick={() => setError(null)}><X className="w-4 h-4 opacity-70 hover:opacity-100" /></button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Processing overlay ── */}
      <AnimatePresence>
        {processing && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm flex items-center justify-center"
          >
            <div className={`${card} p-8 rounded-3xl shadow-2xl flex flex-col items-center gap-4`}>
              <Loader2 className="w-10 h-10 text-blue-500 animate-spin" />
              <p className="font-bold">PDF 분석 중...</p>
              <p className={`text-sm ${muted}`}>텍스트를 추출하고 있습니다</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Folder picker modal ── */}
      <AnimatePresence>
        {showFolderPicker && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={() => setShowFolderPicker(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className={`${card} w-full max-w-sm rounded-3xl shadow-2xl p-6`}
            >
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 bg-blue-600 rounded-2xl flex items-center justify-center">
                  <Folder className="w-5 h-5 text-white" />
                </div>
                <div>
                  <p className="font-bold">폴더 선택</p>
                  <p className={`text-xs ${muted}`}>파일을 추가할 폴더를 선택하세요</p>
                </div>
              </div>
              <div className="space-y-2 mb-4">
                {folders.map(f => (
                  <button
                    key={f.id}
                    onClick={() => {
                      setUploadTarget(f.id);
                      setShowFolderPicker(false);
                      setTimeout(() => fileRef.current?.click(), 100);
                    }}
                    className={`w-full flex items-center gap-3 px-4 py-3 rounded-2xl border text-left transition-all ${
                      f.id === folderId
                        ? 'border-blue-500 bg-blue-50 text-blue-700'
                        : d('border-gray-200 hover:border-blue-300 hover:bg-blue-50','border-gray-700 hover:border-blue-600 hover:bg-blue-950/20')
                    }`}
                  >
                    <Folder className={`w-4 h-4 shrink-0 ${f.id === folderId ? 'text-blue-600' : 'text-gray-400'}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate">{f.name}</p>
                      <p className={`text-[10px] ${muted}`}>파일 {f.files.length}개</p>
                    </div>
                    {f.id === folderId && <Check className="w-4 h-4 text-blue-600 shrink-0" />}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setShowFolderPicker(false)}
                className={`w-full py-2.5 rounded-2xl text-sm font-semibold ${d('bg-gray-100 hover:bg-gray-200 text-gray-700','bg-gray-700 hover:bg-gray-600 text-gray-300')}`}
              >취소</button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Dev password modal ── */}
      <AnimatePresence>
        {showDevModal && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={() => { setShowDevModal(false); setDevPwInput(''); setDevPwError(false); }}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className={`${card} w-full max-w-sm rounded-3xl shadow-2xl p-6`}
            >
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 bg-blue-600 rounded-2xl flex items-center justify-center">
                  <Lock className="w-5 h-5 text-white" />
                </div>
                <div>
                  <p className="font-bold">관리자 인증</p>
                  <p className={`text-xs ${muted}`}>파일 업로드 권한이 필요합니다</p>
                </div>
              </div>
              <input
                autoFocus
                type="password"
                value={devPwInput}
                onChange={e => { setDevPwInput(e.target.value); setDevPwError(false); }}
                onKeyDown={e => e.key === 'Enter' && confirmDevPassword()}
                placeholder="비밀번호 입력..."
                className={`w-full px-4 py-3 rounded-2xl border outline-none text-sm mb-2 ${
                  devPwError
                    ? 'border-red-400 bg-red-50 text-red-700'
                    : d('border-gray-200 bg-gray-50 focus:border-blue-400','border-gray-700 bg-gray-800 focus:border-blue-500')
                }`}
              />
              {devPwError && <p className="text-xs text-red-500 mb-3 px-1">비밀번호가 틀렸습니다.</p>}
              <div className="flex gap-2 mt-4">
                <button
                  onClick={() => { setShowDevModal(false); setDevPwInput(''); setDevPwError(false); }}
                  className={`flex-1 py-2.5 rounded-2xl text-sm font-semibold ${d('bg-gray-100 hover:bg-gray-200 text-gray-700','bg-gray-700 hover:bg-gray-600 text-gray-300')}`}
                >취소</button>
                <button
                  onClick={confirmDevPassword}
                  className="flex-1 py-2.5 rounded-2xl text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white"
                >확인</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── History modal ── */}
      <AnimatePresence>
        {showHistory && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={() => setShowHistory(false)}
          >
            <motion.div
              initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.96, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className={`${card} w-full max-w-2xl max-h-[80vh] rounded-3xl shadow-2xl flex flex-col overflow-hidden`}
            >
              <div className={`flex items-center justify-between px-5 py-4 border-b ${sidebar_border}`}>
                <div className="flex items-center gap-2">
                  <History className="w-5 h-5 text-blue-500" />
                  <span className="font-bold">대화 기록</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${d('bg-gray-100 text-gray-500','bg-gray-700 text-gray-400')}`}>{messages.length}개</span>
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={exportChat} disabled={!messages.length}
                    className={`flex items-center gap-1 px-3 py-1.5 text-xs rounded-xl font-semibold disabled:opacity-40 ${d('bg-blue-50 text-blue-600 hover:bg-blue-100','bg-blue-900/30 text-blue-400 hover:bg-blue-900/50')}`}>
                    <Download className="w-3.5 h-3.5" />내보내기
                  </button>
                  <button onClick={() => window.print()}
                    className={`flex items-center gap-1 px-3 py-1.5 text-xs rounded-xl font-semibold ${d('bg-gray-100 text-gray-600 hover:bg-gray-200','bg-gray-700 text-gray-300 hover:bg-gray-600')}`}>
                    <Printer className="w-3.5 h-3.5" />인쇄
                  </button>
                  <button onClick={clearChat} disabled={!messages.length}
                    className={`flex items-center gap-1 px-3 py-1.5 text-xs rounded-xl font-semibold disabled:opacity-40 ${d('bg-red-50 text-red-600 hover:bg-red-100','bg-red-900/30 text-red-400 hover:bg-red-900/50')}`}>
                    <Trash2 className="w-3.5 h-3.5" />삭제
                  </button>
                  <button onClick={() => setShowHistory(false)} className={`p-1.5 rounded-xl ${hover_light}`}>
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-2 hide-scrollbar">
                {messages.length === 0 ? (
                  <div className="text-center py-16">
                    <MessageSquare className={`w-12 h-12 mx-auto mb-3 ${d('text-gray-200','text-gray-700')}`} />
                    <p className={muted}>대화 기록이 없습니다</p>
                  </div>
                ) : messages.map((m, i) => (
                  <div key={i}
                    className={`p-3 rounded-xl text-sm ${m.role === 'user'
                      ? d('bg-blue-50 text-blue-900','bg-blue-950/40 text-blue-200') + ' ml-6'
                      : d('bg-gray-50 text-gray-700','bg-gray-800 text-gray-300') + ' mr-6'}`}>
                    <p className={`text-[10px] font-bold mb-1 ${m.role === 'user' ? 'text-blue-500' : muted}`}>
                      {m.role === 'user' ? '교사' : 'AI'} · {new Date(m.ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                    </p>
                    <p className="line-clamp-2 leading-relaxed">{m.content}</p>
                  </div>
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ═══════════════════════════════════════════════
          SIDEBAR
      ═══════════════════════════════════════════════ */}
      <AnimatePresence>
        {sidebarOpen && (
          <motion.aside
            initial={{ x: -280, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -280, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className={`w-72 shrink-0 flex flex-col border-r ${sidebar_bg} ${sidebar_border} z-30 relative`}
          >
            {/* Sidebar header */}
            <div className={`flex items-center justify-between px-4 py-4 border-b ${sidebar_border}`}>
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 bg-blue-600 rounded-xl flex items-center justify-center">
                  <Sparkles className="w-4 h-4 text-white" />
                </div>
                <div>
                  <p className="text-sm font-bold leading-tight">광덕 AI 비서</p>
                  <p className={`text-[10px] ${muted}`}>교육 행정 어시스턴트</p>
                </div>
              </div>
              <button onClick={() => setSidebarOpen(false)} className={`p-1.5 rounded-xl ${hover_light}`}>
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Folders */}
            <div className="flex-1 overflow-y-auto hide-scrollbar">
              <div className="p-3">
                <div className="flex items-center justify-between mb-2 px-1">
                  <p className={`text-[11px] font-semibold uppercase tracking-wider ${muted}`}>폴더</p>
                  <button
                    onClick={() => setAddingFolder(v => !v)}
                    className={`p-1 rounded-lg ${hover_light}`}
                    title="새 폴더 추가"
                  >
                    <FolderPlus className="w-4 h-4 text-blue-500" />
                  </button>
                </div>

                {/* New folder input */}
                <AnimatePresence>
                  {addingFolder && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden mb-2"
                    >
                      <div className="flex gap-1 p-1">
                        <input
                          autoFocus
                          value={newName}
                          onChange={e => setNewName(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') addFolder(); if (e.key === 'Escape') { setAddingFolder(false); setNewName(''); } }}
                          placeholder="폴더 이름..."
                          className={`flex-1 text-sm px-3 py-1.5 rounded-xl border outline-none ${d('bg-gray-50 border-gray-200 focus:border-blue-400','bg-gray-800 border-gray-700 focus:border-blue-500')}`}
                        />
                        <button onClick={addFolder} className="px-2 py-1.5 bg-blue-600 text-white rounded-xl text-xs font-bold hover:bg-blue-700">
                          추가
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Folder list */}
                {folders.map(f => (
                  <div
                    key={f.id}
                    className={`group flex items-center justify-between px-3 py-2.5 rounded-xl mb-1 cursor-pointer transition-all ${
                      f.id === folderId
                        ? d('bg-blue-600 text-white', 'bg-blue-600 text-white')
                        : d('hover:bg-gray-100 text-gray-700', 'hover:bg-gray-800 text-gray-300')
                    }`}
                    onClick={() => setFolderId(f.id)}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Folder className="w-4 h-4 shrink-0" />
                      <span className="text-sm font-medium truncate">{f.name}</span>
                      <span className={`text-[10px] shrink-0 px-1.5 py-0.5 rounded-full font-bold ${
                        f.id === folderId ? 'bg-white/20 text-white' : d('bg-gray-100 text-gray-500','bg-gray-700 text-gray-400')
                      }`}>{f.files.length}</span>
                    </div>
                    {folders.length > 1 && (
                      <button
                        onClick={e => { e.stopPropagation(); deleteFolder(f.id); }}
                        className={`opacity-0 group-hover:opacity-100 p-0.5 rounded ${f.id === folderId ? 'hover:bg-white/20' : hover_light}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {/* Files in active folder */}
              <div className="p-3 pt-0">
                <div className="flex items-center justify-between mb-2 px-1">
                  <p className={`text-[11px] font-semibold uppercase tracking-wider ${muted}`}>파일</p>
                  {devMode && (
                    <button
                      onClick={requestUpload}
                      className={`p-1 rounded-lg ${hover_light}`}
                      title="PDF 업로드"
                    >
                      <Plus className="w-4 h-4 text-blue-500" />
                    </button>
                  )}
                </div>
                <input ref={fileRef} type="file" accept=".pdf" multiple className="hidden" onChange={e => { if (e.target.files?.length) uploadFiles(Array.from(e.target.files), uploadTarget || folderId); }} />

                {(folder?.files ?? []).length === 0 ? (
                  devMode ? (
                    <button
                      onClick={requestUpload}
                      className={`w-full py-6 rounded-2xl border-2 border-dashed flex flex-col items-center gap-2 transition-all ${d('border-gray-200 hover:border-blue-300 text-gray-400 hover:text-blue-500','border-gray-700 hover:border-blue-600 text-gray-600 hover:text-blue-400')}`}
                    >
                      <Upload className="w-6 h-6" />
                      <span className="text-xs font-medium">PDF 업로드</span>
                      <span className={`text-[10px] ${muted}`}>클릭 또는 드래그</span>
                    </button>
                  ) : (
                    <div className={`w-full py-6 rounded-2xl border-2 border-dashed flex flex-col items-center gap-2 ${d('border-gray-100 text-gray-300','border-gray-800 text-gray-700')}`}>
                      <Lock className="w-6 h-6" />
                      <span className="text-xs font-medium">관리자 전용</span>
                    </div>
                  )
                ) : (
                  <div className="space-y-1">
                    {folder.files.map(fl => (
                      <div key={fl.id}
                        className={`group flex items-center gap-2 px-3 py-2 rounded-xl ${d('hover:bg-gray-50','hover:bg-gray-800/50')}`}>
                        <FileText className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                        <span className={`text-xs flex-1 truncate ${muted}`}>{fl.name}</span>
                        <button
                          onClick={() => deleteFile(fl.id)}
                          className={`opacity-0 group-hover:opacity-100 p-0.5 rounded ${hover_light}`}
                        >
                          <X className="w-3 h-3 text-red-400" />
                        </button>
                      </div>
                    ))}
                    {devMode && (
                      <button
                        onClick={requestUpload}
                        className={`w-full flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-medium text-blue-500 ${d('hover:bg-blue-50','hover:bg-blue-950/30')} transition-all`}
                      >
                        <Plus className="w-3.5 h-3.5" />파일 추가
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Sidebar footer: settings */}
            <div className={`p-3 border-t ${sidebar_border} space-y-1`}>
              {/* Dark mode */}
              <div className={`flex items-center justify-between px-3 py-2 rounded-xl ${hover_light}`}>
                <span className={`text-xs font-medium ${muted}`}>{dark ? '다크 모드' : '라이트 모드'}</span>
                <button
                  onClick={() => setTheme(t => t === 'light' ? 'dark' : 'light')}
                  className={`w-12 h-6 rounded-full transition-colors relative ${dark ? 'bg-blue-600' : 'bg-gray-200'}`}
                >
                  <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${dark ? 'translate-x-6' : 'translate-x-0.5'} flex items-center justify-center`}>
                    {dark ? <Moon className="w-2.5 h-2.5 text-blue-600" /> : <Sun className="w-2.5 h-2.5 text-yellow-500" />}
                  </span>
                </button>
              </div>
              {/* Font size */}
              <div className={`flex items-center justify-between px-3 py-2 rounded-xl ${hover_light}`}>
                <span className={`text-xs font-medium ${muted}`}>글자 크기 ({fontSize}px)</span>
                <div className="flex items-center gap-1">
                  <button onClick={() => setFontSize(s => Math.max(12, s - 1))} className={`p-1 rounded-lg ${hover_light}`}><ZoomOut className="w-4 h-4" /></button>
                  <button onClick={() => setFontSize(s => Math.min(22, s + 1))} className={`p-1 rounded-lg ${hover_light}`}><ZoomIn className="w-4 h-4" /></button>
                </div>
              </div>
              {/* Share */}
              <div className="relative">
                <button
                  onClick={shareApp}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-xl ${hover_light} transition-all`}
                >
                  <span className={`text-xs font-medium ${muted}`}>앱 링크 공유</span>
                  {shareOk ? <Check className="w-4 h-4 text-green-500" /> : <Share2 className="w-4 h-4 text-blue-500" />}
                </button>
                <AnimatePresence>
                  {shareOk && (
                    <motion.div
                      initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                      className="absolute bottom-full mb-2 left-3 bg-gray-900 text-white text-[10px] px-2 py-1 rounded-lg whitespace-nowrap"
                    >링크 복사됨!</motion.div>
                  )}
                </AnimatePresence>
              </div>
              {/* Dev mode toggle */}
              <button
                onClick={() => devMode ? exitDevMode() : setShowDevModal(true)}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-xl transition-all ${devMode ? d('bg-green-50 hover:bg-green-100','bg-green-950/30 hover:bg-green-950/50') : hover_light}`}
              >
                <span className={`text-xs font-medium ${devMode ? 'text-green-600' : muted}`}>
                  {devMode ? '관리자 모드 활성' : '관리자 로그인'}
                </span>
                {devMode ? <LockOpen className="w-4 h-4 text-green-500" /> : <Lock className={`w-4 h-4 ${muted}`} />}
              </button>
              {/* Copyright */}
              <p className={`text-[9px] text-center px-3 py-1 ${muted} opacity-60`}>
                © 2026 광덕고등학교 조일웅 All Rights Reserved
              </p>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* ═══════════════════════════════════════════════
          MAIN CHAT AREA
      ═══════════════════════════════════════════════ */}
      <main className="flex-1 flex flex-col min-w-0">

        {/* Header */}
        <nav className={`flex items-center justify-between px-4 py-3 border-b ${sidebar_border} ${d('bg-white','bg-gray-900')} shrink-0 no-print`}>
          <div className="flex items-center gap-3">
            <button onClick={() => setSidebarOpen(v => !v)} className={`p-2 rounded-xl ${hover_light}`}>
              <Menu className="w-5 h-5" />
            </button>
            <div>
              <h1 className="font-bold text-sm leading-tight">{folder?.name ?? '광덕고 AI 비서'}</h1>
              <p className={`text-[10px] ${muted}`}>{folder?.files.length ?? 0}개 파일</p>
            </div>
          </div>

          <div className="flex items-center gap-0.5">
            <button onClick={refreshLast} disabled={!messages.length || loading} title="마지막 답변 재생성"
              className={`p-2 rounded-xl disabled:opacity-30 ${hover_light}`}>
              <RefreshCw className="w-4 h-4" />
            </button>
            <button onClick={() => messages.length && window.print()} disabled={!messages.length} title="인쇄"
              className={`p-2 rounded-xl disabled:opacity-30 ${hover_light}`}>
              <Printer className="w-4 h-4" />
            </button>
            <button onClick={exportChat} disabled={!messages.length} title="대화 내보내기"
              className={`p-2 rounded-xl disabled:opacity-30 ${hover_light}`}>
              <Download className="w-4 h-4" />
            </button>
            <button onClick={clearChat} disabled={!messages.length} title="대화 삭제"
              className={`p-2 rounded-xl disabled:opacity-30 ${d('hover:bg-red-50 text-red-400 hover:text-red-600','hover:bg-red-950/20 text-red-500')}`}>
              <Trash2 className="w-4 h-4" />
            </button>
            <div className={`w-px h-5 mx-1 ${d('bg-gray-200','bg-gray-700')}`} />
            <button onClick={() => setShowHistory(true)} title="대화 기록"
              className={`p-2 rounded-xl ${hover_light}`}>
              <History className="w-4 h-4" />
            </button>
            <div className="relative">
              <button onClick={shareApp} title="공유"
                className={`p-2 rounded-xl ${hover_light}`}>
                {shareOk ? <Check className="w-4 h-4 text-green-500" /> : <Share2 className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </nav>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto hide-scrollbar p-4 md:p-6">
          {messages.length === 0 ? (
            /* Empty state */
            <div className="max-w-2xl mx-auto mt-8 text-center">
              <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full mb-5 text-[10px] font-bold uppercase tracking-widest ${d('bg-blue-50 text-blue-500 border border-blue-100','bg-blue-950/40 text-blue-400 border border-blue-900')}`}>
                <Sparkles className="w-3 h-3" />AI-Powered
              </div>
              <h1 className={`text-4xl font-light tracking-tight mb-3 ${d('text-gray-900','text-white')}`}>
                광덕 <span className="font-bold text-blue-600">교육 비서</span>
              </h1>
              <p className={`text-sm mb-8 ${muted}`}>PDF 문서를 업로드하고 AI에게 무엇이든 물어보세요</p>
              <div className="grid grid-cols-2 gap-3 text-left">
                {[
                  { icon: Sparkles,      color: 'text-blue-500',   bg: d('bg-blue-50','bg-blue-950/30'),   title: '문서 요약',    desc: '업로드된 PDF 핵심 내용을 요약합니다',         q: '현재 문서들을 요약해줘.' },
                  { icon: FileSearch,    color: 'text-green-500',  bg: d('bg-green-50','bg-green-950/30'), title: '내용 검색',    desc: '문서에서 특정 내용을 찾아드립니다',           q: '문서에서 중요한 규정을 찾아줘.' },
                  { icon: LayoutGrid,    color: 'text-purple-500', bg: d('bg-purple-50','bg-purple-950/30'),title: '비교 분석',   desc: '여러 문서의 차이점을 비교합니다',             q: '문서들의 주요 차이점을 비교해줘.' },
                  { icon: MessageSquare, color: 'text-orange-500', bg: d('bg-orange-50','bg-orange-950/30'),title: '자유 질의',   desc: '문서에 대해 자유롭게 질문하세요',             q: '교사들이 꼭 알아야 할 내용은 무엇인가요?' },
                ].map((item, i) => (
                  <motion.button key={i}
                    initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.07 }}
                    onClick={() => sendMessage(item.q)}
                    className={`p-4 rounded-2xl border text-left transition-all ${d(
                      'bg-white border-gray-100 hover:border-blue-200 hover:shadow-lg',
                      'bg-gray-900 border-gray-800 hover:border-blue-700 hover:bg-gray-800'
                    )}`}
                  >
                    <div className={`w-9 h-9 ${item.bg} rounded-xl flex items-center justify-center mb-3`}>
                      <item.icon className={`w-4 h-4 ${item.color}`} />
                    </div>
                    <p className={`font-bold text-sm mb-1 ${d('text-gray-900','text-white')}`}>{item.title}</p>
                    <p className={`text-xs ${muted}`}>{item.desc}</p>
                  </motion.button>
                ))}
              </div>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto space-y-5">
              {messages.map((m, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`flex gap-3 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}
                >
                  {/* Avatar */}
                  <div className={`shrink-0 w-8 h-8 rounded-2xl flex items-center justify-center ${
                    m.role === 'user'
                      ? 'bg-blue-600'
                      : d('bg-gray-100','bg-gray-800')
                  }`}>
                    {m.role === 'user'
                      ? <User className="w-4 h-4 text-white" />
                      : <Bot className={`w-4 h-4 ${d('text-gray-600','text-gray-300')}`} />
                    }
                  </div>
                  {/* Bubble */}
                  <div className={`group relative max-w-[80%] ${m.role === 'user' ? 'items-end' : 'items-start'} flex flex-col`}>
                    <div className={`px-4 py-3 rounded-2xl ${
                      m.role === 'user'
                        ? 'bg-blue-600 text-white rounded-tr-sm'
                        : d('bg-white border border-gray-100 text-gray-800','bg-gray-800 border border-gray-700 text-gray-100') + ' rounded-tl-sm'
                    }`}
                      style={{ fontSize: `${fontSize}px` }}
                    >
                      {m.role === 'user' ? (
                        <p className="whitespace-pre-wrap leading-relaxed">{m.content}</p>
                      ) : (
                        <div className="prose">
                          <ReactMarkdown>{m.content || '▋'}</ReactMarkdown>
                        </div>
                      )}
                    </div>
                    {/* Timestamp + copy */}
                    <div className={`flex items-center gap-2 mt-1 px-1 opacity-0 group-hover:opacity-100 transition-opacity ${m.role === 'user' ? 'flex-row-reverse' : ''}`}>
                      <span className={`text-[10px] ${muted}`}>
                        {new Date(m.ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      {m.role === 'bot' && m.content && (
                        <button onClick={() => copyMsg(m.content, i)} className={`p-0.5 rounded ${hover_light}`}>
                          {copiedIdx === i
                            ? <Check className="w-3 h-3 text-green-500" />
                            : <Copy className={`w-3 h-3 ${muted}`} />
                          }
                        </button>
                      )}
                    </div>
                  </div>
                </motion.div>
              ))}

              {/* Loading indicator */}
              {loading && (
                <div className="flex gap-3">
                  <div className={`w-8 h-8 rounded-2xl flex items-center justify-center ${d('bg-gray-100','bg-gray-800')}`}>
                    <Bot className={`w-4 h-4 ${d('text-gray-600','text-gray-300')}`} />
                  </div>
                  <div className={`px-4 py-3 rounded-2xl rounded-tl-sm ${d('bg-white border border-gray-100','bg-gray-800 border border-gray-700')}`}>
                    <div className="flex gap-1 items-center h-5">
                      {[0, 1, 2].map(i => (
                        <motion.div key={i}
                          animate={{ y: [0, -4, 0] }}
                          transition={{ duration: 0.6, repeat: Infinity, delay: i * 0.15 }}
                          className="w-1.5 h-1.5 rounded-full bg-blue-500"
                        />
                      ))}
                    </div>
                  </div>
                </div>
              )}
              <div ref={endRef} />
            </div>
          )}
        </div>

        {/* Input area */}
        <div className={`p-4 border-t ${sidebar_border} ${d('bg-white','bg-gray-900')} shrink-0 no-print`}>
          <div className="max-w-3xl mx-auto">
            <div className={`flex items-end gap-2 px-4 py-3 rounded-2xl border transition-all ${d(
              'bg-gray-50 border-gray-200 focus-within:border-blue-400 focus-within:bg-white',
              'bg-gray-800 border-gray-700 focus-within:border-blue-500'
            )}`}>
              {/* Attach PDF (관리자만) */}
              <button
                onClick={requestUpload}
                className={`shrink-0 p-1.5 rounded-xl ${hover_light} mb-0.5`}
                title={devMode ? 'PDF 업로드' : '관리자 전용'}
              >
                <Paperclip className={`w-4 h-4 ${devMode ? 'text-blue-500' : muted}`} />
              </button>
              {/* Textarea */}
              <textarea
                ref={inputRef}
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder={folder?.files.length ? '문서에 대해 질문하세요... (Enter: 전송, Shift+Enter: 줄바꿈)' : 'PDF를 먼저 업로드하세요...'}
                rows={1}
                className={`flex-1 resize-none bg-transparent outline-none text-sm leading-relaxed ${d('placeholder:text-gray-400','placeholder:text-gray-600')}`}
                style={{ fontSize: `${fontSize}px`, maxHeight: '160px' }}
              />
              {/* Voice */}
              <button
                onClick={toggleVoice}
                className={`shrink-0 p-1.5 rounded-xl mb-0.5 ${listening ? 'bg-red-100 text-red-600' : hover_light}`}
                title="음성 입력"
              >
                {listening ? <MicOff className="w-4 h-4 text-red-500" /> : <Mic className="w-4 h-4 text-gray-400" />}
              </button>
              {/* Send */}
              <button
                onClick={() => sendMessage()}
                disabled={!input.trim() || loading}
                className="shrink-0 w-8 h-8 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl flex items-center justify-center transition-all mb-0.5"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUp className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
