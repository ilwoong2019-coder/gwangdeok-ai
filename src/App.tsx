import React, { useState, useRef, useEffect, useMemo } from 'react';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import ReactMarkdown from 'react-markdown';
import { createClient } from '@supabase/supabase-js';
import {
  Upload, FileText, Trash2, Plus, FolderPlus, X, Menu,
  Download, Copy, Check, Mic, MicOff, Sun, Moon,
  ZoomIn, ZoomOut, ArrowUp, Share2, Folder,
  RefreshCw, Bot, User, Loader2, AlertCircle, Sparkles,
  MessageSquare, FileSearch, LayoutGrid, Paperclip,
  Lock, LockOpen, Printer, AlertTriangle, Settings2, Pencil,
  Users, UserCheck, UserX, UserMinus, Search, BarChart3,
  CheckSquare, Square, LogOut, ShieldCheck, Clock, ChevronDown,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// ── PDF.js 지연 로딩 (관리자 업로드 시에만 필요) ─────────────
let _pdfjs: typeof import('pdfjs-dist') | null = null;
const getPdfjs = async () => {
  if (!_pdfjs) {
    _pdfjs = await import('pdfjs-dist');
    _pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
  }
  return _pdfjs;
};

// ── Types ─────────────────────────────────────────────────
interface FileData   { id: string; name: string; text: string; }
interface FolderData { id: string; name: string; files: FileData[]; }
interface Message    { role: 'user' | 'bot'; content: string; ts: number; }
interface ConfirmDlg { msg: string; onConfirm: () => void; }

type UserStatus  = 'pending' | 'active' | 'inactive' | 'rejected';
type Affiliation = 'middle' | 'high';
interface AppUser {
  id:             string;
  name:           string;
  affiliation:    Affiliation;
  password_hash?: string;   // localStorage 세션에는 저장하지 않음
  status:         UserStatus;
  created_at:     string;
  approved_at?:   string;
}

// ── Constants ─────────────────────────────────────────────
const MODEL            = 'llama-3.3-70b-versatile';
const DEV_PASSWORD     = (import.meta as any).env?.VITE_ADMIN_PASSWORD as string || 'ilwoong11!';
const PW_SALT          = 'gwangdeok-ai-2026-secure';
const MAX_FILE_MB      = 20;
const MAX_CONTEXT_CHARS = 100000;
const MAX_HISTORY_MSGS = 20; // 최근 10턴
const LS = {
  folders:  'gd2-folders',
  folderId: 'gd2-folder',
  messages: 'gd2-messages',
  theme:    'gd2-theme',
  size:     'gd2-size',
  sidebar:  'gd2-sidebar',
  user:     'gd2-user-session',
  usersData:'gd2-users-data',
};
const DEFAULT_FOLDER: FolderData = { id: 'default', name: '학교 규정 및 자료', files: [] };

// ── Supabase (클라우드 동기화) ────────────────────────────────
const SB_URL = (import.meta as any).env?.VITE_SUPABASE_URL as string | undefined;
const SB_KEY = (import.meta as any).env?.VITE_SUPABASE_ANON_KEY as string | undefined;
const supabase = SB_URL && SB_KEY ? createClient(SB_URL, SB_KEY) : null;

async function sbLoadFolders(): Promise<FolderData[] | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('app_data')
      .select('value')
      .eq('key', 'folders')
      .maybeSingle();
    if (error || !data) return null;
    return data.value as FolderData[];
  } catch { return null; }
}

async function sbSaveFolders(folders: FolderData[]): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from('app_data').upsert({
      key: 'folders',
      value: folders,
      updated_at: new Date().toISOString(),
    });
  } catch (e) { console.error('Supabase 동기화 오류:', e); }
}

// ── 비밀번호 해시 (SHA-256 + 고정 솔트) ─────────────────────
async function hashPassword(pw: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(PW_SALT + pw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── 사용자 관리 Supabase/LocalStorage 함수 ───────────────────
// 로컬 fallback: Supabase 미설정 시 gd2-users-data 키 사용
function _lsUsers(): AppUser[] { try { const v = localStorage.getItem(LS.usersData); return v ? JSON.parse(v) : []; } catch { return []; } }
function _lsSaveUsers(users: AppUser[]) { try { localStorage.setItem(LS.usersData, JSON.stringify(users)); } catch {} }

async function sbLoadUsers(): Promise<AppUser[]> {
  if (!supabase) return _lsUsers();
  try {
    const { data, error } = await supabase.from('gd_users').select('*').order('created_at', { ascending: true });
    if (error || !data) return [];
    return data as AppUser[];
  } catch { return []; }
}

async function sbRegisterUser(name: string, affiliation: Affiliation, passwordHash: string): Promise<AppUser | null> {
  if (!supabase) {
    const users = _lsUsers();
    const newUser: AppUser = { id: crypto.randomUUID(), name, affiliation, password_hash: passwordHash, status: 'pending', created_at: new Date().toISOString() };
    _lsSaveUsers([...users, newUser]);
    return newUser;
  }
  try {
    const { data, error } = await supabase.from('gd_users')
      .insert({ name, affiliation, password_hash: passwordHash, status: 'pending' })
      .select().single();
    if (error || !data) return null;
    return data as AppUser;
  } catch { return null; }
}

async function sbFindUser(name: string, affiliation: Affiliation, passwordHash: string): Promise<AppUser | null> {
  if (!supabase) {
    return _lsUsers().find(u => u.name === name && u.affiliation === affiliation && u.password_hash === passwordHash) ?? null;
  }
  try {
    const { data, error } = await supabase.from('gd_users').select('*')
      .eq('name', name).eq('affiliation', affiliation).eq('password_hash', passwordHash).maybeSingle();
    if (error || !data) return null;
    return data as AppUser;
  } catch { return null; }
}

async function sbGetUserById(id: string): Promise<AppUser | null> {
  if (!supabase) return _lsUsers().find(u => u.id === id) ?? null;
  try {
    const { data, error } = await supabase.from('gd_users').select('*').eq('id', id).maybeSingle();
    if (error || !data) return null;
    return data as AppUser;
  } catch { return null; }
}

async function sbUpdateUserStatus(id: string, status: UserStatus): Promise<boolean> {
  const updates: Partial<AppUser> = { status, ...(status === 'active' ? { approved_at: new Date().toISOString() } : {}) };
  if (!supabase) { _lsSaveUsers(_lsUsers().map(u => u.id === id ? { ...u, ...updates } : u)); return true; }
  try {
    const { error } = await supabase.from('gd_users').update(updates).eq('id', id);
    return !error;
  } catch { return false; }
}

async function sbBulkUpdateStatus(ids: string[], status: UserStatus): Promise<boolean> {
  const updates: Partial<AppUser> = { status, ...(status === 'active' ? { approved_at: new Date().toISOString() } : {}) };
  if (!supabase) { _lsSaveUsers(_lsUsers().map(u => ids.includes(u.id) ? { ...u, ...updates } : u)); return true; }
  try {
    const { error } = await supabase.from('gd_users').update(updates).in('id', ids);
    return !error;
  } catch { return false; }
}

async function sbDeleteUserRecord(id: string): Promise<boolean> {
  if (!supabase) { _lsSaveUsers(_lsUsers().filter(u => u.id !== id)); return true; }
  try {
    const { error } = await supabase.from('gd_users').delete().eq('id', id);
    return !error;
  } catch { return false; }
}

async function sbCheckNameExists(name: string, affiliation: Affiliation): Promise<boolean> {
  if (!supabase) return _lsUsers().some(u => u.name === name && u.affiliation === affiliation);
  try {
    const { data } = await supabase.from('gd_users').select('id').eq('name', name).eq('affiliation', affiliation).limit(1);
    return (data?.length ?? 0) > 0;
  } catch { return false; }
}

function lsGet<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function lsSave(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch (e: any) {
    if (e?.name === 'QuotaExceededError' || e?.code === 22)
      throw new Error('저장 공간이 부족합니다. 파일 일부를 삭제해주세요.');
    throw e;
  }
}

// ── Markdown components (pre wraps를 벗기고 code에서 처리) ───
const mkComponents = (dark: boolean) => ({
  p:    ({ children }: any) => <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>,
  h1:   ({ children }: any) => <h1 className="text-lg font-bold mt-4 mb-2 first:mt-0">{children}</h1>,
  h2:   ({ children }: any) => <h2 className="text-base font-bold mt-3 mb-1.5 first:mt-0">{children}</h2>,
  h3:   ({ children }: any) => <h3 className="text-sm font-bold mt-2 mb-1 first:mt-0">{children}</h3>,
  ul:   ({ children }: any) => <ul className="list-disc pl-5 mb-2 space-y-0.5">{children}</ul>,
  ol:   ({ children }: any) => <ol className="list-decimal pl-5 mb-2 space-y-0.5">{children}</ol>,
  li:   ({ children }: any) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }: any) => <strong className="font-semibold">{children}</strong>,
  em:   ({ children }: any) => <em className="italic">{children}</em>,
  blockquote: ({ children }: any) => (
    <blockquote className={`border-l-4 pl-3 my-2 italic ${dark ? 'border-zinc-500 text-zinc-400' : 'border-zinc-400 text-zinc-500'}`}>{children}</blockquote>
  ),
  // pre 태그를 투명하게 처리하고 code 컴포넌트에서 블록/인라인 구분
  pre:  ({ children }: any) => <>{children}</>,
  code: ({ className, children }: any) => {
    const content = String(children).replace(/\n$/, '');
    const isBlock = content.includes('\n') || Boolean(className);
    return isBlock
      ? <pre className={`p-3 rounded-xl text-xs font-mono overflow-x-auto my-2 ${dark ? 'bg-zinc-900 text-zinc-200' : 'bg-zinc-50 text-zinc-800'}`}><code>{content}</code></pre>
      : <code className={`px-1.5 py-0.5 rounded text-xs font-mono ${dark ? 'bg-zinc-700 text-zinc-300' : 'bg-zinc-100 text-zinc-700'}`}>{children}</code>;
  },
  hr:    () => <hr className={`my-3 ${dark ? 'border-zinc-700' : 'border-zinc-200'}`} />,
  table: ({ children }: any) => <div className="overflow-x-auto my-2"><table className="text-xs border-collapse w-full">{children}</table></div>,
  th:    ({ children }: any) => <th className={`border px-2 py-1 text-left font-semibold ${dark ? 'border-zinc-600 bg-zinc-700' : 'border-zinc-200 bg-zinc-50'}`}>{children}</th>,
  td:    ({ children }: any) => <td className={`border px-2 py-1 ${dark ? 'border-zinc-700' : 'border-zinc-100'}`}>{children}</td>,
});

// ── App ───────────────────────────────────────────────────
export default function App() {
  // 핵심 상태
  const [folders,     setFolders]     = useState<FolderData[]>(() => lsGet(LS.folders, [DEFAULT_FOLDER]));
  const [folderId,    setFolderId]    = useState<string>(() => localStorage.getItem(LS.folderId) ?? 'default');
  const [messages,    setMessages]    = useState<Message[]>(() =>
    lsGet<any[]>(LS.messages, []).map((m: any) => ({ ...m, ts: m.ts ?? Date.now() }))
  );
  const [theme,       setTheme]       = useState<'light' | 'dark'>(() => (localStorage.getItem(LS.theme) as any) ?? 'light');
  const [fontSize,    setFontSize]    = useState(() => Number(localStorage.getItem(LS.size)) || 15);
  const [sidebarOpen, setSidebarOpen] = useState(() => lsGet(LS.sidebar, true));

  // UI 상태
  const [syncing,        setSyncing]       = useState(!!supabase);
  const [input,          setInput]         = useState('');
  const [loading,        setLoading]       = useState(false);
  const [processingMsg,  setProcessingMsg] = useState<string | null>(null);
  const [error,          setError]         = useState<string | null>(null);
  const [drag,           setDrag]          = useState(false);
  const [copiedIdx,      setCopiedIdx]     = useState<number | null>(null);
  const [shareOk,        setShareOk]       = useState(false);
  const [newName,        setNewName]       = useState('');
  const [addingFolder,   setAddingFolder]  = useState(false);
  const [listening,      setListening]     = useState(false);
  const [devMode,        setDevMode]       = useState(() => sessionStorage.getItem('gd-dev') === '1');
  const [showDevModal,   setShowDevModal]  = useState(false);
  const [devPwInput,     setDevPwInput]    = useState('');
  const [devPwError,     setDevPwError]    = useState(false);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [confirmDlg,     setConfirmDlg]    = useState<ConfirmDlg | null>(null);
  const [ctxWarning,     setCtxWarning]    = useState(false);
  const [mgmtFolderId,   setMgmtFolderId]  = useState<string | null>(null);
  const [editingFile,    setEditingFile]   = useState<{ id: string; name: string } | null>(null);
  const [editFolderName, setEditFolderName] = useState('');
  const [editingFolderName, setEditingFolderName] = useState(false);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renamingFolderText, setRenamingFolderText] = useState('');

  // ── 인증 상태 ─────────────────────────────────────────────
  const [authInitialized, setAuthInitialized] = useState(false);
  const [authView,   setAuthView]   = useState<'login' | 'register' | 'pending' | 'app'>('login');
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
  const [loginName,  setLoginName]  = useState('');
  const [loginAffil, setLoginAffil] = useState<Affiliation>('middle');
  const [loginPw,    setLoginPw]    = useState('');
  const [regName,    setRegName]    = useState('');
  const [regAffil,   setRegAffil]   = useState<Affiliation>('middle');
  const [regPw,      setRegPw]      = useState('');
  const [regPwConfirm, setRegPwConfirm] = useState('');
  const [authError,  setAuthError]  = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  // ── 사용자 관리 상태 (관리자) ─────────────────────────────
  const [showUserMgmt, setShowUserMgmt]     = useState(false);
  const [allUsers,     setAllUsers]         = useState<AppUser[]>([]);
  const [usersLoading, setUsersLoading]     = useState(false);
  const [userMgmtTab,  setUserMgmtTab]      = useState<'dashboard' | 'middle' | 'high'>('dashboard');
  const [userSearch,   setUserSearch]       = useState('');
  const [selectedIds,  setSelectedIds]      = useState<string[]>([]);

  // Refs
  const fileRef      = useRef<HTMLInputElement>(null);
  const endRef       = useRef<HTMLDivElement>(null);
  const recRef       = useRef<any>(null);
  const inputRef     = useRef<HTMLTextAreaElement>(null);
  const uploadTarget = useRef<string>('');
  const droppedFiles = useRef<File[]>([]);

  const dark   = theme === 'dark';
  const folder = folders.find(f => f.id === folderId) ?? folders[0];
  const d = (l: string, dk: string) => dark ? dk : l;
  const hasFiles = (folder?.files.length ?? 0) > 0;

  // ── Memoized markdown components ─────────────────────────
  const mdComponents = useMemo(() => mkComponents(dark), [dark]);

  // ── Quick action cards ────────────────────────────────────
  const quickCards = useMemo(() => [
    { icon: Sparkles,      color: 'text-zinc-500',  bg: d('bg-zinc-100','bg-zinc-700/40'), title: '문서 요약',  q: '현재 문서들을 간략히 요약해줘.' },
    { icon: FileSearch,    color: 'text-zinc-500',  bg: d('bg-zinc-100','bg-zinc-700/40'), title: '규정 검색',  q: '꼭 알아야 할 주요 규정을 찾아줘.' },
    { icon: LayoutGrid,    color: 'text-zinc-500',  bg: d('bg-zinc-100','bg-zinc-700/40'), title: '비교 분석',  q: '문서들의 주요 차이점을 비교해줘.' },
    { icon: MessageSquare, color: 'text-zinc-500',  bg: d('bg-zinc-100','bg-zinc-700/40'), title: '자유 질문',  q: '교사들이 가장 궁금해할 내용은 무엇인가요?' },
  ], [dark]);

  // ── Supabase: 앱 시작 시 서버에서 폴더 데이터 로드 ──────────
  useEffect(() => {
    if (!supabase) return;
    (async () => {
      setSyncing(true);
      try {
        const serverFolders = await sbLoadFolders();
        if (serverFolders && serverFolders.length > 0) {
          // 서버 데이터 우선 (웹·앱 동기화)
          setFolders(serverFolders);
          lsSave(LS.folders, serverFolders);
        } else {
          // 서버가 비어있으면 현재 localStorage 데이터를 서버로 업로드 (최초 마이그레이션)
          const local = lsGet(LS.folders, [DEFAULT_FOLDER]);
          await sbSaveFolders(local);
        }
      } catch {}
      setSyncing(false);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Persistence ───────────────────────────────────────────
  useEffect(() => {
    try { lsSave(LS.folders, folders); } catch {}
    // Supabase에도 동기화 (디바운스 1초)
    if (!supabase) return;
    const t = setTimeout(() => sbSaveFolders(folders), 1000);
    return () => clearTimeout(t);
  }, [folders]);
  useEffect(() => { localStorage.setItem(LS.folderId, folderId); }, [folderId]);
  useEffect(() => { localStorage.setItem(LS.theme, theme); document.documentElement.style.colorScheme = theme; }, [theme]);
  useEffect(() => { localStorage.setItem(LS.size, String(fontSize)); }, [fontSize]);
  useEffect(() => { localStorage.setItem(LS.sidebar, JSON.stringify(sidebarOpen)); }, [sidebarOpen]);
  // messages는 스트리밍 완료 후에만 저장 (sendMessage finally 블록)

  // ── 자동 에러 해제 ────────────────────────────────────────
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error]);

  // ── 자동 스크롤 ───────────────────────────────────────────
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, loading]);

  // ── 초기 포커스 ───────────────────────────────────────────
  useEffect(() => { inputRef.current?.focus(); }, []);

  // ── 앱 시작 시 사용자 세션 복원 ──────────────────────────
  useEffect(() => {
    if (devMode) { setAuthInitialized(true); return; }
    const saved = lsGet<AppUser | null>(LS.user, null);
    if (!saved?.id) { setAuthView('login'); setAuthInitialized(true); return; }
    (async () => {
      const fresh = await sbGetUserById(saved.id);
      const user  = fresh ?? saved;
      setCurrentUser(user);
      if (user.status === 'active')        setAuthView('app');
      else if (user.status === 'pending')  setAuthView('pending');
      else { localStorage.removeItem(LS.user); setAuthView('login'); }
      setAuthInitialized(true);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 컨텍스트 용량 경고 ─────────────────────────────────────
  useEffect(() => {
    const total = (folder?.files ?? []).reduce((s, f) => s + f.text.length, 0);
    setCtxWarning(total > MAX_CONTEXT_CHARS);
  }, [folder]);

  // ── PDF 추출 (pdfjs 지연 로딩) ───────────────────────────
  const extractPdf = async (file: File): Promise<string> => {
    const pdfjs = await getPdfjs();
    const buf = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: buf }).promise;
    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const c = await page.getTextContent();
      text += c.items.map((item: any) => item.str).join(' ') + '\n';
    }
    if (!text.trim()) throw new Error(`"${file.name}"에서 텍스트를 추출할 수 없습니다. 스캔 이미지 PDF일 수 있습니다.`);
    return text;
  };

  // ── 파일 업로드 ───────────────────────────────────────────
  const uploadFiles = async (files: File[], targetId?: string) => {
    const pdfs = files.filter(f => f.type === 'application/pdf');
    if (!pdfs.length) { setError('PDF 파일만 업로드 가능합니다.'); return; }

    // 파일 크기 검사
    const oversized = pdfs.find(f => f.size > MAX_FILE_MB * 1024 * 1024);
    if (oversized) { setError(`"${oversized.name}" 파일이 ${MAX_FILE_MB}MB를 초과합니다.`); return; }

    const tid = targetId ?? uploadTarget.current ?? folderId;
    const targetFolder = folders.find(f => f.id === tid);

    // 중복 검사
    const dupes    = pdfs.filter(f =>  targetFolder?.files.some(ef => ef.name === f.name));
    const toProcess = pdfs.filter(f => !targetFolder?.files.some(ef => ef.name === f.name));
    if (!toProcess.length) { setError('선택한 파일이 이미 모두 업로드되어 있습니다.'); return; }

    setError(null);
    const added: FileData[] = [];
    try {
      for (let i = 0; i < toProcess.length; i++) {
        const f = toProcess[i];
        setProcessingMsg(`(${i + 1}/${toProcess.length}) ${f.name}`);
        const text = await extractPdf(f);
        added.push({ id: crypto.randomUUID(), name: f.name, text });
      }

      setFolders(prev => {
        const updated = prev.map(f =>
          f.id === tid ? { ...f, files: [...f.files, ...added] } : f
        );
        try { lsSave(LS.folders, updated); } catch (e: any) { setError(e.message); }
        return updated;
      });
      setFolderId(tid);

      let msg = `✅ **${targetFolder?.name ?? '폴더'}**에 ${added.length}개 파일이 추가됐습니다.\n\n${added.map(f => `• \`${f.name}\``).join('\n')}`;
      if (dupes.length) msg += `\n\n⚠️ 이미 존재하는 파일 ${dupes.length}개는 건너뜀: ${dupes.map(f => f.name).join(', ')}`;
      msg += '\n\n이제 이 폴더의 문서에 대해 자유롭게 질문해주세요!';
      addBot(msg);
    } catch (e: any) {
      setError(e.message ?? '파일 처리 오류');
    } finally {
      setProcessingMsg(null);
      uploadTarget.current = '';
      droppedFiles.current = [];
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const addBot = (content: string) =>
    setMessages(prev => [...prev, { role: 'bot', content, ts: Date.now() }]);

  // ── 드래그 & 드랍 ─────────────────────────────────────────
  const onDragOver  = (e: React.DragEvent) => { e.preventDefault(); if (devMode) setDrag(true); };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    if (!(e.currentTarget as Element).contains(e.relatedTarget as Node)) setDrag(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDrag(false);
    if (!devMode) { setError('파일 업로드는 관리자만 가능합니다.'); return; }
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (!files.length) return;
    if (folders.length > 1) {
      droppedFiles.current = files; // 폴더 선택 후 사용
      setShowFolderPicker(true);
    } else {
      uploadFiles(files, folders[0].id);
    }
  };

  // ── 메시지 전송 (대화 히스토리 포함) ─────────────────────
  const sendMessage = async (override?: string) => {
    const msg = (override ?? input).trim();
    if (!msg || loading) return;
    if (!override) setInput('');

    // 현재 대화 스냅샷 (히스토리용)
    const prevMessages = messages;
    setMessages(prev => [...prev, { role: 'user', content: msg, ts: Date.now() }]);
    setLoading(true); setError(null);

    try {
      const ctx = (folder?.files ?? []).map(f => `### 파일: ${f.name}\n${f.text}`).join('\n\n');

      if (!ctx.trim()) {
        addBot('현재 폴더에 파일이 없습니다. 왼쪽 사이드바에서 PDF를 먼저 업로드해주세요.');
        return;
      }

      const truncated   = ctx.length > MAX_CONTEXT_CHARS;
      const contextText = ctx.substring(0, MAX_CONTEXT_CHARS);

      const system = `당신은 광덕 교사들을 돕는 교육 행정 AI 비서입니다.
현재 폴더: "${folder?.name}"
${truncated ? '\n⚠️ 참고: 문서량이 많아 일부만 참조 중입니다.\n' : ''}
[답변 원칙 - 반드시 준수]
1. 오직 아래 [문서 내용]에 포함된 내용만을 근거로 답변하세요. 학습된 지식이나 외부 정보는 절대 사용하지 마세요.
2. 답변 시 반드시 출처 파일명을 명시하세요 (예: "[규정.pdf]에 따르면...").
3. 문서에 없는 내용은 어떤 경우에도 추측하거나 보완하지 말고, "업로드된 문서에서 확인이 어렵습니다"라고만 답하세요.
4. 문서가 없거나 비어 있으면 "문서가 업로드되지 않아 답변이 불가합니다"라고 답하세요.
5. 명확하고 친절한 어조로 실무에 바로 활용할 수 있게 답변하세요.

[문서 내용]
${contextText || '(업로드된 문서 없음)'}`;

      // 이전 대화 히스토리 구성 (빈 메시지 제외, 최근 N개)
      const history = prevMessages
        .filter(m => m.content.trim())
        .slice(-MAX_HISTORY_MSGS)
        .map(m => ({
          role: m.role === 'user' ? 'user' as const : 'assistant' as const,
          content: m.content,
        }));

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 4096,
          messages: [
            { role: 'system', content: system },
            ...history,
            { role: 'user', content: msg },
          ],
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`AI 서버 오류 (${res.status})${errText ? ': ' + errText.slice(0, 200) : ''}`);
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let full = '';
      setMessages(prev => [...prev, { role: 'bot', content: '', ts: Date.now() }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        full += decoder.decode(value, { stream: true });
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
    } finally {
      setLoading(false);
      // 스트리밍 완료 후 한 번만 localStorage 저장
      setMessages(prev => {
        try { lsSave(LS.messages, prev); } catch (e: any) { setError(e.message); }
        return prev;
      });
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  // ── 마지막 답변 재생성 (비파괴적) ─────────────────────────
  const refreshLast = () => {
    if (loading) return;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        const text = messages[i].content;
        setMessages(messages.slice(0, i)); // 해당 질문 이전까지 보존
        setTimeout(() => sendMessage(text), 30);
        return;
      }
    }
  };

  // ── 커스텀 확인 모달 ──────────────────────────────────────
  const askConfirm = (msg: string, onConfirm: () => void) =>
    setConfirmDlg({ msg, onConfirm });

  // ── 폴더/파일 관리 ────────────────────────────────────────
  const addFolder = () => {
    const name = newName.trim();
    if (!name) return;
    const nf: FolderData = { id: crypto.randomUUID(), name, files: [] };
    setFolders(prev => [...prev, nf]);
    setFolderId(nf.id);
    setAddingFolder(false); setNewName('');
  };

  const deleteFolder = (id: string) => {
    if (!devMode) { setError('폴더 삭제는 관리자만 가능합니다.'); return; }
    if (folders.length <= 1) { setError('마지막 폴더는 삭제할 수 없습니다.'); return; }
    askConfirm('폴더와 모든 파일을 삭제할까요?', () => {
      setFolders(prev => {
        const rest = prev.filter(f => f.id !== id);
        if (folderId === id) setFolderId(rest[0].id);
        return rest;
      });
    });
  };

  const deleteFile = (fileId: string, targetFolderId?: string) => {
    if (!devMode) { setError('파일 삭제는 관리자만 가능합니다.'); return; }
    const tid = targetFolderId ?? folderId;
    setFolders(prev => prev.map(f =>
      f.id === tid ? { ...f, files: f.files.filter(fl => fl.id !== fileId) } : f
    ));
  };

  const renameFile = (targetFolderId: string, fileId: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) { setEditingFile(null); return; }
    setFolders(prev => prev.map(f =>
      f.id === targetFolderId
        ? { ...f, files: f.files.map(fl => fl.id === fileId ? { ...fl, name: trimmed } : fl) }
        : f
    ));
    setEditingFile(null);
  };

  const renameFolder = (id: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) { setEditingFolderName(false); return; }
    setFolders(prev => prev.map(f => f.id === id ? { ...f, name: trimmed } : f));
    setEditingFolderName(false);
  };

  const openFolderMgmt = (f: FolderData) => {
    setMgmtFolderId(f.id);
    setEditFolderName(f.name);
    setEditingFolderName(false);
    setEditingFile(null);
  };

  // ── 대화 관리 ─────────────────────────────────────────────
  const clearChat = () => {
    if (!messages.length) return;
    askConfirm('대화 내용을 모두 삭제할까요?', () => {
      setMessages([]);
      try { lsSave(LS.messages, []); } catch {}
    });
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

  // ── 관리자 모드 ───────────────────────────────────────────
  const requestUpload = () => {
    if (!devMode) { setShowDevModal(true); return; }
    if (folders.length > 1) {
      droppedFiles.current = [];
      setShowFolderPicker(true);
    } else {
      uploadTarget.current = folders[0].id;
      fileRef.current?.click();
    }
  };

  const confirmDevPassword = () => {
    if (devPwInput === DEV_PASSWORD) {
      setDevMode(true);
      sessionStorage.setItem('gd-dev', '1');
      setShowDevModal(false); setDevPwInput(''); setDevPwError(false);
      setTimeout(() => {
        if (folders.length > 1) { droppedFiles.current = []; setShowFolderPicker(true); }
        else { uploadTarget.current = folders[0].id; fileRef.current?.click(); }
      }, 100);
    } else {
      setDevPwError(true); setDevPwInput('');
    }
  };

  const exitDevMode = () => { setDevMode(false); sessionStorage.removeItem('gd-dev'); };

  // ── 인증 핸들러 ───────────────────────────────────────────
  const handleLogin = async () => {
    if (!loginName.trim() || !loginPw) { setAuthError('이름과 비밀번호를 입력해주세요.'); return; }
    setAuthLoading(true); setAuthError('');
    try {
      const hash = await hashPassword(loginPw);
      const user = await sbFindUser(loginName.trim(), loginAffil, hash);
      if (!user) { setAuthError('이름, 소속 또는 비밀번호가 일치하지 않습니다.'); return; }
      const { password_hash: _l, ...safeUser } = user;
      try { localStorage.setItem(LS.user, JSON.stringify(safeUser)); } catch {}
      setCurrentUser(user);
      if (user.status === 'active')        setAuthView('app');
      else if (user.status === 'pending')  setAuthView('pending');
      else if (user.status === 'inactive') setAuthError('계정이 비활성화되었습니다. 관리자에게 문의하세요.');
      else                                 setAuthError('가입 신청이 거부되었습니다. 관리자에게 문의하세요.');
    } finally { setAuthLoading(false); }
  };

  const handleRegister = async () => {
    if (!regName.trim() || !regPw || !regPwConfirm) { setAuthError('모든 항목을 입력해주세요.'); return; }
    if (regPw.length < 4) { setAuthError('비밀번호는 4자 이상이어야 합니다.'); return; }
    if (regPw !== regPwConfirm) { setAuthError('비밀번호가 일치하지 않습니다.'); return; }
    setAuthLoading(true); setAuthError('');
    try {
      const hash = await hashPassword(regPw);
      // 동일 이름+소속+비번으로 이미 존재하면 중복
      const existing = await sbFindUser(regName.trim(), regAffil, hash);
      if (existing) { setAuthError('이미 가입된 계정입니다.'); return; }
      const user = await sbRegisterUser(regName.trim(), regAffil, hash);
      if (!user) { setAuthError('가입 신청 중 오류가 발생했습니다. 다시 시도해주세요.'); return; }
      const { password_hash: _r, ...safeUser } = user;
      try { localStorage.setItem(LS.user, JSON.stringify(safeUser)); } catch {}
      setCurrentUser(user);
      setAuthView('pending');
    } finally { setAuthLoading(false); }
  };

  const handleLogout = () => {
    localStorage.removeItem(LS.user);
    setCurrentUser(null);
    setAuthView('login');
    setLoginName(''); setLoginPw(''); setAuthError('');
  };

  // ── 사용자 관리 핸들러 (관리자) ──────────────────────────
  const loadUsers = async () => {
    setUsersLoading(true);
    const users = await sbLoadUsers();
    setAllUsers(users);
    setUsersLoading(false);
  };

  const updateUserStatus = async (id: string, status: UserStatus) => {
    const ok = await sbUpdateUserStatus(id, status);
    if (ok) {
      const now = new Date().toISOString();
      setAllUsers(prev => prev.map(u => u.id === id ? { ...u, status, ...(status === 'active' ? { approved_at: now } : {}) } : u));
    }
  };

  const bulkApprove = async () => {
    if (!selectedIds.length) return;
    const ids = selectedIds.filter(id => allUsers.find(u => u.id === id)?.status === 'pending');
    if (!ids.length) return;
    const ok = await sbBulkUpdateStatus(ids, 'active');
    if (ok) {
      const now = new Date().toISOString();
      setAllUsers(prev => prev.map(u => ids.includes(u.id) ? { ...u, status: 'active', approved_at: now } : u));
      setSelectedIds([]);
    }
  };

  const deleteUser = (id: string) => {
    askConfirm('이 사용자를 삭제할까요? 이 작업은 되돌릴 수 없습니다.', async () => {
      const ok = await sbDeleteUserRecord(id);
      if (ok) setAllUsers(prev => prev.filter(u => u.id !== id));
    });
  };

  // 동명이인 표시 (같은 소속 내 같은 이름이면 번호 부여)
  const getDisplayName = (user: AppUser): string => {
    const group = allUsers.filter(u => u.name === user.name && u.affiliation === user.affiliation);
    if (group.length <= 1) return user.name;
    const sorted = [...group].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const idx = sorted.findIndex(u => u.id === user.id);
    return `${user.name}(${idx + 1})`;
  };

  const toggleSelectUser = (id: string) =>
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const toggleSelectAll = (users: AppUser[]) => {
    const ids = users.map(u => u.id);
    const allSelected = ids.every(id => selectedIds.includes(id));
    setSelectedIds(allSelected ? selectedIds.filter(id => !ids.includes(id)) : [...new Set([...selectedIds, ...ids])]);
  };

  // ── 음성 입력 ─────────────────────────────────────────────
  const toggleVoice = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { setError('이 브라우저는 음성 인식을 지원하지 않습니다.'); return; }
    if (listening) { recRef.current?.stop(); setListening(false); return; }
    const r = new SR();
    r.lang = 'ko-KR'; r.continuous = false; r.interimResults = false;
    r.onstart  = () => setListening(true);
    r.onend    = () => setListening(false);
    r.onerror  = (ev: any) => {
      setListening(false);
      const msgs: Record<string, string> = {
        'not-allowed': '마이크 권한이 없습니다. 브라우저 설정에서 허용해주세요.',
        'network':     '음성 인식 네트워크 오류가 발생했습니다.',
        'no-speech':   '',
      };
      const m = msgs[ev.error];
      if (m === undefined) setError(`음성 인식 오류: ${ev.error}`);
      else if (m) setError(m);
    };
    r.onresult = (ev: any) => setInput(p => p + ev.results[0][0].transcript);
    recRef.current = r; r.start();
  };

  // ── 텍스트에리어 자동 리사이즈 ──────────────────────────
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  // ── 스타일 헬퍼 ───────────────────────────────────────────
  const bg          = d('bg-zinc-50',      'bg-zinc-950');
  const text        = d('text-zinc-900',   'text-zinc-100');
  const sidebar_bg  = d('bg-white',        'bg-zinc-900');
  const border_c    = d('border-zinc-200', 'border-zinc-800');
  const card        = d('bg-white',        'bg-zinc-800');
  const muted       = d('text-zinc-500',   'text-zinc-400');
  const hover_light = d('hover:bg-zinc-100','hover:bg-zinc-800');

  // ─────────────────────────────────────────────────────────
  //  AUTH SCREENS
  // ─────────────────────────────────────────────────────────
  if (!devMode) {
    // 세션 초기화 중
    if (!authInitialized) return (
      <div className={`flex h-screen items-center justify-center ${dark ? 'bg-zinc-950' : 'bg-zinc-50'}`}>
        <Loader2 className="w-8 h-8 animate-spin text-zinc-400" />
      </div>
    );

    // 승인 대기
    if (authView === 'pending') return (
      <div className={`relative flex h-screen items-center justify-center p-4 ${dark ? 'bg-zinc-950 text-zinc-100' : 'bg-zinc-50 text-zinc-900'}`}
        style={{ backgroundImage: 'url(/abc.png)', backgroundSize: 'cover' }}>
        <div className={`absolute inset-0 ${dark ? 'bg-zinc-950/80' : 'bg-white/85'}`} />
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
          className={`relative z-10 w-full max-w-sm ${dark ? 'bg-zinc-900 border border-zinc-800' : 'bg-white border border-zinc-200'} rounded-3xl shadow-2xl p-8 text-center`}>
          <div className="w-16 h-16 bg-amber-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Clock className="w-8 h-8 text-amber-500" />
          </div>
          <h2 className="font-bold text-lg mb-2">승인 대기 중</h2>
          <p className={`text-sm mb-6 leading-relaxed ${muted}`}>
            <span className="font-semibold">{currentUser?.name}</span>님의 가입 신청이 접수되었습니다.<br />
            관리자 승인 후 이용하실 수 있습니다.
          </p>
          <div className={`text-xs px-3 py-2 rounded-xl mb-6 ${dark ? 'bg-zinc-800 text-zinc-400' : 'bg-zinc-50 text-zinc-500'}`}>
            소속: {currentUser?.affiliation === 'middle' ? '중학교' : '고등학교'}
          </div>
          <button onClick={handleLogout}
            className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-2xl text-sm font-semibold transition-colors ${dark ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200' : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-700'}`}>
            <LogOut className="w-4 h-4" />로그아웃
          </button>
        </motion.div>
      </div>
    );

    // 로그인 / 가입 신청
    if (authView === 'login' || authView === 'register') {
      const isReg = authView === 'register';
      return (
        <div className={`relative flex h-screen items-center justify-center p-4 ${dark ? 'bg-zinc-950 text-zinc-100' : 'bg-zinc-50 text-zinc-900'}`}
          style={{ backgroundImage: 'url(/abc.png)', backgroundSize: 'cover' }}>
          <div className={`absolute inset-0 ${dark ? 'bg-zinc-950/80' : 'bg-white/85'}`} />
          <motion.div key={authView} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
            className={`relative z-10 w-full max-w-sm ${dark ? 'bg-zinc-900 border border-zinc-800' : 'bg-white border border-zinc-200'} rounded-3xl shadow-2xl overflow-hidden`}>

            {/* 헤더 */}
            <div className="relative px-8 pt-8 pb-6 text-center overflow-hidden"
              style={{ backgroundImage: 'url(/abc.png)', backgroundSize: 'cover', backgroundPosition: 'center top' }}>
              <div className={`absolute inset-0 ${dark ? 'bg-zinc-900/85' : 'bg-white/85'}`} />
              <div className="relative z-10">
                <div className="w-14 h-14 bg-zinc-600 rounded-2xl flex items-center justify-center mx-auto mb-3 shadow-lg">
                  <Sparkles className="w-7 h-7 text-white" />
                </div>
                <h1 className="font-bold text-lg">광덕 AI 비서</h1>
                <p className={`text-xs mt-1 ${muted}`}>{isReg ? '가입 신청' : '로그인'}</p>
              </div>
            </div>

            <div className="px-8 py-6 space-y-4">
              {/* 소속 선택 */}
              <div>
                <label className={`text-xs font-semibold mb-1.5 block ${muted}`}>소속</label>
                <div className="grid grid-cols-2 gap-2">
                  {(['middle', 'high'] as Affiliation[]).map(a => {
                    const val = isReg ? regAffil : loginAffil;
                    const set = isReg ? setRegAffil : setLoginAffil;
                    return (
                      <button key={a} onClick={() => set(a)}
                        className={`py-2.5 rounded-2xl text-sm font-semibold border transition-all ${
                          val === a
                            ? 'bg-zinc-600 text-white border-zinc-600 shadow-md'
                            : dark ? 'border-zinc-700 text-zinc-300 hover:border-zinc-500' : 'border-zinc-200 text-zinc-600 hover:border-zinc-400'
                        }`}
                      >{a === 'middle' ? '중학교' : '고등학교'}</button>
                    );
                  })}
                </div>
              </div>

              {/* 이름 */}
              <div>
                <label className={`text-xs font-semibold mb-1.5 block ${muted}`}>이름</label>
                <input
                  type="text" autoComplete="name" placeholder="홍길동"
                  value={isReg ? regName : loginName}
                  onChange={e => isReg ? setRegName(e.target.value) : setLoginName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !isReg && handleLogin()}
                  className={`w-full px-4 py-2.5 rounded-2xl border outline-none text-sm transition-colors ${
                    dark ? 'bg-zinc-800 border-zinc-700 focus:border-zinc-500 text-zinc-100 placeholder:text-zinc-600'
                         : 'bg-zinc-50 border-zinc-200 focus:border-zinc-400 focus:bg-white text-zinc-900 placeholder:text-zinc-400'
                  }`}
                />
              </div>

              {/* 비밀번호 */}
              <div>
                <label className={`text-xs font-semibold mb-1.5 block ${muted}`}>비밀번호</label>
                <input
                  type="password" placeholder={isReg ? '4자 이상' : '비밀번호 입력'}
                  value={isReg ? regPw : loginPw}
                  onChange={e => isReg ? setRegPw(e.target.value) : setLoginPw(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !isReg && handleLogin()}
                  className={`w-full px-4 py-2.5 rounded-2xl border outline-none text-sm transition-colors ${
                    dark ? 'bg-zinc-800 border-zinc-700 focus:border-zinc-500 text-zinc-100 placeholder:text-zinc-600'
                         : 'bg-zinc-50 border-zinc-200 focus:border-zinc-400 focus:bg-white text-zinc-900 placeholder:text-zinc-400'
                  }`}
                />
              </div>

              {/* 비밀번호 확인 (가입 시만) */}
              {isReg && (
                <div>
                  <label className={`text-xs font-semibold mb-1.5 block ${muted}`}>비밀번호 확인</label>
                  <input
                    type="password" placeholder="비밀번호 재입력"
                    value={regPwConfirm}
                    onChange={e => setRegPwConfirm(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleRegister()}
                    className={`w-full px-4 py-2.5 rounded-2xl border outline-none text-sm transition-colors ${
                      dark ? 'bg-zinc-800 border-zinc-700 focus:border-zinc-500 text-zinc-100 placeholder:text-zinc-600'
                           : 'bg-zinc-50 border-zinc-200 focus:border-zinc-400 focus:bg-white text-zinc-900 placeholder:text-zinc-400'
                    }`}
                  />
                </div>
              )}

              {/* 오류 */}
              {authError && (
                <motion.div initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }}
                  className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-red-50 border border-red-200 text-red-600 text-xs">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />{authError}
                </motion.div>
              )}

              {/* 버튼 */}
              <button
                onClick={isReg ? handleRegister : handleLogin}
                disabled={authLoading}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl text-sm font-semibold bg-zinc-600 hover:bg-zinc-700 disabled:opacity-50 text-white transition-colors shadow-md shadow-black/15"
              >
                {authLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : isReg ? <UserCheck className="w-4 h-4" /> : <Lock className="w-4 h-4" />}
                {isReg ? '가입 신청하기' : '로그인'}
              </button>

              <div className="text-center space-y-2">
                <button
                  onClick={() => { setAuthView(isReg ? 'login' : 'register'); setAuthError(''); setRegPw(''); setRegPwConfirm(''); }}
                  className={`text-xs underline underline-offset-2 ${muted}`}
                >
                  {isReg ? '이미 계정이 있으신가요? 로그인' : '처음이신가요? 가입 신청'}
                </button>
                {!isReg && (
                  <div>
                    <button
                      onClick={() => {
                        const pw = prompt('관리자 비밀번호를 입력하세요:');
                        if (pw === DEV_PASSWORD) {
                          setDevMode(true);
                          sessionStorage.setItem('gd-dev', '1');
                          setAuthInitialized(true);
                        } else if (pw !== null) {
                          setAuthError('관리자 비밀번호가 틀렸습니다.');
                        }
                      }}
                      className={`text-xs ${muted} opacity-50 hover:opacity-100 transition-opacity`}
                    >
                      관리자 입장
                    </button>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        </div>
      );
    }
  }

  // ─────────────────────────────────────────────────────────
  //  RENDER
  // ─────────────────────────────────────────────────────────
  return (
    <div
      className={`flex h-screen overflow-hidden font-sans ${bg} ${text} transition-colors`}
      style={{ fontFamily: "'Pretendard Variable', 'Pretendard', system-ui, sans-serif" }}
      onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
    >

      {/* ── 드래그 오버레이 ── */}
      <AnimatePresence>
        {drag && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-zinc-700/90 backdrop-blur-sm flex items-center justify-center pointer-events-none"
          >
            <div className="border-4 border-dashed border-white/60 rounded-[48px] p-16 text-center text-white">
              <Upload className="w-16 h-16 mx-auto mb-4" />
              <p className="text-2xl font-bold">PDF 파일을 여기에 놓으세요</p>
              <p className="mt-2 opacity-80">"{folder?.name}" 폴더에 추가됩니다</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── 에러 토스트 ── */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }}
            className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-red-600 text-white px-4 py-3 rounded-2xl shadow-xl flex items-center gap-2 max-w-md w-full mx-4"
            role="alert"
          >
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span className="text-sm flex-1">{error}</span>
            <button onClick={() => setError(null)} aria-label="오류 닫기">
              <X className="w-4 h-4 opacity-70 hover:opacity-100" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── 파일 처리 오버레이 ── */}
      <AnimatePresence>
        {(processingMsg || syncing) && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm flex items-center justify-center"
            aria-live="polite"
          >
            <div className={`${card} px-8 py-7 rounded-3xl shadow-2xl flex flex-col items-center gap-4 max-w-xs w-full mx-4`}>
              <div className="relative">
                <Loader2 className="w-10 h-10 text-zinc-500 animate-spin" />
                <div className="absolute inset-0 rounded-full bg-zinc-500/10 animate-ping" />
              </div>
              <div className="text-center">
                {syncing
                  ? <p className="font-bold mb-1">서버에서 데이터 불러오는 중...</p>
                  : <>
                      <p className="font-bold mb-1">PDF 분석 중...</p>
                      <p className={`text-xs ${muted} leading-relaxed max-w-[200px]`}>{processingMsg}</p>
                    </>
                }
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── 커스텀 확인 모달 ── */}
      <AnimatePresence>
        {confirmDlg && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[90] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={() => setConfirmDlg(null)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className={`${card} w-full max-w-sm rounded-3xl shadow-2xl p-6`}
              role="alertdialog" aria-modal="true" aria-label="확인"
            >
              <div className="flex items-start gap-3 mb-5">
                <div className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 ${d('bg-red-50','bg-red-950/40')}`}>
                  <AlertTriangle className="w-5 h-5 text-red-500" />
                </div>
                <p className={`text-sm leading-relaxed pt-2 ${d('text-zinc-700','text-zinc-300')}`}>{confirmDlg.msg}</p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirmDlg(null)}
                  className={`flex-1 py-2.5 rounded-2xl text-sm font-semibold transition-colors ${d('bg-zinc-100 hover:bg-zinc-200 text-zinc-700','bg-zinc-700 hover:bg-zinc-600 text-zinc-300')}`}
                >취소</button>
                <button
                  onClick={() => { confirmDlg.onConfirm(); setConfirmDlg(null); }}
                  className="flex-1 py-2.5 rounded-2xl text-sm font-semibold bg-red-600 hover:bg-red-700 text-white transition-colors"
                >확인</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── 폴더 관리 모달 ── */}
      <AnimatePresence>
        {mgmtFolderId && (() => {
          const mf = folders.find(f => f.id === mgmtFolderId);
          if (!mf) return null;
          const approxPages = (chars: number) => Math.max(1, Math.round(chars / 1500));
          return (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
              onClick={() => { setMgmtFolderId(null); setEditingFile(null); setEditingFolderName(false); }}
            >
              <motion.div
                initial={{ scale: 0.95, opacity: 0, y: 8 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.95, opacity: 0, y: 8 }}
                onClick={e => e.stopPropagation()}
                className={`${card} w-full max-w-md rounded-3xl shadow-2xl flex flex-col overflow-hidden`}
                style={{ maxHeight: '80vh' }}
                role="dialog" aria-modal="true" aria-label="폴더 관리"
              >
                {/* 헤더 */}
                <div className={`flex items-center gap-3 px-5 py-4 border-b ${border_c} shrink-0`}>
                  <div className="w-9 h-9 bg-zinc-600 rounded-xl flex items-center justify-center shrink-0 shadow-md shadow-black/20">
                    <Folder className="w-4 h-4 text-white" />
                  </div>
                  <div className="flex-1 min-w-0">
                    {editingFolderName ? (
                      <input
                        autoFocus
                        value={editFolderName}
                        onChange={e => setEditFolderName(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') renameFolder(mf.id, editFolderName);
                          if (e.key === 'Escape') setEditingFolderName(false);
                        }}
                        onBlur={() => renameFolder(mf.id, editFolderName)}
                        className={`w-full text-sm font-bold px-2 py-1 rounded-lg border outline-none ${d('border-zinc-400 bg-zinc-100','border-zinc-500 bg-zinc-800/30')}`}
                        aria-label="폴더 이름 수정"
                      />
                    ) : (
                      <button
                        onClick={() => { setEditFolderName(mf.name); setEditingFolderName(true); }}
                        className={`flex items-center gap-1.5 group text-left`}
                        aria-label="폴더 이름 수정"
                        title="클릭하여 이름 수정"
                      >
                        <span className="text-sm font-bold truncate">{mf.name}</span>
                        <Pencil className={`w-3 h-3 shrink-0 opacity-0 group-hover:opacity-60 transition-opacity ${muted}`} />
                      </button>
                    )}
                    <p className={`text-[10px] ${muted}`}>파일 {mf.files.length}개</p>
                  </div>
                  <button
                    onClick={() => { setMgmtFolderId(null); setEditingFile(null); setEditingFolderName(false); }}
                    aria-label="관리 창 닫기"
                    className={`p-1.5 rounded-xl ${hover_light} transition-colors shrink-0`}
                  ><X className="w-4 h-4" /></button>
                </div>

                {/* 파일 목록 */}
                <div className="flex-1 overflow-y-auto hide-scrollbar p-4 space-y-2">
                  {mf.files.length === 0 ? (
                    <div className={`py-12 flex flex-col items-center gap-3 ${muted}`}>
                      <FileText className="w-10 h-10 opacity-30" />
                      <p className="text-sm">이 폴더에 파일이 없습니다</p>
                    </div>
                  ) : mf.files.map(fl => (
                    <div key={fl.id}
                      className={`flex items-start gap-3 p-3 rounded-2xl border transition-all ${d('border-zinc-100 hover:border-zinc-200 bg-zinc-50/50','border-zinc-700/50 hover:border-zinc-600 bg-zinc-800/30')}`}
                    >
                      <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 mt-0.5 ${d('bg-zinc-100','bg-zinc-800/40')}`}>
                        <FileText className="w-4 h-4 text-zinc-500" />
                      </div>
                      <div className="flex-1 min-w-0">
                        {editingFile?.id === fl.id ? (
                          <input
                            autoFocus
                            value={editingFile.name}
                            onChange={e => setEditingFile({ id: fl.id, name: e.target.value })}
                            onKeyDown={e => {
                              if (e.key === 'Enter') renameFile(mf.id, fl.id, editingFile.name);
                              if (e.key === 'Escape') setEditingFile(null);
                            }}
                            onBlur={() => renameFile(mf.id, fl.id, editingFile.name)}
                            className={`w-full text-sm font-medium px-2 py-0.5 rounded-lg border outline-none ${d('border-zinc-400 bg-zinc-100','border-zinc-500 bg-zinc-800/30')}`}
                            aria-label="파일 이름 수정"
                          />
                        ) : (
                          <button
                            onClick={() => setEditingFile({ id: fl.id, name: fl.name })}
                            className="flex items-center gap-1.5 group text-left w-full"
                            title="클릭하여 이름 수정"
                            aria-label={`${fl.name} 이름 수정`}
                          >
                            <span className={`text-sm font-medium truncate ${d('text-zinc-800','text-zinc-200')}`}>{fl.name}</span>
                            <Pencil className={`w-3 h-3 shrink-0 opacity-0 group-hover:opacity-60 transition-opacity ${muted}`} />
                          </button>
                        )}
                        <p className={`text-[10px] mt-0.5 ${muted}`}>
                          약 {approxPages(fl.text.length)}페이지 · {(fl.text.length / 1000).toFixed(0)}K자
                        </p>
                      </div>
                      <button
                        onClick={() => askConfirm(`"${fl.name}"을 삭제할까요?`, () => deleteFile(fl.id, mf.id))}
                        aria-label={`${fl.name} 삭제`}
                        className={`p-1.5 rounded-xl shrink-0 transition-colors ${d('hover:bg-red-50 text-zinc-400 hover:text-red-500','hover:bg-red-950/30 text-zinc-600 hover:text-red-400')}`}
                      ><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  ))}
                </div>

                {/* 하단 버튼 */}
                <div className={`px-4 py-3 border-t ${border_c} shrink-0`}>
                  <button
                    onClick={() => {
                      setMgmtFolderId(null);
                      uploadTarget.current = mf.id;
                      droppedFiles.current = [];
                      setTimeout(() => fileRef.current?.click(), 100);
                    }}
                    className="w-full flex items-center justify-center gap-2 py-2.5 rounded-2xl text-sm font-semibold bg-zinc-600 hover:bg-zinc-700 text-white transition-colors shadow-md shadow-black/15"
                    aria-label="파일 추가"
                  >
                    <Plus className="w-4 h-4" />파일 추가
                  </button>
                </div>
              </motion.div>
            </motion.div>
          );
        })()}
      </AnimatePresence>

      {/* ── 폴더 선택 모달 ── */}
      <AnimatePresence>
        {showFolderPicker && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={() => { setShowFolderPicker(false); droppedFiles.current = []; }}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 8 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.95, opacity: 0, y: 8 }}
              onClick={e => e.stopPropagation()}
              className={`${card} w-full max-w-sm rounded-3xl shadow-2xl p-6`}
              role="dialog" aria-modal="true" aria-label="폴더 선택"
            >
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 bg-zinc-600 rounded-2xl flex items-center justify-center shadow-lg shadow-black/20">
                  <Folder className="w-5 h-5 text-white" />
                </div>
                <div>
                  <p className="font-bold">폴더 선택</p>
                  <p className={`text-xs ${muted}`}>파일을 추가할 폴더를 선택하세요</p>
                </div>
              </div>
              <div className="space-y-2 mb-4">
                {folders.map(f => (
                  <button key={f.id}
                    onClick={() => {
                      uploadTarget.current = f.id;
                      setShowFolderPicker(false);
                      if (droppedFiles.current.length) {
                        uploadFiles(droppedFiles.current, f.id); // 드래그한 파일 사용
                      } else {
                        setTimeout(() => fileRef.current?.click(), 100);
                      }
                    }}
                    className={`w-full flex items-center gap-3 px-4 py-3 rounded-2xl border text-left transition-all ${
                      f.id === folderId
                        ? 'border-zinc-500 bg-zinc-100 text-zinc-700'
                        : d('border-zinc-200 hover:border-zinc-300 hover:bg-zinc-100/50','border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800/20')
                    }`}
                  >
                    <div className={`w-8 h-8 rounded-xl flex items-center justify-center ${f.id === folderId ? 'bg-zinc-600' : d('bg-zinc-100','bg-zinc-700')}`}>
                      <Folder className={`w-4 h-4 ${f.id === folderId ? 'text-white' : 'text-zinc-400'}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate">{f.name}</p>
                      <p className={`text-[10px] ${muted}`}>파일 {f.files.length}개</p>
                    </div>
                    {f.id === folderId && <Check className="w-4 h-4 text-zinc-500 shrink-0" />}
                  </button>
                ))}
              </div>
              <button
                onClick={() => { setShowFolderPicker(false); droppedFiles.current = []; }}
                className={`w-full py-2.5 rounded-2xl text-sm font-semibold transition-colors ${d('bg-zinc-100 hover:bg-zinc-200 text-zinc-700','bg-zinc-700 hover:bg-zinc-600 text-zinc-300')}`}
              >취소</button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── 관리자 비밀번호 모달 ── */}
      <AnimatePresence>
        {showDevModal && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={() => { setShowDevModal(false); setDevPwInput(''); setDevPwError(false); }}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 8 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.95, opacity: 0, y: 8 }}
              onClick={e => e.stopPropagation()}
              className={`${card} w-full max-w-sm rounded-3xl shadow-2xl p-6`}
              role="dialog" aria-modal="true" aria-label="관리자 인증"
            >
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 bg-zinc-600 rounded-2xl flex items-center justify-center shadow-lg shadow-black/20">
                  <Lock className="w-5 h-5 text-white" />
                </div>
                <div>
                  <p className="font-bold">관리자 인증</p>
                  <p className={`text-xs ${muted}`}>파일 업로드 권한이 필요합니다</p>
                </div>
              </div>
              <input
                autoFocus type="password"
                value={devPwInput}
                onChange={e => { setDevPwInput(e.target.value); setDevPwError(false); }}
                onKeyDown={e => e.key === 'Enter' && confirmDevPassword()}
                placeholder="비밀번호 입력..."
                aria-label="관리자 비밀번호"
                className={`w-full px-4 py-3 rounded-2xl border outline-none text-sm mb-2 transition-colors ${
                  devPwError
                    ? 'border-red-400 bg-red-50 text-red-700'
                    : d('border-zinc-200 bg-zinc-50 focus:border-zinc-400 focus:bg-white','border-zinc-700 bg-zinc-800/50 focus:border-zinc-500')
                }`}
              />
              {devPwError && (
                <motion.p initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }}
                  className="text-xs text-red-500 mb-3 px-1" role="alert">비밀번호가 틀렸습니다.</motion.p>
              )}
              <div className="flex gap-2 mt-4">
                <button
                  onClick={() => { setShowDevModal(false); setDevPwInput(''); setDevPwError(false); }}
                  className={`flex-1 py-2.5 rounded-2xl text-sm font-semibold transition-colors ${d('bg-zinc-100 hover:bg-zinc-200 text-zinc-700','bg-zinc-700 hover:bg-zinc-600 text-zinc-300')}`}
                >취소</button>
                <button onClick={confirmDevPassword}
                  className="flex-1 py-2.5 rounded-2xl text-sm font-semibold bg-zinc-600 hover:bg-zinc-700 text-white transition-colors shadow-md shadow-black/15"
                >확인</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ════════════════════════════════════════
          SIDEBAR
      ════════════════════════════════════════ */}

      {/* 모바일 백드롭 */}
      <AnimatePresence>
        {sidebarOpen && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="md:hidden fixed inset-0 z-20 bg-black/40"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {sidebarOpen && (
          <motion.aside
            initial={{ x: -280, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -280, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className={`w-72 shrink-0 flex flex-col border-r ${sidebar_bg} ${border_c} z-30 fixed md:relative h-full`}
            aria-label="사이드바"
          >
            {/* 헤더 */}
            <div
              className={`relative flex items-center justify-between px-4 py-4 border-b ${border_c} overflow-hidden`}
              style={{ backgroundImage: 'url(/abc.png)', backgroundSize: 'cover', backgroundPosition: 'center top' }}
            >
              <div className={`absolute inset-0 ${d('bg-white/86','bg-zinc-900/78')}`} />
              <div className="relative z-10 flex items-center gap-2.5">
                <div className="w-9 h-9 bg-zinc-600 rounded-xl flex items-center justify-center shadow-md shadow-black/20">
                  <Sparkles className="w-4 h-4 text-white" />
                </div>
                <div>
                  <p className="text-sm font-bold leading-tight">광덕 AI 비서</p>
                  <p className={`text-[10px] ${muted}`}>교육 행정 어시스턴트</p>
                </div>
              </div>
              <button onClick={() => setSidebarOpen(false)} aria-label="사이드바 닫기"
                className={`relative z-10 p-1.5 rounded-xl ${hover_light} transition-colors`}>
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 폴더 목록 */}
            <div className="flex-1 overflow-y-auto hide-scrollbar">
              <div className="p-3">
                <div className="flex items-center justify-between mb-2 px-1">
                  <p className={`text-[10px] font-bold uppercase tracking-widest ${muted}`}>폴더</p>
                  {devMode && (
                    <button onClick={() => setAddingFolder(v => !v)} aria-label="새 폴더 추가"
                      className={`p-1 rounded-lg ${hover_light} transition-colors`}>
                      <FolderPlus className="w-4 h-4 text-zinc-500" />
                    </button>
                  )}
                </div>

                <AnimatePresence>
                  {addingFolder && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden mb-2"
                    >
                      <div className="flex gap-1 p-1">
                        <input autoFocus value={newName}
                          onChange={e => setNewName(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') addFolder(); if (e.key === 'Escape') { setAddingFolder(false); setNewName(''); } }}
                          placeholder="폴더 이름..." aria-label="새 폴더 이름"
                          className={`flex-1 text-sm px-3 py-1.5 rounded-xl border outline-none transition-colors ${d('bg-zinc-50 border-zinc-200 focus:border-zinc-400 focus:bg-white','bg-zinc-800 border-zinc-700 focus:border-zinc-500')}`}
                        />
                        <button onClick={addFolder}
                          className="px-2 py-1.5 bg-zinc-800 text-white rounded-xl text-xs font-bold hover:bg-zinc-900 transition-colors">추가</button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {folders.map(f => (
                  <div key={f.id}
                    role="button" aria-selected={f.id === folderId}
                    className={`group flex items-center justify-between px-3 py-2.5 rounded-xl mb-1 cursor-pointer transition-all ${
                      f.id === folderId
                        ? 'bg-zinc-600 text-white shadow-md shadow-black/15'
                        : d('hover:bg-zinc-100 text-zinc-700','hover:bg-zinc-800 text-zinc-300')
                    }`}
                    onClick={() => { if (renamingFolderId !== f.id) setFolderId(f.id); }}
                    onDoubleClick={e => {
                      e.preventDefault();
                      if (devMode) { setRenamingFolderId(f.id); setRenamingFolderText(f.name); }
                    }}
                  >
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      <Folder className="w-4 h-4 shrink-0" />
                      {renamingFolderId === f.id ? (
                        <input
                          autoFocus
                          value={renamingFolderText}
                          onChange={e => setRenamingFolderText(e.target.value)}
                          onClick={e => e.stopPropagation()}
                          onKeyDown={e => {
                            if (e.key === 'Enter') { renameFolder(f.id, renamingFolderText); setRenamingFolderId(null); }
                            if (e.key === 'Escape') setRenamingFolderId(null);
                          }}
                          onBlur={() => { renameFolder(f.id, renamingFolderText); setRenamingFolderId(null); }}
                          className={`flex-1 text-sm font-medium px-1.5 py-0.5 rounded-lg border outline-none min-w-0 ${
                            f.id === folderId
                              ? 'bg-white/20 border-white/40 text-white placeholder-white/60'
                              : d('bg-white border-zinc-400 text-zinc-800','bg-zinc-900 border-zinc-500 text-zinc-100')
                          }`}
                          aria-label="폴더 이름 수정"
                        />
                      ) : (
                        <>
                          <span className="text-sm font-medium truncate">{f.name}</span>
                          {f.files.length > 0 && (
                            <span className={`text-[10px] shrink-0 px-1.5 py-0.5 rounded-full font-bold ${
                              f.id === folderId ? 'bg-white/20 text-white' : d('bg-zinc-100 text-zinc-500','bg-zinc-700 text-zinc-400')
                            }`}>{f.files.length}</span>
                          )}
                        </>
                      )}
                    </div>
                    {devMode && renamingFolderId !== f.id && (
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={e => { e.stopPropagation(); openFolderMgmt(f); }}
                          aria-label={`${f.name} 폴더 관리`}
                          className={`p-0.5 rounded transition-colors ${f.id === folderId ? 'hover:bg-white/20' : hover_light}`}
                        ><Settings2 className="w-3.5 h-3.5" /></button>
                        {folders.length > 1 && (
                          <button
                            onClick={e => { e.stopPropagation(); deleteFolder(f.id); }}
                            aria-label={`${f.name} 폴더 삭제`}
                            className={`p-0.5 rounded transition-colors ${f.id === folderId ? 'hover:bg-white/20' : hover_light}`}
                          ><Trash2 className="w-3.5 h-3.5" /></button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* 파일 목록 */}
              <div className="p-3 pt-0">
                <div className="flex items-center justify-between mb-2 px-1">
                  <p className={`text-[10px] font-bold uppercase tracking-widest ${muted}`}>파일</p>
                  {devMode && (
                    <button onClick={requestUpload} aria-label="PDF 파일 업로드"
                      className={`p-1 rounded-lg ${hover_light} transition-colors`}>
                      <Plus className="w-4 h-4 text-zinc-500" />
                    </button>
                  )}
                </div>
                <input ref={fileRef} type="file" accept=".pdf" multiple className="hidden"
                  onChange={e => { if (e.target.files?.length) uploadFiles(Array.from(e.target.files), uploadTarget.current || folderId); }} />

                {/* 컨텍스트 경고 */}
                {ctxWarning && hasFiles && (
                  <div className={`mb-2 px-3 py-2 rounded-xl text-[10px] flex items-start gap-1.5 ${d('bg-amber-50 text-amber-700 border border-amber-200','bg-amber-950/30 text-amber-400 border border-amber-800/40')}`}
                    role="status">
                    <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                    <span>문서량이 많아 일부만 AI에 전달됩니다</span>
                  </div>
                )}

                {(folder?.files ?? []).length === 0 ? (
                  devMode ? (
                    <button onClick={requestUpload}
                      className={`w-full py-5 rounded-2xl border-2 border-dashed flex flex-col items-center gap-2 transition-all ${d('border-zinc-200 hover:border-zinc-300 hover:bg-zinc-100/50 text-zinc-400 hover:text-zinc-500','border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800/20 text-zinc-600 hover:text-zinc-400')}`}
                      aria-label="PDF 업로드">
                      <Upload className="w-5 h-5" />
                      <span className="text-xs font-semibold">PDF 업로드</span>
                      <span className={`text-[10px] ${muted}`}>클릭 또는 드래그</span>
                    </button>
                  ) : (
                    <div className={`w-full py-5 rounded-2xl border-2 border-dashed flex flex-col items-center gap-2 ${d('border-zinc-100 text-zinc-300','border-zinc-800 text-zinc-700')}`}>
                      <Lock className="w-5 h-5" />
                      <span className="text-xs font-medium">관리자 전용</span>
                    </div>
                  )
                ) : (
                  <div className="space-y-0.5">
                    {folder.files.map(fl => (
                      <div key={fl.id}
                        className={`group flex items-center gap-2 px-3 py-2 rounded-xl transition-colors ${d('hover:bg-zinc-50','hover:bg-zinc-800/50')}`}>
                        <FileText className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                        <span className={`text-xs flex-1 truncate ${muted}`} title={fl.name}>{fl.name}</span>
                        {devMode && (
                          <button onClick={() => deleteFile(fl.id)} aria-label={`${fl.name} 삭제`}
                            className={`opacity-0 group-hover:opacity-100 p-0.5 rounded transition-opacity ${hover_light}`}>
                            <X className="w-3 h-3 text-red-400 hover:text-red-600" />
                          </button>
                        )}
                      </div>
                    ))}
                    {devMode && (
                      <button onClick={requestUpload} aria-label="파일 추가"
                        className={`w-full flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold text-zinc-500 transition-colors ${d('hover:bg-zinc-100','hover:bg-zinc-800/30')}`}>
                        <Plus className="w-3.5 h-3.5" />파일 추가
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* 푸터 */}
            <div className={`p-3 border-t ${border_c} space-y-1`}>
              {/* 다크 모드 */}
              <div
                className={`flex items-center justify-between px-3 py-2 rounded-xl ${hover_light} cursor-pointer transition-colors`}
                onClick={() => setTheme(t => t === 'light' ? 'dark' : 'light')}
                role="button" aria-label={dark ? '라이트 모드로 전환' : '다크 모드로 전환'}
              >
                <span className={`text-xs font-medium ${muted}`}>{dark ? '다크 모드' : '라이트 모드'}</span>
                <div className={`w-11 h-6 rounded-full transition-colors relative ${dark ? 'bg-zinc-600' : 'bg-zinc-300'}`}>
                  <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${dark ? 'translate-x-5' : 'translate-x-0.5'} flex items-center justify-center`}>
                    {dark ? <Moon className="w-2.5 h-2.5 text-zinc-300" /> : <Sun className="w-2.5 h-2.5 text-yellow-500" />}
                  </span>
                </div>
              </div>
              {/* 글자 크기 */}
              <div className={`flex items-center justify-between px-3 py-2 rounded-xl ${hover_light} transition-colors`}>
                <span className={`text-xs font-medium ${muted}`}>글자 크기</span>
                <div className="flex items-center gap-1">
                  <button onClick={() => setFontSize(s => Math.max(12, s - 1))} aria-label="글자 크기 줄이기"
                    className={`w-7 h-7 rounded-lg flex items-center justify-center ${hover_light} transition-colors`}>
                    <ZoomOut className="w-3.5 h-3.5" />
                  </button>
                  <span className={`text-xs font-bold w-8 text-center tabular-nums ${muted}`}>{fontSize}px</span>
                  <button onClick={() => setFontSize(s => Math.min(22, s + 1))} aria-label="글자 크기 키우기"
                    className={`w-7 h-7 rounded-lg flex items-center justify-center ${hover_light} transition-colors`}>
                    <ZoomIn className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              {/* 관리자 모드 */}
              <button
                onClick={() => devMode ? exitDevMode() : setShowDevModal(true)}
                aria-label={devMode ? '관리자 모드 종료' : '관리자 로그인'}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-xl transition-all ${
                  devMode
                    ? d('bg-emerald-50 hover:bg-emerald-100 text-emerald-700','bg-emerald-950/30 hover:bg-emerald-950/50 text-emerald-400')
                    : hover_light
                }`}
              >
                <span className={`text-xs font-medium ${devMode ? '' : muted}`}>
                  {devMode ? '관리자 모드 활성' : '관리자 로그인'}
                </span>
                {devMode ? <LockOpen className="w-4 h-4 text-emerald-500" /> : <Lock className={`w-4 h-4 ${muted}`} />}
              </button>
              {/* 사용자 관리 (관리자만) */}
              {devMode && (
                <button
                  onClick={() => { setShowUserMgmt(true); loadUsers(); }}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-xl transition-all ${d('hover:bg-blue-50 text-blue-700','hover:bg-blue-950/30 text-blue-400')} ${hover_light}`}
                  aria-label="사용자 관리"
                >
                  <span className="text-xs font-medium">사용자 관리</span>
                  <Users className="w-4 h-4" />
                </button>
              )}
              {/* 일반 사용자 로그아웃 */}
              {!devMode && currentUser && (
                <button
                  onClick={handleLogout}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-xl transition-colors ${hover_light}`}
                  aria-label="로그아웃"
                >
                  <span className={`text-xs font-medium ${muted}`}>{currentUser.name} · {currentUser.affiliation === 'middle' ? '중학교' : '고등학교'}</span>
                  <LogOut className={`w-4 h-4 ${muted}`} />
                </button>
              )}
              <p className={`text-[9px] text-center px-3 py-1 ${muted} opacity-50 leading-relaxed`}>
                © 2026 광덕고등학교 조일웅 All Rights Reserved
              </p>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* ════════════════════════════════════════
          MAIN
      ════════════════════════════════════════ */}
      <main className="flex-1 flex flex-col min-w-0">

        {/* 헤더 */}
        <nav className={`flex items-center justify-between px-4 py-3 border-b ${border_c} ${d('bg-white','bg-zinc-900')} shrink-0 no-print`}
          aria-label="상단 메뉴">
          <div className="flex items-center gap-3">
            <button onClick={() => setSidebarOpen(v => !v)} aria-label="사이드바 열기/닫기"
              className={`p-2 rounded-xl ${hover_light} transition-colors`}>
              <Menu className="w-5 h-5" />
            </button>
            <div>
              <h1 className="font-bold text-sm leading-tight truncate max-w-[150px] md:max-w-xs">
                {folder?.name ?? '광덕 AI 비서'}
              </h1>
              <p className={`text-[10px] ${muted}`}>
                {hasFiles ? `${folder!.files.length}개 파일 로드됨` : '파일 없음'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-0.5">
            <button onClick={refreshLast} disabled={!messages.length || loading}
              aria-label="마지막 답변 재생성" title="재생성"
              className={`p-2 rounded-xl disabled:opacity-30 ${hover_light} transition-colors`}>
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button onClick={() => window.print()} disabled={!messages.length}
              aria-label="대화 인쇄" title="인쇄"
              className={`p-2 rounded-xl disabled:opacity-30 ${hover_light} transition-colors`}>
              <Printer className="w-4 h-4" />
            </button>
            <button onClick={exportChat} disabled={!messages.length}
              aria-label="대화 내보내기" title="내보내기"
              className={`p-2 rounded-xl disabled:opacity-30 ${hover_light} transition-colors`}>
              <Download className="w-4 h-4" />
            </button>
            <button onClick={clearChat} disabled={!messages.length}
              aria-label="대화 삭제" title="대화 삭제"
              className={`p-2 rounded-xl disabled:opacity-30 transition-colors ${d('hover:bg-red-50 text-zinc-400 hover:text-red-500 disabled:text-zinc-300','hover:bg-red-950/20 text-zinc-500 hover:text-red-400 disabled:text-zinc-700')}`}>
              <Trash2 className="w-4 h-4" />
            </button>
            <div className={`w-px h-5 mx-1 ${d('bg-gray-200','bg-zinc-700')}`} />
            <div className="relative">
              <button onClick={shareApp} aria-label="링크 공유" title="링크 공유"
                className={`p-2 rounded-xl ${hover_light} transition-colors`}>
                {shareOk ? <Check className="w-4 h-4 text-emerald-500" /> : <Share2 className="w-4 h-4" />}
              </button>
              <AnimatePresence>
                {shareOk && (
                  <motion.div
                    initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                    className="absolute top-full mt-2 right-0 bg-zinc-900 text-white text-[10px] px-2.5 py-1.5 rounded-lg whitespace-nowrap shadow-lg"
                    aria-live="polite"
                  >링크 복사됨!</motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </nav>

        {/* 메시지 영역 */}
        <div
          className="flex-1 overflow-y-auto hide-scrollbar p-4 md:p-6 relative"
          role="main"
          style={messages.length === 0 ? { backgroundImage: 'url(/abc.png)', backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}
        >
          {messages.length === 0 && (
            <div className={`absolute inset-0 pointer-events-none ${d('bg-zinc-50/80','bg-zinc-950/72')}`} />
          )}
          {messages.length === 0 ? (
            <div className="relative z-10 max-w-2xl mx-auto mt-8 md:mt-12">
              <div className="text-center mb-8">
                <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full mb-4 text-[10px] font-bold uppercase tracking-widest ${d('bg-zinc-100 text-zinc-500 border border-zinc-200','bg-zinc-800/60 text-zinc-400 border border-zinc-700')}`}>
                  <Sparkles className="w-3 h-3" />AI-Powered
                </div>
                <h2 className={`text-3xl md:text-4xl font-light tracking-tight mb-2 ${d('text-zinc-900','text-white')}`}>
                  광덕 <span className={`font-bold ${d('text-zinc-800','text-zinc-200')}`}>교육 비서</span>
                </h2>
                <p className={`text-sm ${muted}`}>
                  {hasFiles ? '아래 버튼을 클릭하거나 직접 질문을 입력하세요' : 'PDF 문서를 업로드하면 AI에게 무엇이든 질문할 수 있습니다'}
                </p>
              </div>

              {hasFiles ? (
                <div className="grid grid-cols-2 gap-3">
                  {quickCards.map((item, i) => (
                    <motion.button key={i}
                      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.06 }}
                      onClick={() => sendMessage(item.q)}
                      className={`p-4 rounded-2xl border text-left transition-all hover:shadow-lg hover:-translate-y-0.5 ${d('bg-white border-zinc-200 hover:border-zinc-400','bg-zinc-900 border-zinc-800 hover:border-zinc-600 hover:bg-zinc-800/80')}`}
                    >
                      <div className={`w-9 h-9 ${item.bg} rounded-xl flex items-center justify-center mb-3`}>
                        <item.icon className={`w-4 h-4 ${item.color}`} />
                      </div>
                      <p className={`font-bold text-sm ${d('text-zinc-900','text-white')}`}>{item.title}</p>
                    </motion.button>
                  ))}
                </div>
              ) : (
                <motion.div
                  initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                  className={`rounded-3xl border-2 border-dashed p-10 flex flex-col items-center gap-4 text-center transition-all ${
                    devMode
                      ? d('border-zinc-200 hover:border-zinc-400 hover:bg-zinc-100/50 cursor-pointer','border-zinc-700 hover:border-zinc-500 hover:bg-zinc-800/20 cursor-pointer')
                      : d('border-zinc-100','border-zinc-800')
                  }`}
                  onClick={devMode ? requestUpload : undefined}
                  role={devMode ? 'button' : undefined}
                  aria-label={devMode ? 'PDF 업로드' : undefined}
                >
                  <div className={`w-16 h-16 rounded-2xl flex items-center justify-center ${devMode ? 'bg-zinc-600 shadow-lg shadow-black/20' : d('bg-zinc-100','bg-zinc-800')}`}>
                    {devMode
                      ? <Upload className="w-7 h-7 text-white" />
                      : <Lock className={`w-7 h-7 ${d('text-zinc-400','text-zinc-600')}`} />
                    }
                  </div>
                  <div>
                    <p className={`font-bold text-base mb-1 ${d('text-zinc-700','text-zinc-300')}`}>
                      {devMode ? 'PDF 문서 업로드' : '파일을 업로드해주세요'}
                    </p>
                    <p className={`text-sm ${muted}`}>
                      {devMode
                        ? '클릭하거나 파일을 드래그해서 업로드하세요'
                        : '관리자가 문서를 업로드하면 이 폴더를 사용할 수 있습니다'}
                    </p>
                  </div>
                  {devMode && (
                    <p className={`text-xs ${muted}`}>PDF만 지원 · 최대 {MAX_FILE_MB}MB</p>
                  )}
                </motion.div>
              )}
            </div>
          ) : (
            <div className="max-w-3xl mx-auto space-y-6" aria-live="polite" aria-label="대화 내용">
              {messages.map((m, i) => (
                <motion.div key={i}
                  initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                  className={`flex gap-3 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}
                >
                  <div className={`shrink-0 w-8 h-8 rounded-2xl flex items-center justify-center shadow-sm ${
                    m.role === 'user' ? 'bg-zinc-600 shadow-black/15' : d('bg-zinc-100','bg-zinc-800')
                  }`} aria-hidden="true">
                    {m.role === 'user'
                      ? <User className="w-4 h-4 text-white" />
                      : <Bot className={`w-4 h-4 ${d('text-zinc-500','text-zinc-400')}`} />
                    }
                  </div>

                  <div className={`group relative max-w-[82%] flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                    <div
                      className={`px-4 py-3 rounded-2xl ${
                        m.role === 'user'
                          ? 'bg-zinc-600 text-white rounded-tr-sm shadow-md shadow-black/10'
                          : d('bg-white border border-zinc-100 text-zinc-800 shadow-sm','bg-zinc-800 border border-zinc-700/60 text-zinc-100') + ' rounded-tl-sm'
                      }`}
                      style={{ fontSize: `${fontSize}px` }}
                    >
                      {m.role === 'user'
                        ? <p className="whitespace-pre-wrap leading-relaxed">{m.content}</p>
                        : <ReactMarkdown components={mdComponents as any}>{m.content || '▋'}</ReactMarkdown>
                      }
                    </div>
                    <div className={`flex items-center gap-2 mt-1.5 px-1 opacity-0 group-hover:opacity-100 transition-opacity ${m.role === 'user' ? 'flex-row-reverse' : ''}`}>
                      <span className={`text-[10px] ${muted}`}>
                        {new Date(m.ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      {m.role === 'bot' && m.content && (
                        <button onClick={() => copyMsg(m.content, i)} aria-label="메시지 복사"
                          className={`flex items-center gap-1 px-1.5 py-0.5 rounded-lg text-[10px] transition-colors ${d('hover:bg-zinc-100','hover:bg-zinc-800')}`}>
                          {copiedIdx === i
                            ? <><Check className="w-3 h-3 text-emerald-500" /><span className="text-emerald-500">복사됨</span></>
                            : <><Copy className={`w-3 h-3 ${muted}`} /><span className={muted}>복사</span></>
                          }
                        </button>
                      )}
                    </div>
                  </div>
                </motion.div>
              ))}

              {loading && (
                <div className="flex gap-3" aria-label="AI 응답 생성 중">
                  <div className={`w-8 h-8 rounded-2xl flex items-center justify-center shadow-sm ${d('bg-zinc-100','bg-zinc-800')}`}>
                    <Bot className={`w-4 h-4 ${d('text-zinc-500','text-zinc-400')}`} />
                  </div>
                  <div className={`px-4 py-3 rounded-2xl rounded-tl-sm ${d('bg-white border border-zinc-100 shadow-sm','bg-zinc-800 border border-zinc-700/60')}`}>
                    <div className="flex gap-1 items-center h-5">
                      {[0, 1, 2].map(j => (
                        <motion.div key={j}
                          animate={{ y: [0, -4, 0] }}
                          transition={{ duration: 0.7, repeat: Infinity, delay: j * 0.15 }}
                          className={`w-1.5 h-1.5 rounded-full ${d('bg-zinc-400','bg-zinc-500')}`}
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

        {/* 입력창 */}
        <div className={`px-4 py-3 border-t ${border_c} ${d('bg-white','bg-zinc-900')} shrink-0 no-print`}>
          <div className="max-w-3xl mx-auto">
            <div className={`flex items-end gap-2 px-4 py-3 rounded-2xl border transition-all ${d(
              'bg-zinc-50 border-zinc-200 focus-within:border-zinc-400 focus-within:bg-white focus-within:shadow-sm',
              'bg-zinc-800 border-zinc-700 focus-within:border-zinc-500'
            )}`}>
              <button onClick={requestUpload}
                aria-label={devMode ? 'PDF 업로드' : '관리자 전용'} title={devMode ? 'PDF 업로드' : '관리자 전용'}
                className={`shrink-0 p-1.5 rounded-xl mb-0.5 transition-colors ${hover_light}`}>
                <Paperclip className={`w-4 h-4 ${devMode ? 'text-zinc-500' : muted}`} />
              </button>
              <textarea
                ref={inputRef} value={input}
                onChange={handleInputChange} onKeyDown={handleKeyDown}
                placeholder={hasFiles ? '질문을 입력하세요... (Enter: 전송 / Shift+Enter: 줄바꿈)' : '먼저 PDF를 업로드해주세요...'}
                rows={1} aria-label="메시지 입력"
                className={`flex-1 resize-none bg-transparent outline-none leading-relaxed ${d('placeholder:text-zinc-400','placeholder:text-zinc-600')}`}
                style={{ fontSize: `${fontSize}px`, maxHeight: '160px' }}
              />
              <button onClick={toggleVoice}
                aria-label={listening ? '음성 입력 중지' : '음성 입력 시작'} title={listening ? '중지' : '음성 입력'}
                className={`shrink-0 p-1.5 rounded-xl mb-0.5 transition-colors ${listening ? 'bg-red-100 dark:bg-red-950/40' : hover_light}`}>
                {listening ? <MicOff className="w-4 h-4 text-red-500" /> : <Mic className={`w-4 h-4 ${muted}`} />}
              </button>
              <button onClick={() => sendMessage()} disabled={!input.trim() || loading}
                aria-label="전송" title="전송"
                className="shrink-0 w-8 h-8 bg-zinc-600 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl flex items-center justify-center transition-all mb-0.5 shadow-sm shadow-black/15">
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUp className="w-4 h-4" />}
              </button>
            </div>
            {input.length > 200 && (
              <p className={`text-right text-[10px] mt-1 pr-1 ${input.length > 800 ? 'text-amber-500' : muted}`}
                aria-live="polite">
                {input.length}자
              </p>
            )}
          </div>
        </div>
      </main>

      {/* ════════════════════════════════════════
          사용자 관리 패널 (관리자 전용)
      ════════════════════════════════════════ */}
      <AnimatePresence>
        {showUserMgmt && devMode && (() => {
          const affiliationLabel = (a: Affiliation) => a === 'middle' ? '중학교' : '고등학교';
          const statusLabel = (s: UserStatus) => ({ pending: '신청중', active: '활성', inactive: '비활성', rejected: '거부됨' }[s]);
          const statusColor = (s: UserStatus) => ({
            pending:  d('bg-amber-50 text-amber-600 border-amber-200', 'bg-amber-950/30 text-amber-400 border-amber-800/40'),
            active:   d('bg-emerald-50 text-emerald-600 border-emerald-200', 'bg-emerald-950/30 text-emerald-400 border-emerald-800/40'),
            inactive: d('bg-zinc-100 text-zinc-500 border-zinc-200', 'bg-zinc-800 text-zinc-500 border-zinc-700'),
            rejected: d('bg-red-50 text-red-500 border-red-200', 'bg-red-950/30 text-red-400 border-red-800/40'),
          }[s]);

          const filterUsers = (users: AppUser[]) => {
            let list = [...users];
            if (userSearch.trim()) {
              const q = userSearch.trim().toLowerCase();
              list = list.filter(u => u.name.toLowerCase().includes(q));
            }
            return list.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
          };

          const middleUsers = filterUsers(allUsers.filter(u => u.affiliation === 'middle'));
          const highUsers   = filterUsers(allUsers.filter(u => u.affiliation === 'high'));
          const tabUsers    = userMgmtTab === 'middle' ? middleUsers : highUsers;

          const stats = {
            total:    allUsers.length,
            pending:  allUsers.filter(u => u.status === 'pending').length,
            active:   allUsers.filter(u => u.status === 'active').length,
            inactive: allUsers.filter(u => u.status === 'inactive').length,
            rejected: allUsers.filter(u => u.status === 'rejected').length,
            middle:   allUsers.filter(u => u.affiliation === 'middle').length,
            high:     allUsers.filter(u => u.affiliation === 'high').length,
          };

          const pendingInTab = tabUsers.filter(u => u.status === 'pending');
          const allTabSelected = tabUsers.length > 0 && tabUsers.every(u => selectedIds.includes(u.id));

          const renderUserRow = (user: AppUser) => (
            <div key={user.id}
              className={`flex items-center gap-3 p-3 rounded-2xl border transition-all ${d('border-zinc-100 hover:border-zinc-200 bg-zinc-50/40','border-zinc-700/50 hover:border-zinc-600 bg-zinc-800/20')}`}>
              {/* 체크박스 */}
              <button onClick={() => toggleSelectUser(user.id)} className="shrink-0">
                {selectedIds.includes(user.id)
                  ? <CheckSquare className="w-4 h-4 text-zinc-600" />
                  : <Square className={`w-4 h-4 ${muted}`} />}
              </button>

              {/* 아바타 */}
              <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 text-xs font-bold ${d('bg-zinc-100 text-zinc-600','bg-zinc-800 text-zinc-300')}`}>
                {user.name.charAt(0)}
              </div>

              {/* 이름/소속 */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold truncate">{getDisplayName(user)}</p>
                <p className={`text-[10px] ${muted}`}>
                  {affiliationLabel(user.affiliation)} · {new Date(user.created_at).toLocaleDateString('ko-KR')}
                  {user.approved_at && ` · 승인: ${new Date(user.approved_at).toLocaleDateString('ko-KR')}`}
                </p>
              </div>

              {/* 상태 뱃지 */}
              <span className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${statusColor(user.status)}`}>
                {statusLabel(user.status)}
              </span>

              {/* 액션 버튼 */}
              <div className="flex items-center gap-1 shrink-0">
                {user.status === 'pending' && (
                  <>
                    <button onClick={() => updateUserStatus(user.id, 'active')}
                      title="승인" aria-label="승인"
                      className={`p-1.5 rounded-xl transition-colors ${d('hover:bg-emerald-50 text-zinc-400 hover:text-emerald-600','hover:bg-emerald-950/30 text-zinc-600 hover:text-emerald-400')}`}>
                      <UserCheck className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => updateUserStatus(user.id, 'rejected')}
                      title="거부" aria-label="거부"
                      className={`p-1.5 rounded-xl transition-colors ${d('hover:bg-red-50 text-zinc-400 hover:text-red-500','hover:bg-red-950/30 text-zinc-600 hover:text-red-400')}`}>
                      <UserX className="w-3.5 h-3.5" />
                    </button>
                  </>
                )}
                {user.status === 'active' && (
                  <button onClick={() => updateUserStatus(user.id, 'inactive')}
                    title="비활성화" aria-label="비활성화"
                    className={`p-1.5 rounded-xl transition-colors ${d('hover:bg-zinc-100 text-zinc-400 hover:text-zinc-600','hover:bg-zinc-700 text-zinc-600 hover:text-zinc-400')}`}>
                    <UserMinus className="w-3.5 h-3.5" />
                  </button>
                )}
                {(user.status === 'inactive' || user.status === 'rejected') && (
                  <button onClick={() => updateUserStatus(user.id, 'active')}
                    title="활성화" aria-label="활성화"
                    className={`p-1.5 rounded-xl transition-colors ${d('hover:bg-emerald-50 text-zinc-400 hover:text-emerald-600','hover:bg-emerald-950/30 text-zinc-600 hover:text-emerald-400')}`}>
                    <UserCheck className="w-3.5 h-3.5" />
                  </button>
                )}
                <button onClick={() => deleteUser(user.id)}
                  title="삭제" aria-label="삭제"
                  className={`p-1.5 rounded-xl transition-colors ${d('hover:bg-red-50 text-zinc-400 hover:text-red-500','hover:bg-red-950/30 text-zinc-600 hover:text-red-400')}`}>
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          );

          return (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 z-[70] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
              onClick={() => setShowUserMgmt(false)}
            >
              <motion.div
                initial={{ scale: 0.95, opacity: 0, y: 12 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.95, opacity: 0 }}
                onClick={e => e.stopPropagation()}
                className={`${card} w-full max-w-3xl rounded-3xl shadow-2xl flex flex-col overflow-hidden`}
                style={{ maxHeight: '90vh' }}
                role="dialog" aria-modal="true" aria-label="사용자 관리"
              >
                {/* ── 헤더 ── */}
                <div className={`flex items-center gap-3 px-6 py-4 border-b ${border_c} shrink-0`}>
                  <div className="w-10 h-10 bg-zinc-600 rounded-2xl flex items-center justify-center shadow-md shadow-black/20">
                    <Users className="w-5 h-5 text-white" />
                  </div>
                  <div className="flex-1">
                    <p className="font-bold">사용자 관리</p>
                    <p className={`text-xs ${muted}`}>가입 신청 승인 및 계정 관리</p>
                  </div>
                  <button onClick={() => loadUsers()} title="새로고침"
                    className={`p-2 rounded-xl ${hover_light} transition-colors`} aria-label="새로고침">
                    <RefreshCw className={`w-4 h-4 ${usersLoading ? 'animate-spin' : ''}`} />
                  </button>
                  <button onClick={() => setShowUserMgmt(false)} aria-label="닫기"
                    className={`p-2 rounded-xl ${hover_light} transition-colors`}>
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* ── 탭 ── */}
                <div className={`flex border-b ${border_c} shrink-0`}>
                  {(['dashboard', 'middle', 'high'] as const).map(tab => (
                    <button key={tab}
                      onClick={() => { setUserMgmtTab(tab); setSelectedIds([]); }}
                      className={`flex items-center gap-1.5 px-5 py-3 text-sm font-semibold border-b-2 transition-colors ${
                        userMgmtTab === tab
                          ? 'border-zinc-600 text-zinc-700 dark:text-zinc-200'
                          : `border-transparent ${muted} hover:text-zinc-600`
                      }`}
                    >
                      {tab === 'dashboard' && <BarChart3 className="w-4 h-4" />}
                      {tab === 'middle'    && <Users className="w-4 h-4" />}
                      {tab === 'high'      && <Users className="w-4 h-4" />}
                      {tab === 'dashboard' ? '대시보드' : tab === 'middle' ? `중학교 (${stats.middle})` : `고등학교 (${stats.high})`}
                      {tab === 'middle' && allUsers.filter(u => u.affiliation === 'middle' && u.status === 'pending').length > 0 && (
                        <span className="w-4 h-4 rounded-full bg-amber-500 text-white text-[9px] font-bold flex items-center justify-center">
                          {allUsers.filter(u => u.affiliation === 'middle' && u.status === 'pending').length}
                        </span>
                      )}
                      {tab === 'high' && allUsers.filter(u => u.affiliation === 'high' && u.status === 'pending').length > 0 && (
                        <span className="w-4 h-4 rounded-full bg-amber-500 text-white text-[9px] font-bold flex items-center justify-center">
                          {allUsers.filter(u => u.affiliation === 'high' && u.status === 'pending').length}
                        </span>
                      )}
                    </button>
                  ))}
                </div>

                {/* ── 내용 ── */}
                <div className="flex-1 overflow-y-auto hide-scrollbar">
                  {usersLoading ? (
                    <div className="flex items-center justify-center py-16">
                      <Loader2 className="w-8 h-8 animate-spin text-zinc-400" />
                    </div>
                  ) : userMgmtTab === 'dashboard' ? (
                    // ── 대시보드 ──
                    <div className="p-6 space-y-6">
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                        {[
                          { label: '전체 사용자', value: stats.total,    icon: Users,       color: 'text-zinc-600' },
                          { label: '신청 중',     value: stats.pending,  icon: Clock,       color: 'text-amber-500' },
                          { label: '활성',        value: stats.active,   icon: UserCheck,   color: 'text-emerald-500' },
                          { label: '비활성',      value: stats.inactive, icon: UserMinus,   color: 'text-zinc-400' },
                          { label: '거부됨',      value: stats.rejected, icon: UserX,       color: 'text-red-500' },
                          { label: '중학교',      value: stats.middle,   icon: ShieldCheck, color: 'text-blue-500' },
                        ].map(({ label, value, icon: Icon, color }) => (
                          <div key={label} className={`p-4 rounded-2xl border ${d('bg-zinc-50 border-zinc-100','bg-zinc-800/40 border-zinc-700/50')}`}>
                            <div className="flex items-center justify-between mb-1">
                              <span className={`text-xs ${muted}`}>{label}</span>
                              <Icon className={`w-4 h-4 ${color}`} />
                            </div>
                            <p className="text-2xl font-bold">{value}</p>
                          </div>
                        ))}
                      </div>

                      {stats.pending > 0 && (
                        <div className={`p-4 rounded-2xl border ${d('bg-amber-50 border-amber-200','bg-amber-950/20 border-amber-800/40')}`}>
                          <div className="flex items-center gap-2 mb-3">
                            <Clock className="w-4 h-4 text-amber-500" />
                            <p className="text-sm font-bold text-amber-600">승인 대기 중 {stats.pending}명</p>
                          </div>
                          <div className="space-y-2">
                            {allUsers.filter(u => u.status === 'pending').sort((a,b) => a.name.localeCompare(b.name,'ko')).map(user => (
                              <div key={user.id} className="flex items-center justify-between">
                                <span className={`text-sm ${d('text-amber-700','text-amber-300')}`}>
                                  {getDisplayName(user)} <span className="text-xs opacity-70">({affiliationLabel(user.affiliation)})</span>
                                </span>
                                <div className="flex gap-1">
                                  <button onClick={() => updateUserStatus(user.id, 'active')}
                                    className="text-xs px-3 py-1 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white font-semibold transition-colors">승인</button>
                                  <button onClick={() => updateUserStatus(user.id, 'rejected')}
                                    className={`text-xs px-3 py-1 rounded-xl font-semibold transition-colors ${d('bg-zinc-200 hover:bg-zinc-300 text-zinc-700','bg-zinc-700 hover:bg-zinc-600 text-zinc-300')}`}>거부</button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    // ── 중학교 / 고등학교 탭 ──
                    <div className="p-4 space-y-3">
                      {/* 검색 + 일괄 승인 */}
                      <div className="flex gap-2">
                        <div className={`flex-1 flex items-center gap-2 px-3 py-2 rounded-2xl border transition-colors ${d('bg-zinc-50 border-zinc-200 focus-within:border-zinc-400','bg-zinc-800 border-zinc-700 focus-within:border-zinc-500')}`}>
                          <Search className={`w-4 h-4 shrink-0 ${muted}`} />
                          <input
                            value={userSearch}
                            onChange={e => setUserSearch(e.target.value)}
                            placeholder="이름 검색..."
                            className="flex-1 bg-transparent outline-none text-sm placeholder:text-zinc-400"
                          />
                          {userSearch && (
                            <button onClick={() => setUserSearch('')} className={`${muted} hover:text-zinc-600`}>
                              <X className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                        {pendingInTab.length > 0 && selectedIds.filter(id => pendingInTab.some(u => u.id === id)).length > 0 && (
                          <button onClick={bulkApprove}
                            className="flex items-center gap-1.5 px-4 py-2 rounded-2xl text-sm font-semibold bg-emerald-500 hover:bg-emerald-600 text-white transition-colors shadow-sm">
                            <UserCheck className="w-4 h-4" />
                            일괄 승인 ({selectedIds.filter(id => pendingInTab.some(u => u.id === id)).length})
                          </button>
                        )}
                      </div>

                      {/* 전체 선택 */}
                      {tabUsers.length > 0 && (
                        <div className="flex items-center gap-2 px-1">
                          <button onClick={() => toggleSelectAll(tabUsers)} className="flex items-center gap-1.5 text-xs font-semibold">
                            {allTabSelected
                              ? <CheckSquare className="w-4 h-4 text-zinc-600" />
                              : <Square className={`w-4 h-4 ${muted}`} />}
                            <span className={muted}>전체 선택 ({tabUsers.length}명)</span>
                          </button>
                          {selectedIds.length > 0 && (
                            <span className="text-xs text-zinc-500">{selectedIds.length}명 선택됨</span>
                          )}
                        </div>
                      )}

                      {/* 사용자 목록 */}
                      {tabUsers.length === 0 ? (
                        <div className={`py-12 flex flex-col items-center gap-3 ${muted}`}>
                          <Users className="w-10 h-10 opacity-30" />
                          <p className="text-sm">{userSearch ? '검색 결과가 없습니다' : '등록된 사용자가 없습니다'}</p>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {tabUsers.map(renderUserRow)}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </motion.div>
            </motion.div>
          );
        })()}
      </AnimatePresence>
    </div>
  );
}
