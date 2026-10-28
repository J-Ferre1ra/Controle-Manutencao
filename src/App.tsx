import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { apiRequest, readSharedState } from './data/api';
import type { SharedAppState, SyncCursor } from './data/api';
import { exportControlWorkbook, mapSpreadsheetRow, readWorkbook, rowsFromSheet } from './lib/excel';
import type { ParsedWorkbook } from './lib/excel';
import type { AccessProfile, AdminPage, ExecutionNotification, ImportRecord, Order, OrderStatus, ProfileKind, SessionProfile } from './types';

const SYNC_POLL_INTERVAL_MS = 2 * 60 * 1000;

const kindLabels: Record<ProfileKind, string> = {
  inspetor: 'Neoenergia',
  vencer: 'Vencer',
  nper: 'Neoenergia',
  neoenergia: 'Neoenergia',
};

const pageLabels: Record<AdminPage, { title: string; subtitle: string }> = {
  painel: { title: 'Visão geral', subtitle: 'Ordens executadas, pendências e produtividade das equipes.' },
  controle: { title: 'Controle', subtitle: 'Gráficos de execução por situação, equipe, serviço e responsável.' },
  ordens: { title: 'Ordens', subtitle: 'Consulte e exporte as ordens das carteiras importadas.' },
  importacao: { title: 'Importar planilhas', subtitle: 'Carregue as carteiras do mês e distribua as ordens.' },
  protocolos: { title: 'Protocolos', subtitle: 'Consulte os registros de execução e impedimento.' },
  acessos: { title: 'Acessos', subtitle: 'Crie perfis e vincule cada acesso à equipe ou responsável.' },
};

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function normalizeHeader(value: string): string {
  return normalize(value).replace(/[^a-z0-9]+/g, ' ').trim();
}

function canonicalCompany(value: string): string {
  const company = normalize(value);
  return company === 'nper' ? 'neoenergia' : company;
}

function companyLabel(value: string): string {
  return canonicalCompany(value) === 'neoenergia' ? 'Neoenergia' : value;
}

function canonicalProfileKind(value: string): 'neoenergia' | 'vencer' {
  return normalize(value) === 'vencer' ? 'vencer' : 'neoenergia';
}

function isCancelOrderValue(value: string): boolean {
  return /^cancelar\s+(?:a\s+)?ordem$/.test(normalize(value));
}

function parseQuantity(value: string): number {
  const match = value.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

type AdminSaveStatus = 'idle' | 'saving' | 'saved' | 'error';
type SupplementalImportInput = { fileName: string; sheetName: string; sourceColumns: string[]; orders: Omit<Order, 'id' | 'status'>[] };
type SupplementalImportResult = { addedCount: number; duplicateCount: number; excludedCount: number; importRecord: ImportRecord; orders: Order[] };
type PortfolioExportSnapshot = { sync: SyncCursor; orderCount: number };

function isPortfolioSheet(workbook: ParsedWorkbook['workbook'], sheetName: string): boolean {
  const headers = Object.keys(rowsFromSheet(workbook, sheetName)[0]?.values ?? {}).map(normalizeHeader);
  const hasOrder = headers.includes('num consequencia') || headers.includes('ordem') || headers.includes('os');
  return hasOrder && headers.includes('empresa') && headers.includes('equipe') && headers.includes('responsavel');
}

function portfolioSheets(workbook: ParsedWorkbook['workbook']): string[] {
  return workbook.SheetNames.filter((name) => isPortfolioSheet(workbook, name));
}

function chooseImportSheet(workbook: ParsedWorkbook['workbook']): string {
  const sheets = portfolioSheets(workbook);
  const masterSheet = sheets.find((name) => normalize(name) === 'acompanhamento');
  return masterSheet || (sheets.length === 1 ? sheets[0] : '');
}

function quantityUnit(value: string): string {
  return value.replace(/-?\d+(?:[.,]\d+)?/, '').trim();
}

function formatDate(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

function statusText(status: OrderStatus): string {
  if (status === 'executada') return 'Executada';
  if (status === 'impedimento') return 'Impedimento';
  return 'Pendente';
}

function reportedStatus(order: Pick<Order, 'status' | 'situacaoRegistro'>): OrderStatus {
  return order.situacaoRegistro || order.status;
}

function hasReportedImpediment(order: Pick<Order, 'status' | 'situacaoRegistro'>): boolean {
  return reportedStatus(order) === 'impedimento';
}

function Brand({ small = false }: { small?: boolean }) {
  return (
    <div className={'brand' + (small ? ' brand-small' : '')} aria-label="Neoenergia">
      <span className="brand-dot" aria-hidden="true" />
      <span>NEOENERGIA</span>
    </div>
  );
}

function StatusBadge({ status }: { status: OrderStatus }) {
  return <span className={'status-badge status-' + status}>{statusText(status)}</span>;
}

function PhotoEvidence({ photo, orderNumber }: { photo: string; orderNumber: string }) {
  return (
    <a className="evidence-link" href={photo} target="_blank" rel="noreferrer" aria-label={`Abrir foto da ordem ${orderNumber}`}>
      <img src={photo} alt={`Evidência fotográfica da ordem ${orderNumber}`} loading="lazy" />
      <span>Abrir foto</span>
    </a>
  );
}

async function prepareEvidencePhoto(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Não foi possível preparar a imagem.');
    for (const maxDimension of [1600, 1280, 1000]) {
      const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.82, 0.68]) {
        const blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Não foi possível preparar a imagem.')), 'image/jpeg', quality);
        });
        if (blob.size <= 1200 * 1024) {
          return await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(new Error('Não foi possível ler a imagem.'));
            reader.readAsDataURL(blob);
          });
        }
      }
    }
  } finally {
    bitmap.close();
  }
  throw new Error('A imagem é muito grande. Escolha outra foto.');
}

function ExecutionNotificationStack({ items, onDismiss }: { items: ExecutionNotification[]; onDismiss: (id: string) => void }) {
  if (items.length === 0) return null;
  return (
    <aside className="execution-notification-stack" aria-label="Notificações de execução" aria-live="polite">
      {items.map((item) => (
        <article className="execution-notification" key={item.id} role="status">
          <button type="button" className="notification-dismiss" aria-label="Fechar notificação" onClick={() => onDismiss(item.id)}>×</button>
          <span className="notification-eyebrow">Ordem atualizada</span>
          <strong>{item.registeredBy || item.team} {item.status === 'executada' ? 'concluiu uma ordem' : 'registrou um impedimento'}</strong>
          <span>OS {item.orderNumber} · {item.team}</span>
          {item.service && <small>{item.service}{item.quantity !== undefined ? ` · ${item.quantity} realizada(s)` : ''}</small>}
          <small>{formatDate(item.occurredAt)}</small>
        </article>
      ))}
    </aside>
  );
}

export default function App() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [profiles, setProfiles] = useState<AccessProfile[]>([]);
  const [imports, setImports] = useState<ImportRecord[]>([]);
  const [session, setSession] = useState<SessionProfile | null>(null);
  const [adminMode, setAdminMode] = useState(false);
  const [supervisorLoginOpen, setSupervisorLoginOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const [adminSaveStatus, setAdminSaveStatus] = useState<AdminSaveStatus>('idle');
  const [adminSaveError, setAdminSaveError] = useState('');
  const [executionNotifications, setExecutionNotifications] = useState<ExecutionNotification[]>([]);
  const [saveRevision, setSaveRevision] = useState(0);
  const dirtyRevision = useRef(0);
  const adminDirty = useRef(false);
  const dirtyAdminSections = useRef(new Set<'orders' | 'profiles' | 'imports'>());
  const syncCursor = useRef<SyncCursor | null>(null);
  const seenNotificationIds = useRef(new Set<string>());

  function rememberOwnExecution(order: Order) {
    if (order.protocolo) seenNotificationIds.current.add(order.protocolo);
  }

  function dismissExecutionNotification(id: string) {
    setExecutionNotifications((current) => current.filter((item) => item.id !== id));
  }

  function applyState(state: SharedAppState) {
    setOrders(state.orders);
    setProfiles(state.profiles);
    setImports(state.imports);
    if (state.sync) syncCursor.current = state.sync;
  }

  useEffect(() => {
    let active = true;
    apiRequest<{ session: { isAdmin: boolean; kind: string; label: string; team: string; responsible?: string; operatorName: string }; state: { orders: Order[]; profiles: AccessProfile[]; imports: ImportRecord[] } }>('/api/session')
      .then(({ session: remoteSession, state }) => {
        if (!active) return;
        applyState(state);
        setAdminMode(remoteSession.isAdmin);
        if (!remoteSession.isAdmin) setSession(remoteSession as SessionProfile);
        setConnectionError('');
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : '';
        if (message !== 'Sem sessão.') setConnectionError(message || 'Não foi possível conectar ao servidor.');
      })
      .finally(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, []);

  async function login(kind: ProfileKind | 'admin' | '', code: string, password: string) {
    const response = await apiRequest<{ session: { isAdmin: boolean; kind: string; label: string; team: string; responsible?: string; operatorName: string }; state: { orders: Order[]; profiles: AccessProfile[]; imports: ImportRecord[] } }>('/api/login', {
      method: 'POST',
      body: JSON.stringify({ kind, code, password }),
    });
    applyState(response.state);
    setConnectionError('');
    setSupervisorLoginOpen(false);
    setAdminMode(response.session.isAdmin);
    if (response.session.isAdmin) setSession(null);
    else setSession(response.session as SessionProfile);
  }

  async function logout() {
    try { await apiRequest('/api/logout', { method: 'POST', body: '{}' }); } catch { /* Encerrar a tela também remove o uso local da sessão. */ }
    setAdminMode(false);
    setSession(null);
    setSupervisorLoginOpen(false);
    setOrders([]);
    setProfiles([]);
    setImports([]);
    setExecutionNotifications([]);
    seenNotificationIds.current.clear();
  }

  function markAdminStateDirty(section?: 'orders' | 'profiles' | 'imports') {
    if (!adminMode) return;
    if (section) dirtyAdminSections.current.add(section);
    else {
      dirtyAdminSections.current.add('orders');
      dirtyAdminSections.current.add('profiles');
      dirtyAdminSections.current.add('imports');
    }
    adminDirty.current = true;
    setAdminSaveError('');
    setAdminSaveStatus('saving');
    dirtyRevision.current += 1;
    setSaveRevision(dirtyRevision.current);
  }

  function updateOrders(next: Order[]) { setOrders(next); markAdminStateDirty('orders'); }
  function updateProfiles(next: AccessProfile[]) { setProfiles(next); markAdminStateDirty('profiles'); }
  function updateImports(next: ImportRecord[]) { setImports(next); markAdminStateDirty('imports'); }

  async function importSupplementalOrders(input: SupplementalImportInput): Promise<SupplementalImportResult> {
    const response = await apiRequest<SupplementalImportResult>('/api/admin/orders/import', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    if (response.orders.length) setOrders((current) => [...current, ...response.orders]);
    setImports((current) => [response.importRecord, ...current]);
    return response;
  }

  async function clearCurrentPortfolio(expectedSync: SyncCursor): Promise<void> {
    const response = await apiRequest<{ deletedCount: number; sync: SyncCursor }>('/api/admin/orders/clear', {
      method: 'POST',
      body: JSON.stringify({ expectedSync }),
    });
    syncCursor.current = response.sync;
    adminDirty.current = false;
    dirtyAdminSections.current.delete('orders');
    setOrders([]);
    setAdminSaveError('');
    setAdminSaveStatus('saved');
  }

  useEffect(() => {
    if (!ready || !adminMode || !adminDirty.current) return;
    const revision = saveRevision;
    const changedParts = [...dirtyAdminSections.current];
    const timer = window.setTimeout(() => {
      void apiRequest('/api/admin/state', {
        method: 'POST',
        body: JSON.stringify({ orders, profiles, imports, changedParts }),
      }).then(() => {
        if (dirtyRevision.current === revision) {
          adminDirty.current = false;
          dirtyAdminSections.current.clear();
          setAdminSaveError('');
          setAdminSaveStatus('saved');
        }
      }).catch((error: unknown) => {
        if (dirtyRevision.current === revision) {
          setAdminSaveError(error instanceof Error ? error.message : 'Falha desconhecida ao salvar.');
          setAdminSaveStatus('error');
        }
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [ready, adminMode, saveRevision, orders, profiles, imports]);

  useEffect(() => {
    if (!ready || (!adminMode && !session)) return;
    let active = true;
    let refreshing = false;
    const refresh = async () => {
      if (!active || refreshing || document.visibilityState !== 'visible') return;
      if (adminMode && adminDirty.current) return;
      refreshing = true;
      try {
        const state = await readSharedState(syncCursor.current);
        if (!active) return;
        const isFullSync = state.full !== false;
        if (state.sync) syncCursor.current = state.sync;
        const newNotifications = (state.notifications ?? []).filter((item) => !seenNotificationIds.current.has(item.id));
        if (newNotifications.length) {
          for (const item of newNotifications) seenNotificationIds.current.add(item.id);
          setExecutionNotifications((current) => [...current, ...newNotifications].slice(-4));
        }
        if (state.unchanged) return;
        if (isFullSync) {
          setOrders((current) => JSON.stringify(current) === JSON.stringify(state.orders) ? current : state.orders);
          if (adminMode) {
            setProfiles((current) => JSON.stringify(current) === JSON.stringify(state.profiles) ? current : state.profiles);
            setImports((current) => JSON.stringify(current) === JSON.stringify(state.imports) ? current : state.imports);
          }
        } else if (state.orders.length) {
          const changedOrders = new Map(state.orders.map((order) => [order.id, order]));
          setOrders((current) => {
            const currentIds = new Set(current.map((order) => order.id));
            const merged = current.map((order) => changedOrders.get(order.id) ?? order);
            for (const order of state.orders) if (!currentIds.has(order.id)) merged.push(order);
            return merged;
          });
        }
      } catch {
        // A próxima atualização tenta novamente sem interromper a tela atual.
      } finally {
        refreshing = false;
      }
    };
    const timer = window.setInterval(() => { void refresh(); }, SYNC_POLL_INTERVAL_MS);
    const onVisibilityChange = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [ready, adminMode, session]);

  if (!ready) return <main className="login-page"><section className="login-card"><div className="login-brand-panel"><Brand /></div><h1>Conectando ao sistema</h1><p className="login-intro">Carregando os dados compartilhados.</p></section></main>;
  if (connectionError && !session && !adminMode) return <main className="login-page"><section className="login-card"><div className="login-brand-panel"><Brand /></div><h1>Servidor indisponível</h1><p className="login-intro">{connectionError}</p><button className="button button-primary button-full" onClick={() => window.location.reload()}>Tentar novamente</button></section></main>;

  if (adminMode) {
    return (
      <>
        <AdminApp
          orders={orders}
          setOrders={updateOrders}
          onImportSupplemental={importSupplementalOrders}
          onClearPortfolio={clearCurrentPortfolio}
          profiles={profiles}
          setProfiles={updateProfiles}
          imports={imports}
          setImports={updateImports}
          saveStatus={adminSaveStatus}
          saveError={adminSaveError}
          onRetrySave={() => {
            if (dirtyAdminSections.current.size) {
              const pending = [...dirtyAdminSections.current];
              for (const section of pending) markAdminStateDirty(section);
            } else markAdminStateDirty();
          }}
          onLogout={() => { void logout(); }}
        />
        <ExecutionNotificationStack items={executionNotifications} onDismiss={dismissExecutionNotification} />
      </>
    );
  }

  if (session) {
    return (
      <>
        <FieldApp session={session} orders={orders} setOrders={setOrders} onExecutionSaved={rememberOwnExecution} onLogout={() => { void logout(); }} />
        <ExecutionNotificationStack items={executionNotifications} onDismiss={dismissExecutionNotification} />
      </>
    );
  }

  if (supervisorLoginOpen) {
    return <SupervisorLogin onBack={() => setSupervisorLoginOpen(false)} onLogin={(code, password) => login('admin', code, password)} />;
  }

  return <LoginScreen onLogin={(kind, code, password) => login(kind, code, password)} onOpenAdmin={() => setSupervisorLoginOpen(true)} />;
}

function LoginScreen({
  onLogin,
  onOpenAdmin,
}: {
  onLogin: (kind: 'neoenergia' | 'vencer', code: string, password: string) => Promise<void>;
  onOpenAdmin: () => void;
}) {
  const [kind, setKind] = useState<'neoenergia' | 'vencer'>('neoenergia');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError('');
    setSubmitting(true);
    try {
      await onLogin(kind, code, password);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Não foi possível validar o acesso.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-card">
        <div className="login-brand-panel"><Brand /></div>
        <h1>Acesso da equipe</h1>
        <p className="login-intro">Escolha a empresa do acesso e informe o código e a senha fornecidos pelo supervisor.</p>

        <form onSubmit={handleSubmit} className="login-form">
          <div className="segmented-control segmented-two" role="tablist" aria-label="Empresa da equipe">
            <button type="button" role="tab" aria-selected={kind === 'neoenergia'} className={'segment' + (kind === 'neoenergia' ? ' active' : '')} onClick={() => { setKind('neoenergia'); setError(''); }}>Neoenergia</button>
            <button type="button" role="tab" aria-selected={kind === 'vencer'} className={'segment' + (kind === 'vencer' ? ' active' : '')} onClick={() => { setKind('vencer'); setError(''); }}>Vencer</button>
          </div>
          <label className="field-group">
            <span>Código de acesso</span>
            <input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="Ex.: NEO-1524" autoComplete="username" required />
          </label>

          <label className="field-group">
            <span>Senha</span>
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder="Digite a senha do perfil" autoComplete="current-password" required />
          </label>

          {error && <div className="inline-error" role="alert">{error}</div>}
          <button className="button button-primary button-full" type="submit" disabled={submitting}>{submitting ? 'Validando acesso…' : 'Entrar nas ordens'}</button>
        </form>

        <p className="login-note">As ordens aparecem conforme o perfil autorizado pelo supervisor.</p>
        <button className="button button-outline button-full" onClick={onOpenAdmin}>Acesso do supervisor</button>

      </section>
    </main>
  );
}

function SupervisorLogin({ onBack, onLogin }: { onBack: () => void; onLogin: (code: string, password: string) => Promise<void> }) {
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    try {
      await onLogin(code, password);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Não foi possível validar o acesso.');
    }
  }

  return (
    <main className="login-page">
      <section className="login-card">
        <div className="login-brand-panel"><Brand /></div>
        <h1>Área do supervisor</h1>
        <p className="login-intro">Entre com o acesso administrativo para consultar e administrar as carteiras.</p>
        <form onSubmit={submit} className="login-form">
          <label className="field-group"><span>Código do supervisor</span><input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} autoComplete="username" /></label>
          <label className="field-group"><span>Senha</span><input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" /></label>
          {error && <div className="inline-error" role="alert">{error}</div>}
          <button className="button button-primary button-full" type="submit">Entrar na administração</button>
        </form>
        <button className="button button-ghost button-full" onClick={onBack}>Voltar ao acesso das equipes</button>
      </section>
    </main>
  );
}

function FieldApp({
  session,
  orders,
  setOrders,
  onExecutionSaved,
  onLogout,
}: {
  session: SessionProfile;
  orders: Order[];
  setOrders: (orders: Order[]) => void;
  onExecutionSaved: (order: Order) => void;
  onLogout: () => void;
}) {
  const [page, setPage] = useState<'lista' | 'registro' | 'protocolo'>('lista');
  const [tab, setTab] = useState<'pendentes' | 'executadas'>('pendentes');
  const [query, setQuery] = useState('');
  const [orderId, setOrderId] = useState<string | null>(null);
  const [lastSaved, setLastSaved] = useState<Order | null>(null);
  const [quantity, setQuantity] = useState<number | null>(null);
  const [executionMode, setExecutionMode] = useState<'executada' | 'impedimento'>('executada');
  const [observation, setObservation] = useState('');
  const [reason, setReason] = useState('');
  const [photo, setPhoto] = useState('');
  const [photoLoading, setPhotoLoading] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const hasUnsavedDraft = page === 'registro' && (
    quantity !== null || observation.trim().length > 0 || reason.length > 0 || photo.length > 0 || photoLoading
  );

  useEffect(() => {
    if (!hasUnsavedDraft) return;

    const confirmBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', confirmBeforeLeaving);
    return () => window.removeEventListener('beforeunload', confirmBeforeLeaving);
  }, [hasUnsavedDraft]);

  const assignedOrders = useMemo(() => orders.filter((order) => {
    const kind = canonicalProfileKind(session.kind);
    const matchesCompany = canonicalCompany(order.empresa) === kind;
    const matchesTeam = !session.team || normalize(order.equipe) === normalize(session.team);
    const matchesResponsible = session.responsible
      ? normalize(order.responsavel) === normalize(session.responsible)
      : Boolean(session.team);
    return matchesCompany && matchesTeam && matchesResponsible;
  }), [orders, session]);

  const filteredOrders = useMemo(() => assignedOrders.filter((order) => {
    const isDone = order.status !== 'pendente';
    const matchesTab = tab === 'pendentes' ? !isDone : isDone;
    const search = normalize(query);
    const matchesSearch = !search || [order.numConsequencia, order.alimentador, order.barramento, order.servico, order.responsavel, order.registradoPor]
      .some((value) => normalize(value || '').includes(search));
    return matchesTab && matchesSearch;
  }), [assignedOrders, query, tab]);

  const selectedOrder = orders.find((order) => order.id === orderId) ?? null;

  function leaveExecutionForm() {
    if (hasUnsavedDraft && !window.confirm('Há informações do serviço ainda não enviadas. Se sair agora, elas serão perdidas. Deseja sair mesmo assim?')) return;
    setPage('lista');
  }

  function openOrder(order: Order) {
    setOrderId(order.id);
    setQuantity(null);
    setExecutionMode('executada');
    setObservation('');
    setReason('');
    setPhoto('');
    setPhotoLoading(false);
    setError('');
    setPage('registro');
  }

  async function handlePhoto(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = event.target.files?.[0];
    if (!file) return;
    input.value = '';
    setError('');
    setPhotoLoading(true);
    try {
      setPhoto(await prepareEvidencePhoto(file));
    } catch (photoError) {
      setPhoto('');
      setError(photoError instanceof Error ? photoError.message : 'Não foi possível preparar essa foto. Tente outra imagem.');
    } finally {
      setPhotoLoading(false);
    }
  }

  async function saveExecution() {
    if (saving) return;
    if (!selectedOrder) return;
    if (executionMode === 'impedimento' && (!reason || !observation.trim())) {
      setError('Informe o motivo e explique o impedimento antes de salvar.');
      return;
    }
    if (executionMode === 'executada' && quantity === null) {
      setError('Informe a quantidade realmente executada para este serviço.');
      return;
    }
    if (executionMode === 'executada' && quantity !== null && quantity < 0) {
      setError('A quantidade realizada não pode ser negativa.');
      return;
    }
    if (executionMode === 'executada' && quantity !== null && quantity < parseQuantity(selectedOrder.qtdAjustada) && !observation.trim()) {
      setError('Explique na observação por que a quantidade executada ficou abaixo da ajustada.');
      return;
    }
    setError('');
    setSaving(true);
    try {
      const response = await apiRequest<{ order: Order }>('/api/executions', {
        method: 'POST',
        body: JSON.stringify({
          orderId: selectedOrder.id,
          status: executionMode,
          qtdExecutada: executionMode === 'executada' ? quantity : undefined,
          observacao: observation.trim(),
          motivoImpedimento: executionMode === 'impedimento' ? reason : undefined,
          foto: executionMode === 'impedimento' ? photo : undefined,
        }),
      });
      const updated = response.order;
      onExecutionSaved(updated);
      setOrders(orders.map((order) => order.id === updated.id ? updated : order));
      setLastSaved(updated);
      setPage('protocolo');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Não foi possível registrar a execução.');
    } finally {
      setSaving(false);
    }
  }

  if (page === 'protocolo' && lastSaved) {
    return (
      <main className="field-page">
        <div className="field-shell protocol-shell">
          <Brand />
          <div className="success-mark" aria-hidden="true">✓</div>
          <h1>Registro confirmado</h1>
          <p className="muted">A ordem foi atualizada no histórico da equipe.</p>
          <section className="protocol-card">
            <span className="eyebrow">Protocolo de auditoria</span>
            <strong className="protocol-code">{lastSaved.protocolo}</strong>
          </section>
          <h2 className="section-label">Registro realizado</h2>
          <section className="detail-card protocol-details">
            <Detail label="Ordem" value={lastSaved.numConsequencia} />
            <Detail label="Equipe" value={lastSaved.equipe + ' • ' + kindLabels[session.kind]} />
            <Detail label="Responsável" value={lastSaved.responsavel || '—'} />
            <Detail label="Registrado por" value={lastSaved.registradoPor || '—'} />
            <Detail label="Quantidade" value={lastSaved.qtdExecutada === undefined ? 'Sem execução (impedimento)' : lastSaved.qtdExecutada + ' realizada(s)'} />
            <Detail label="Situação" value={statusText(reportedStatus(lastSaved))} />
            <Detail label="Data" value={formatDate(lastSaved.dataRegistro)} />
          </section>
          <button className="button button-primary button-full" onClick={() => { setPage('lista'); setTab(lastSaved.status === 'pendente' ? 'pendentes' : 'executadas'); }}>Voltar às ordens</button>
          <p className="small-note">Guarde o número para consulta e conferência posterior.</p>
        </div>
      </main>
    );
  }

  if (page === 'registro' && selectedOrder) {
    const unit = quantityUnit(selectedOrder.qtdAjustada);
    return (
      <main className="field-page">
        <div className="field-shell">
          <div className="field-header"><Brand /><span className="team-chip">{session.team || session.responsible || kindLabels[session.kind]}</span></div>
          <button className="back-link" onClick={leaveExecutionForm}>← Voltar às ordens</button>
          <h1>{executionMode === 'impedimento' ? 'Registrar impedimento' : 'Registrar execução'}</h1>
          <OrderSummary order={selectedOrder} />

          <div className="segmented-control segmented-two status-choice" role="group" aria-label="Situação do serviço">
            <button type="button" className={executionMode === 'executada' ? 'segment active' : 'segment'} onClick={() => { setExecutionMode('executada'); setError(''); }}>Executado</button>
            <button type="button" className={executionMode === 'impedimento' ? 'segment active' : 'segment'} onClick={() => { setExecutionMode('impedimento'); setError(''); }}>Impedimento</button>
          </div>

          {executionMode === 'executada' ? (
            <>
              <label className="section-label quantity-label" htmlFor="quantity-completed">Quantidade realmente executada</label>
              <div className="quantity-stepper">
                <button type="button" className="step-button" aria-label="Diminuir quantidade" onClick={() => setQuantity((value) => Math.max(0, Math.round(((value ?? 0) - 1) * 100) / 100))}>−</button>
                <div className="quantity-value"><input id="quantity-completed" className="quantity-number-input" type="number" min="0" step="0.01" value={quantity ?? ''} onChange={(event) => setQuantity(event.target.value === '' ? null : Math.max(0, Number(event.target.value)))} placeholder="0" /><span>{unit || 'unidades'}</span></div>
                <button type="button" className="step-button step-plus" aria-label="Aumentar quantidade" onClick={() => setQuantity((value) => Math.round(((value ?? 0) + 1) * 100) / 100)}>+</button>
              </div>
              <p className="quantity-rule">Quantidade ajustada: {selectedOrder.qtdAjustada || '—'}. Informe o total real; se for menor, explique o motivo na observação.</p>
              <label className="field-group textarea-group">
                <span>Observação {quantity !== null && quantity < parseQuantity(selectedOrder.qtdAjustada) ? '(obrigatória)' : '(opcional)'}</span>
                <textarea value={observation} onChange={(event) => setObservation(event.target.value)} placeholder="Descreva o que foi executado." />
              </label>
            </>
          ) : (
            <>
              <label className="field-group">
                <span>Motivo do impedimento</span>
                <select value={reason} onChange={(event) => setReason(event.target.value)}>
                  <option value="">Selecione o motivo</option>
                  <option>Acesso impedido</option>
                  <option>Serviço não localizado</option>
                  <option>Risco de segurança</option>
                  <option>Condição do serviço diferente do previsto</option>
                  <option>Outro</option>
                </select>
              </label>
              <label className="field-group textarea-group">
                <span>Observação</span>
                <textarea value={observation} onChange={(event) => setObservation(event.target.value)} placeholder="Explique por que o serviço não pôde ser executado." />
              </label>
              <label className="photo-upload">
                <span className="photo-icon">+</span>
                <span><strong>{photoLoading ? 'Preparando foto…' : photo ? 'Foto adicionada' : 'Adicionar foto de constatação'}</strong><small>Escolha a câmera ou uma imagem da galeria.</small></span>
                <input type="file" accept="image/*" onChange={handlePhoto} />
              </label>
              {photo && <img className="photo-preview" src={photo} alt="Prévia da foto de constatação" />}
            </>
          )}

          {error && <div className="inline-error" role="alert">{error}</div>}
          <button className="button button-primary button-full" onClick={saveExecution} disabled={saving || photoLoading}>
            {photoLoading ? 'Preparando foto…' : saving ? 'Salvando…' : executionMode === 'impedimento' ? 'Registrar impedimento' : 'Salvar e gerar protocolo'}
          </button>
          <p className="small-note">O registro inclui responsável, equipe, data e horário.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="field-page">
      <div className="field-shell field-list-shell">
        <div className="field-header"><Brand /><span className="team-chip">{session.team || session.responsible || kindLabels[session.kind]}</span></div>
        <div className="field-identity">
          <div><span className="eyebrow">Acesso da equipe</span><strong>{session.operatorName}</strong></div>
          <button className="text-button logout-button" onClick={onLogout}>Sair</button>
        </div>
        {session.responsible && <div className="responsible-banner"><span>Responsável vinculado</span><strong>{session.responsible}</strong></div>}
        <h1>Ordens da equipe</h1>
        <p className="muted">{assignedOrders.filter((order) => order.status === 'pendente').length} pendentes · ordens vinculadas ao seu acesso</p>

        <div className="segmented-control segmented-two list-tabs">
          <button type="button" className={tab === 'pendentes' ? 'segment active' : 'segment'} onClick={() => setTab('pendentes')}>Pendentes {assignedOrders.filter((order) => order.status === 'pendente').length}</button>
          <button type="button" className={tab === 'executadas' ? 'segment active' : 'segment'} onClick={() => setTab('executadas')}>Registros {assignedOrders.filter((order) => order.status !== 'pendente').length}</button>
        </div>

        <label className="search-field">
          <span aria-hidden="true">⌕</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tab === 'executadas' ? 'Buscar registro, ordem ou quem executou' : 'Buscar ordem, alimentador ou barramento'} />
          {query && <button type="button" aria-label="Limpar busca" onClick={() => setQuery('')}>×</button>}
        </label>

        <div className="order-card-list">
          {filteredOrders.map((order) => (
            <article className="order-card" key={order.id}>
              <div className="order-card-top"><span className="order-id">OS {order.numConsequencia}</span><StatusBadge status={order.status} /></div>
              <h2>{order.servico || 'Serviço sem descrição'}</h2>
              <p className="order-location">{order.endereco || [order.alimentador, order.barramento].filter(Boolean).join(' · ')}</p>
              <div className="order-card-facts">
                <span>Previsto: <strong>{order.qtdAjustada || '—'}</strong></span>
                <span>Alimentador: <strong>{order.alimentador || '—'}</strong></span>
              </div>
              {hasReportedImpediment(order) && (
                <div className="field-impediment-note">
                  <strong>Impedimento registrado; a ordem continua pendente.</strong>
                  {order.motivoImpedimento && <span>{order.motivoImpedimento}</span>}
                  {order.observacao && <span>{order.observacao}</span>}
                  {order.foto && <PhotoEvidence photo={order.foto} orderNumber={order.numConsequencia} />}
                </div>
              )}
              {tab === 'pendentes' ? (
                <button className="button button-primary button-full" onClick={() => openOrder(order)}>Registrar execução</button>
              ) : (
                <div className="completed-summary">
                  <span>{order.qtdExecutada === undefined ? order.motivoImpedimento || 'Impedimento registrado' : 'Executado: ' + order.qtdExecutada + (quantityUnit(order.qtdAjustada) ? ' ' + quantityUnit(order.qtdAjustada) : '')}</span>
                  <small>{order.qtdExecutada === undefined ? 'Registrado por: ' : 'Executado por: '}{order.registradoPor || '—'}</small>
                  <small>Protocolo: {order.protocolo || '—'}</small>
                </div>
              )}
              <details className="order-extra-details">
                <summary>Ver detalhes</summary>
                <div><Detail label="Barramento" value={order.barramento || '—'} /><Detail label="Empresa" value={companyLabel(order.empresa) || '—'} /><Detail label="Equipe" value={order.equipe} /><Detail label="Avanço" value={order.avanco || '—'} /><Detail label="Responsável" value={order.responsavel || '—'} /></div>
              </details>
            </article>
          ))}
          {filteredOrders.length === 0 && <div className="empty-state"><strong>Nenhuma ordem encontrada</strong><span>Confira a busca ou fale com o supervisor.</span></div>}
        </div>
        <p className="small-note field-footnote">Sua carteira é definida pelo perfil de acesso e pela administração.</p>
      </div>
    </main>
  );
}

function OrderSummary({ order }: { order: Order }) {
  return (
    <section className="detail-card order-summary">
      <span className="eyebrow">OS {order.numConsequencia}</span>
      <h2>{order.servico || 'Serviço'}</h2>
      <p>{order.endereco || [order.alimentador, order.barramento].filter(Boolean).join(' · ')}</p>
      <div className="summary-location"><span>Alimentador: {order.alimentador || '—'}</span><span>Barramento: {order.barramento || '—'}</span></div>
      <strong>Previsto: {order.qtdAjustada || '—'}</strong>
    </section>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="detail-row"><span>{label}</span><strong>{value}</strong></div>;
}

function AdminApp({
  orders,
  setOrders,
  onImportSupplemental,
  onClearPortfolio,
  profiles,
  setProfiles,
  imports,
  setImports,
  saveStatus,
  saveError,
  onRetrySave,
  onLogout,
}: {
  orders: Order[];
  setOrders: (orders: Order[]) => void;
  onImportSupplemental: (input: SupplementalImportInput) => Promise<SupplementalImportResult>;
  onClearPortfolio: (expectedSync: SyncCursor) => Promise<void>;
  profiles: AccessProfile[];
  setProfiles: (profiles: AccessProfile[]) => void;
  imports: ImportRecord[];
  setImports: (imports: ImportRecord[]) => void;
  saveStatus: AdminSaveStatus;
  saveError: string;
  onRetrySave: () => void;
  onLogout: () => void;
}) {
  const [page, setPage] = useState<AdminPage>('painel');
  const [navOpen, setNavOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [teamFilter, setTeamFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [serviceFilter, setServiceFilter] = useState('');
  const [createdProfile, setCreatedProfile] = useState<AccessProfile | null>(null);

  useEffect(() => {
    if (!createdProfile) return;
    const warnAboutOneTimePassword = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnAboutOneTimePassword);
    return () => window.removeEventListener('beforeunload', warnAboutOneTimePassword);
  }, [createdProfile]);
  const filteredOrders = useMemo(() => orders.filter((order) => {
    const searchValue = normalize(search);
    const textMatch = !searchValue || [order.numConsequencia, order.equipe, order.servico, order.protocolo, order.responsavel, order.motivoImpedimento, order.observacao]
      .some((value) => normalize(value || '').includes(searchValue));
    const teamMatch = !teamFilter || order.equipe === teamFilter;
    const statusMatch = !statusFilter || (statusFilter === 'impedimento' ? hasReportedImpediment(order) : order.status === statusFilter);
    const serviceMatch = !serviceFilter || order.servico === serviceFilter;
    return textMatch && teamMatch && statusMatch && serviceMatch;
  }), [orders, search, teamFilter, statusFilter, serviceFilter]);

  function exportCurrent() {
    void exportControlWorkbook(filteredOrders, 'controle-execucao-neoenergia.xlsx');
  }
  function exportPortfolio(): Promise<void> {
    const date = new Date().toISOString().slice(0, 10);
    return exportControlWorkbook(orders, `carteira-completa-neoenergia-${date}.xlsx`);
  }
  async function exportPortfolioForReplacement(): Promise<PortfolioExportSnapshot> {
    const snapshot = await readSharedState();
    if (!snapshot.sync) throw new Error('Não consegui confirmar a versão atual da carteira. Tente novamente.');
    if (snapshot.orders.length === 0) throw new Error('Não há ordens ativas para exportar.');
    const date = new Date().toISOString().slice(0, 10);
    await exportControlWorkbook(snapshot.orders, `carteira-completa-neoenergia-${date}.xlsx`);
    return { sync: snapshot.sync, orderCount: snapshot.orders.length };
  }
  return (
    <div className="admin-shell">
      <aside className={'admin-sidebar' + (navOpen ? ' open' : '')} id="admin-navigation" aria-label="Menu administrativo">
        <Brand small />
        <span className="sidebar-caption">Controle de ordens</span>
        <div className="sidebar-divider" />
        <span className="sidebar-section-label">Administração</span>
        <nav className="admin-nav" aria-label="Navegação administrativa">
          {([
            ['painel', 'Painel', '▦'],
            ['controle', 'Controle', '◔'],
            ['ordens', 'Ordens', '≡'],
            ['importacao', 'Importar planilhas', '↑'],
            ['protocolos', 'Protocolos', '▤'],
            ['acessos', 'Acessos', '♙'],
          ] as [AdminPage, string, string][]).map(([id, label, icon]) => (
            <button key={id} className={page === id ? 'admin-nav-item active' : 'admin-nav-item'} onClick={() => { setPage(id); setNavOpen(false); }}>
              <span className="nav-icon" aria-hidden="true">{icon}</span>{label}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="admin-label"><span className="online-dot" />Supervisor</span>
          <button className="sidebar-text-button logout-button" onClick={onLogout}>Sair da administração</button>
        </div>
      </aside>

      {navOpen && <button type="button" className="sidebar-backdrop" aria-label="Fechar menu" onClick={() => setNavOpen(false)} />}

      <div className="admin-main">
        <header className="admin-topbar">
          <button type="button" className="admin-menu-toggle" aria-label={navOpen ? 'Fechar menu administrativo' : 'Abrir menu administrativo'} aria-controls="admin-navigation" aria-expanded={navOpen} onClick={() => setNavOpen((open) => !open)}><span aria-hidden="true">☰</span></button>
          <div>
            <span className="eyebrow">Controle de execução</span>
            <h1>{pageLabels[page].title}</h1>
            <p>{pageLabels[page].subtitle}</p>
          </div>
          <div className="topbar-actions">
            <span className="period-chip">Dados compartilhados</span>
            <span className={'save-status save-status-' + saveStatus} role="status">
              {saveStatus === 'saving' ? 'Salvando…' : saveStatus === 'saved' ? 'Salvo no servidor' : saveStatus === 'error' ? 'Falha ao salvar' : 'Conectado'}
            </span>
            {saveStatus === 'error' && <button className="text-button" onClick={onRetrySave}>Tentar novamente</button>}
            <button className="button button-primary export-button" onClick={() => { void exportPortfolio(); }}>Exportar carteira</button>
          </div>
        </header>

        {page === 'painel' && <Dashboard orders={orders} setSearch={setSearch} setTeamFilter={setTeamFilter} setStatusFilter={setStatusFilter} setServiceFilter={setServiceFilter} setPage={setPage} />}
        {page === 'controle' && <ControlPage orders={orders} />}
        {page === 'ordens' && (
          <OrdersPage
            orders={filteredOrders}
            query={search}
            setQuery={setSearch}
            teamFilter={teamFilter}
            setTeamFilter={setTeamFilter}
            statusFilter={statusFilter}
            setStatusFilter={setStatusFilter}
            serviceFilter={serviceFilter}
            setServiceFilter={setServiceFilter}
            onExport={exportCurrent}
          />
        )}
        {page === 'importacao' && <ImportPage orders={orders} setOrders={setOrders} imports={imports} setImports={setImports} onExportPortfolio={exportPortfolioForReplacement} onClearPortfolio={onClearPortfolio} onImportSupplemental={onImportSupplemental} saveStatus={saveStatus} />}
        {page === 'protocolos' && <ProtocolsPage orders={orders} />}
        {page === 'acessos' && <AccessPage orders={orders} profiles={profiles} setProfiles={setProfiles} saveStatus={saveStatus} saveError={saveError} onRetrySave={onRetrySave} created={createdProfile} setCreated={setCreatedProfile} />}
      </div>
    </div>
  );
}

function Dashboard({
  orders,
  setSearch,
  setTeamFilter,
  setStatusFilter,
  setServiceFilter,
  setPage,
}: {
  orders: Order[];
  setSearch: (value: string) => void;
  setTeamFilter: (value: string) => void;
  setStatusFilter: (value: string) => void;
  setServiceFilter: (value: string) => void;
  setPage: (page: AdminPage) => void;
}) {
  const executed = orders.filter((order) => order.status === 'executada').length;
  const impediments = orders.filter(hasReportedImpediment).length;
  const teams = [...new Set(orders.map((order) => order.equipe).filter((team) => Boolean(team) && !isCancelOrderValue(team)))];
  const teamStats = teams.map((team) => {
    const assigned = orders.filter((order) => order.equipe === team);
    const complete = assigned.filter((order) => order.status === 'executada').length;
    return { label: team, complete, total: assigned.length, percent: assigned.length ? Math.round(complete / assigned.length * 100) : 0 };
  });
  const contractorGroups = [...new Map(orders
    .filter((order) => order.responsavel && !isCancelOrderValue(order.responsavel) && ['vencer', 'neoenergia'].includes(canonicalCompany(order.empresa)))
    .map((order) => [`${canonicalCompany(order.empresa)}\u0000${order.responsavel}`, { company: canonicalCompany(order.empresa), responsible: order.responsavel }])).values()];
  const contractorStats = contractorGroups.map(({ company, responsible }) => {
      const assigned = orders.filter((order) => canonicalCompany(order.empresa) === company && normalize(order.responsavel) === normalize(responsible));
      const complete = assigned.filter((order) => order.status === 'executada').length;
      return { label: companyLabel(company) + ' • ' + responsible, complete, total: assigned.length, percent: assigned.length ? Math.round(complete / assigned.length * 100) : 0 };
    });

  function quickFilter(status: string) {
    setStatusFilter(status);
    setServiceFilter('');
    setSearch('');
    setTeamFilter('');
    setPage('ordens');
  }

  return (
    <main className="admin-content">
      <section className="stats-grid">
        <StatCard title="Ordens importadas" value={orders.length.toLocaleString('pt-BR')} detail="na carteira ativa" />
        <StatCard title="Executadas" value={executed.toLocaleString('pt-BR')} detail="no período selecionado" tone="success" onClick={() => quickFilter('executada')} />
        <StatCard title="Impedimentos" value={impediments.toLocaleString('pt-BR')} detail="ordens que seguem pendentes" tone="warning" onClick={() => quickFilter('impedimento')} />
        <StatCard title="Equipes ativas" value={teams.length.toLocaleString('pt-BR')} detail="com ordens liberadas" />
      </section>

      <section className="panel consolidated-panel">
        <div className="panel-heading"><h2>Efetivação dos serviços</h2><span className="demo-tag">Carteira ativa</span></div>
        <div className="filter-row">
          <label className="search-field admin-search"><span>⌕</span><input placeholder="Buscar OS, equipe ou protocolo" onChange={(event) => { setSearch(event.target.value); setPage('ordens'); }} /></label>
          <select aria-label="Filtrar equipe" onChange={(event) => { setTeamFilter(event.target.value); setPage('ordens'); }}><option value="">Todas as equipes</option>{teams.map((team) => <option key={team}>{team}</option>)}</select>
          <select aria-label="Filtrar serviço" onChange={(event) => { setServiceFilter(event.target.value); setPage('ordens'); }}><option value="">Todos os serviços</option>{[...new Set(orders.map((order) => order.servico).filter((service) => Boolean(service) && !isCancelOrderValue(service)))].map((service) => <option key={service}>{service}</option>)}</select>
          <select aria-label="Filtrar situação" onChange={(event) => { setStatusFilter(event.target.value); setPage('ordens'); }}><option value="">Todas as situações</option><option value="pendente">Pendente</option><option value="executada">Executada</option><option value="impedimento">Impedimento</option></select>
          <span className="period-chip compact-period">Carteira atual</span>
        </div>
        <OrderTable orders={orders.slice(0, 6)} />
        <p className="table-note">O consolidado usa a quantidade realizada informada pela equipe e mantém a prevista para comparação.</p>
      </section>

      <section className="panel progress-panel">
        <div className="panel-heading"><h2>Efetivação por equipe</h2><span className="muted small">Ordens concluídas no período</span></div>
        <div className="progress-grid">
          {teamStats.map((stat) => <ProgressBar key={stat.label} {...stat} />)}
        </div>
        {contractorStats.length > 0 && (
          <div className="responsible-progress">
            <div className="panel-heading compact-heading"><h3>Efetivação por responsável • Vencer e Neoenergia</h3></div>
            <div className="progress-grid">{contractorStats.map((stat) => <ProgressBar key={stat.label} {...stat} />)}</div>
          </div>
        )}
      </section>
    </main>
  );
}

function ControlPage({ orders }: { orders: Order[] }) {
  const executed = orders.filter((order) => order.status === 'executada').length;
  const impediments = orders.filter(hasReportedImpediment).length;
  const pending = orders.filter((order) => order.status === 'pendente').length;
  const pendingWithoutImpediment = Math.max(0, pending - impediments);
  const total = orders.length;
  const executedPercent = total ? executed / total * 100 : 0;
  const impedimentEnd = total ? (executed + impediments) / total * 100 : 0;
  const donutBackground = total
    ? `conic-gradient(#00a859 0 ${executedPercent}%, #e6a13b ${executedPercent}% ${impedimentEnd}%, #dce6e9 ${impedimentEnd}% 100%)`
    : '#dce6e9';

  const teams = [...new Set(orders.map((order) => order.equipe.trim() || 'Sem equipe'))].filter((team) => !isCancelOrderValue(team));
  const teamStats = teams.map((team) => {
    const assigned = orders.filter((order) => (order.equipe.trim() || 'Sem equipe') === team);
    const complete = assigned.filter((order) => order.status === 'executada').length;
    return { label: team, complete, total: assigned.length, percent: assigned.length ? Math.round(complete / assigned.length * 100) : 0 };
  }).sort((a, b) => b.total - a.total);

  const responsibleGroups = new Map<string, { label: string; orders: Order[] }>();
  orders.forEach((order) => {
    const responsible = order.responsavel.trim();
    if (!responsible || isCancelOrderValue(responsible)) return;
    const company = companyLabel(order.empresa.trim());
    const key = canonicalCompany(company) + '\u0000' + normalize(responsible);
    const existing = responsibleGroups.get(key);
    if (existing) existing.orders.push(order);
    else responsibleGroups.set(key, { label: company ? company + ' • ' + responsible : responsible, orders: [order] });
  });
  const responsibleStats = [...responsibleGroups.values()].map(({ label, orders: groupOrders }) => {
    const complete = groupOrders.filter((order) => order.status === 'executada').length;
    return { label, complete, total: groupOrders.length, percent: groupOrders.length ? Math.round(complete / groupOrders.length * 100) : 0 };
  }).sort((a, b) => b.total - a.total).slice(0, 10);

  const serviceGroups = new Map<string, Order[]>();
  orders.forEach((order) => {
    const service = order.servico.trim() || 'Sem serviço';
    const group = serviceGroups.get(service) ?? [];
    group.push(order);
    serviceGroups.set(service, group);
  });
  const quantityStats = [...serviceGroups.entries()].map(([label, groupOrders]) => {
    const planned = groupOrders.reduce((sum, order) => sum + parseQuantity(order.qtdAjustada), 0);
    const reported = groupOrders.reduce((sum, order) => sum + (order.qtdExecutada ?? 0), 0);
    const considered = groupOrders.reduce((sum, order) => sum + (order.status === 'executada' ? order.qtdExecutada ?? 0 : 0), 0);
    return { label, planned, reported, considered };
  }).sort((a, b) => b.considered - a.considered).slice(0, 8);
  const maxQuantity = Math.max(1, ...quantityStats.map((item) => Math.max(item.planned, item.reported)));
  const quantityText = (value: number) => value.toLocaleString('pt-BR', { maximumFractionDigits: 2 });

  return (
    <main className="admin-content control-page">
      <section className="control-metrics">
        <div className="control-metric"><span>Ordens na carteira</span><strong>{total.toLocaleString('pt-BR')}</strong><small>base atual</small></div>
        <div className="control-metric"><span>Executadas</span><strong className="metric-success">{executed.toLocaleString('pt-BR')}</strong><small>{Math.round(executedPercent)}% da carteira</small></div>
        <div className="control-metric"><span>Com impedimento</span><strong className="metric-warning">{impediments.toLocaleString('pt-BR')}</strong><small>continuam pendentes</small></div>
        <div className="control-metric"><span>Pendentes</span><strong>{pending.toLocaleString('pt-BR')}</strong><small>inclui as com impedimento</small></div>
      </section>

      <section className="control-chart-grid">
        <div className="panel">
          <div className="panel-heading"><div><h2>Situação das ordens</h2><p className="muted">Distribuição da carteira atual</p></div></div>
          <div className="status-chart-layout">
            <div className="status-donut" role="img" aria-label={`${executed} executadas, ${impediments} pendentes com impedimento e ${pendingWithoutImpediment} outras pendentes`} style={{ background: donutBackground }}>
              <div className="status-donut-center"><strong>{total ? Math.round(executedPercent) + '%' : '—'}</strong><span>executadas</span></div>
            </div>
            <div className="status-legend">
              <div className="status-legend-item"><span><i className="status-dot dot-executed" />Executadas</span><strong>{executed}</strong></div>
              <div className="status-legend-item"><span><i className="status-dot dot-impediment" />Pendentes com impedimento</span><strong>{impediments}</strong></div>
              <div className="status-legend-item"><span><i className="status-dot dot-pending" />Outras pendentes</span><strong>{pendingWithoutImpediment}</strong></div>
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-heading"><div><h2>Execução por equipe</h2><p className="muted">Ordens concluídas sobre o total destinado</p></div></div>
          {teamStats.length
            ? <div className="progress-grid control-progress-grid">{teamStats.map((stat) => <ProgressBar key={stat.label} {...stat} />)}</div>
            : <p className="chart-empty">Importe uma carteira para visualizar as equipes.</p>}
        </div>
      </section>

      <section className="control-chart-grid">
        <div className="panel">
          <div className="panel-heading"><div><h2>Quantidades por serviço</h2><p className="muted">Previsto e informado pela equipe</p></div></div>
          <div className="quantity-chart-legend"><span><i className="status-dot dot-plan" />QTD. ajustada</span><span><i className="status-dot dot-reported" />QTD. executada</span></div>
          {quantityStats.length ? <div className="quantity-chart-list">
            {quantityStats.map((item) => (
              <div className="quantity-chart-item" key={item.label}>
                <div className="quantity-chart-meta"><strong title={item.label}>{item.label}</strong><span>Considerada: {quantityText(item.considered)}</span></div>
                <div className="quantity-bar-row"><span>Planilha</span><div className="quantity-bar-track"><i className="quantity-bar-plan" style={{ width: item.planned / maxQuantity * 100 + '%' }} /></div><b>{quantityText(item.planned)}</b></div>
                <div className="quantity-bar-row"><span>Equipe</span><div className="quantity-bar-track"><i className="quantity-bar-reported" style={{ width: item.reported / maxQuantity * 100 + '%' }} /></div><b>{quantityText(item.reported)}</b></div>
              </div>
            ))}
          </div> : <p className="chart-empty">As quantidades aparecerão após importar a carteira.</p>}
          <p className="table-note">A quantidade considerada corresponde à QTD EXECUTADA informada pela equipe. Se ficar abaixo da quantidade ajustada, a observação da ordem deve explicar o motivo.</p>
        </div>

        <div className="panel">
          <div className="panel-heading"><div><h2>Execução por responsável</h2><p className="muted">Ordens concluídas vinculadas a cada responsável</p></div></div>
          {responsibleStats.length
            ? <div className="progress-grid control-progress-grid">{responsibleStats.map((stat) => <ProgressBar key={stat.label} {...stat} />)}</div>
            : <p className="chart-empty">Nenhum responsável foi identificado na carteira.</p>}
        </div>
      </section>
    </main>
  );
}

function StatCard({
  title,
  value,
  detail,
  tone,
  onClick,
}: {
  title: string;
  value: string;
  detail: string;
  tone?: 'success' | 'warning';
  onClick?: () => void;
}) {
  return (
    <button className={'stat-card' + (onClick ? ' clickable' : '')} onClick={onClick} disabled={!onClick}>
      <span>{title}</span><strong className={tone ? 'stat-' + tone : ''}>{value}</strong><small>{detail}</small>
    </button>
  );
}

function ProgressBar({ label, complete, total, percent }: { label: string; complete: number; total: number; percent: number }) {
  return (
    <div className="progress-item">
      <div className="progress-label"><strong>{label}</strong><span>{complete} de {total} ordens</span></div>
      <div className="progress-track"><span style={{ width: percent + '%' }} /></div>
      <small>{percent}% concluído</small>
    </div>
  );
}

function OrderTable({ orders }: { orders: Order[] }) {
  return (
    <div className="table-scroll">
      <table className="admin-table">
        <thead><tr><th>OS</th><th>Equipe</th><th>Serviço</th><th>Previsto</th><th>Executado</th><th>Situação</th><th>Protocolo</th><th>Problema relatado</th><th>Evidência</th></tr></thead>
        <tbody>
          {orders.map((order) => (
            <tr key={order.id}>
              <td>OS {order.numConsequencia}</td><td>{order.equipe}</td><td>{order.servico}</td><td>{order.qtdAjustada || '—'}</td>
              <td>{order.qtdExecutada === undefined ? '—' : order.qtdExecutada + (quantityUnit(order.qtdAjustada) ? ' ' + quantityUnit(order.qtdAjustada) : '')}</td>
              <td><StatusBadge status={order.status} /></td><td>{order.protocolo || '—'}</td>
              <td className="issue-cell">{hasReportedImpediment(order) ? <><strong>{order.motivoImpedimento || 'Impedimento'}</strong>{order.observacao && <span>{order.observacao}</span>}</> : '—'}</td>
              <td>{hasReportedImpediment(order) && order.foto ? <PhotoEvidence photo={order.foto} orderNumber={order.numConsequencia} /> : '—'}</td>
            </tr>
          ))}
          {orders.length === 0 && <tr><td colSpan={9} className="table-empty">Nenhuma ordem para exibir.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function OrdersPage({
  orders,
  query,
  setQuery,
  teamFilter,
  setTeamFilter,
  statusFilter,
  setStatusFilter,
  serviceFilter,
  setServiceFilter,
  onExport,
}: {
  orders: Order[];
  query: string;
  setQuery: (value: string) => void;
  teamFilter: string;
  setTeamFilter: (value: string) => void;
  statusFilter: string;
  setStatusFilter: (value: string) => void;
  serviceFilter: string;
  setServiceFilter: (value: string) => void;
  onExport: () => void;
}) {
  const teams = [...new Set(orders.map((order) => order.equipe).filter((team) => Boolean(team) && !isCancelOrderValue(team)))];
  return (
    <main className="admin-content">
      <section className="panel orders-panel">
        <div className="panel-heading"><div><h2>Ordens da carteira</h2><p className="muted">{orders.length} registros na seleção atual</p></div><button className="button button-secondary" onClick={onExport}>Exportar seleção</button></div>
        <div className="filter-row orders-filter-row">
          <label className="search-field admin-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar OS, equipe, responsável ou protocolo" /></label>
          <select value={teamFilter} onChange={(event) => setTeamFilter(event.target.value)}><option value="">Todas as equipes</option>{teams.map((team) => <option key={team}>{team}</option>)}</select>
          <select value={serviceFilter} onChange={(event) => setServiceFilter(event.target.value)}><option value="">Todos os serviços</option>{[...new Set(orders.map((order) => order.servico).filter((service) => Boolean(service) && !isCancelOrderValue(service)))].map((service) => <option key={service}>{service}</option>)}</select>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">Todas as situações</option><option value="pendente">Pendente</option><option value="executada">Executada</option><option value="impedimento">Impedimento</option></select>
        </div>
        <OrderTable orders={orders} />
      </section>
    </main>
  );
}

function ImportPage({
  orders,
  setOrders,
  imports,
  setImports,
  onExportPortfolio,
  onClearPortfolio,
  onImportSupplemental,
  saveStatus,
}: {
  orders: Order[];
  setOrders: (orders: Order[]) => void;
  imports: ImportRecord[];
  setImports: (imports: ImportRecord[]) => void;
  onExportPortfolio: () => Promise<PortfolioExportSnapshot>;
  onClearPortfolio: (expectedSync: SyncCursor) => Promise<void>;
  onImportSupplemental: (input: SupplementalImportInput) => Promise<SupplementalImportResult>;
  saveStatus: AdminSaveStatus;
}) {
  const [file, setFile] = useState<ParsedWorkbook | null>(null);
  const [sheetName, setSheetName] = useState('');
  const [importMode, setImportMode] = useState<'substituir' | 'complementar'>('substituir');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [auditSnapshot, setAuditSnapshot] = useState<PortfolioExportSnapshot | null>(null);
  const [portfolioDeleted, setPortfolioDeleted] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [deletingPortfolio, setDeletingPortfolio] = useState(false);
  const [importing, setImporting] = useState(false);
  const rows = useMemo(() => file && sheetName ? rowsFromSheet(file.workbook, sheetName) : [], [file, sheetName]);
  const orderRows = useMemo(() => rows.map((row) => mapSpreadsheetRow(row, ''))
    .filter((row) => row.numConsequencia.trim()), [rows]);
  const validRows = useMemo(() => orderRows.filter((row) =>
    Boolean(row.empresa.trim() && row.responsavel.trim() && row.equipe.trim())), [orderRows]);
  const supplementalRows = useMemo(() => validRows.filter((row) => Boolean(row.servico.trim() && row.qtdAjustada.trim())), [validRows]);
  const rowsToPreview = importMode === 'complementar' ? supplementalRows : validRows;
  const excludedRows = orderRows.length - rowsToPreview.length;
  const mappedPreview = rowsToPreview.slice(0, 4);
  const columns = rows[0] ? Object.keys(rows[0].values) : [];

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const selectedFile = event.target.files?.[0];
    if (!selectedFile) return;
    event.target.value = '';
    setError('');
    setMessage('');
    try {
      const workbook = await readWorkbook(selectedFile);
      const selectedSheet = chooseImportSheet(workbook.workbook);
      if (!selectedSheet) {
        setFile(null);
        setSheetName('');
        setError('Não consegui identificar uma aba de ordens. Use uma planilha com número da ordem, EMPRESA, EQUIPE e RESPONSÁVEL.');
        return;
      }
      setFile(workbook);
      setSheetName(selectedSheet);
    } catch {
      setError('Não consegui ler essa planilha. Selecione um arquivo .xlsx válido.');
      setFile(null);
    }
  }

  async function exportCurrentPortfolio() {
    if (orders.length === 0) {
      setError('Ainda não há uma carteira carregada para exportar.');
      return;
    }
    if (saveStatus === 'saving' || saveStatus === 'error') {
      setError('Aguarde o salvamento terminar ou corrija a falha antes de exportar a carteira.');
      return;
    }
    setExporting(true);
    setError('');
    try {
      const snapshot = await onExportPortfolio();
      setAuditSnapshot(snapshot);
      setMessage(`Carteira completa exportada para auditoria (${snapshot.orderCount.toLocaleString('pt-BR')} ordens). Agora o botão de exclusão está liberado.`);
    } catch {
      setError('Não consegui exportar a carteira. Tente novamente antes de substituir os dados do mês.');
    } finally {
      setExporting(false);
    }
  }

  async function deleteCurrentPortfolio() {
    if (!auditSnapshot) return;
    if (saveStatus === 'saving' || saveStatus === 'error') {
      setError('Aguarde o salvamento terminar ou corrija a falha antes de excluir a carteira.');
      return;
    }
    const confirmed = window.confirm(`A carteira atual (${auditSnapshot.orderCount.toLocaleString('pt-BR')} ordens) será removida do sistema. Confirme que o arquivo exportado foi baixado e guardado para auditoria. Deseja continuar?`);
    if (!confirmed) return;
    setDeletingPortfolio(true);
    setError('');
    try {
      await onClearPortfolio(auditSnapshot.sync);
      setAuditSnapshot(null);
      setPortfolioDeleted(true);
      setMessage('Carteira anterior removida do sistema. Agora selecione e importe a carteira do novo mês.');
    } catch (deleteError) {
      setAuditSnapshot(null);
      setError(deleteError instanceof Error ? deleteError.message : 'Não foi possível excluir a carteira atual.');
    } finally {
      setDeletingPortfolio(false);
    }
  }

  async function importRows() {
    if (!file || rows.length === 0 || !sheetName) {
      setError(importMode === 'complementar' ? 'Selecione a planilha com as ordens que serão acrescentadas.' : 'Selecione a planilha da carteira geral.');
      return;
    }
    if (rowsToPreview.length === 0) {
      setError(importMode === 'complementar'
        ? 'Não encontrei ordens completas. Confira número, empresa, equipe, responsável, serviço e quantidade ajustada.'
        : 'Não encontrei ordens com EMPRESA, EQUIPE e RESPONSÁVEL preenchidos.');
      return;
    }

    if (importMode === 'complementar') {
      setImporting(true);
      setError('');
      setMessage('');
      const additions = orderRows.map((mapped) => ({
        ...mapped,
        qtdExecutada: undefined,
        sourceColumns: columns,
        sourceSheet: sheetName,
        sourceFile: file.fileName,
        sourceKind: canonicalCompany(mapped.empresa) === 'vencer' ? 'vencer' as const : 'controle' as const,
      }));
      try {
        const result = await onImportSupplemental({ fileName: file.fileName, sheetName, sourceColumns: columns, orders: additions });
        setMessage(`${result.addedCount.toLocaleString('pt-BR')} nova(s) ordem(ns) acrescentada(s) à carteira.${result.duplicateCount ? ` ${result.duplicateCount} já existia(m) e não foi(ram) duplicada(s).` : ''}${result.excludedCount ? ` ${result.excludedCount} linha(s) incompleta(s) foram ignoradas.` : ''}`);
        setFile(null);
        setSheetName('');
      } catch (importError) {
        setError(importError instanceof Error ? importError.message : 'Não foi possível acrescentar as ordens.');
      } finally {
        setImporting(false);
      }
      return;
    }

    if (validRows.length === 0) {
      setError('Não encontrei ordens com EMPRESA, EQUIPE e RESPONSÁVEL preenchidos.');
      return;
    }
    if (orders.length > 0) {
      setError(auditSnapshot
        ? 'Use primeiro o botão “Excluir carteira deste mês”; depois importe a nova planilha.'
        : 'Exporte a carteira completa e exclua a carteira atual antes de importar a próxima.');
      return;
    }

    const orderKey = (order: Pick<Order, 'numConsequencia' | 'empresa' | 'responsavel'>) =>
      [normalize(order.numConsequencia), canonicalCompany(order.empresa), normalize(order.responsavel)].join('|');
    const scheduledMonth = (order: Pick<Order, 'original'>) => {
      const entry = Object.entries(order.original || {}).find(([header]) => normalizeHeader(header) === 'mes programado');
      return normalize(String(entry?.[1] || ''));
    };
    const previousByKey = new Map(orders.map((order) => [orderKey(order), order]));
    const importedAt = new Date().toISOString();
    const nextOrders: Order[] = validRows.map((mapped, index) => {
      const previous = previousByKey.get(orderKey(mapped));
      const samePortfolioMonth = Boolean(previous && scheduledMonth(previous) && scheduledMonth(previous) === scheduledMonth(mapped));
      return {
        ...mapped,
        id: samePortfolioMonth && previous ? previous.id : `import-${Date.now()}-${index}`,
        status: samePortfolioMonth && previous ? previous.status : 'pendente',
        ...(samePortfolioMonth && previous ? {
          qtdExecutada: previous.qtdExecutada,
          observacao: previous.observacao,
          motivoImpedimento: previous.motivoImpedimento,
          foto: previous.foto,
          protocolo: previous.protocolo,
          registradoPor: previous.registradoPor,
          dataRegistro: previous.dataRegistro,
        } : {}),
        sourceColumns: columns,
        sourceSheet: sheetName,
        sourceFile: file.fileName,
        sourceKind: 'controle',
      };
    });
    setOrders(nextOrders);
    const record: ImportRecord = {
      id: 'import-' + Date.now(),
      fileName: file.fileName,
      source: 'Carteira geral',
      team: 'Carteira geral',
      importedAt,
      orderCount: nextOrders.length,
      sheetName,
    };
    setImports([record, ...imports.filter((item) => !item.id.startsWith('import-demo'))]);
    setAuditSnapshot(null);
    setPortfolioDeleted(false);
    setMessage(`${nextOrders.length.toLocaleString('pt-BR')} ordens importadas da carteira geral.${excludedRows ? ` ${excludedRows} linha(s) com EMPRESA, EQUIPE ou RESPONSÁVEL vazios foram ignoradas.` : ''}`);
    setError('');
  }

  return (
    <main className="admin-content">
      <div className="import-layout">
        <section className="panel import-form-panel">
          <div className="panel-heading"><div><h2>Importar ordens</h2><p className="muted">A carteira geral distribui as ordens pelos perfis de acesso.</p></div><span className="step-chip">Somente supervisor</span></div>
          <div className="segmented-control segmented-two" role="group" aria-label="Tipo de importação">
            <button type="button" className={importMode === 'substituir' ? 'segment active' : 'segment'} onClick={() => { setImportMode('substituir'); setError(''); setMessage(''); }}>Nova carteira do mês</button>
            <button type="button" className={importMode === 'complementar' ? 'segment active' : 'segment'} onClick={() => { setImportMode('complementar'); setError(''); setMessage(''); }}>Acrescentar ordens</button>
          </div>
          {importMode === 'substituir' && orders.length > 0 && <div className="security-note"><strong>Troca mensal da carteira</strong><span>1. Exporte e guarde a carteira atual para auditoria. 2. O botão de exclusão será liberado. 3. Exclua a carteira atual e importe a planilha do novo mês.</span><div className="portfolio-action-row"><button type="button" className="button button-secondary" disabled={exporting || saveStatus === 'saving' || saveStatus === 'error'} onClick={() => { void exportCurrentPortfolio(); }}>{exporting ? 'Exportando…' : 'Exportar carteira completa'}</button><button type="button" className="button button-danger" disabled={!auditSnapshot || deletingPortfolio || saveStatus === 'saving' || saveStatus === 'error'} onClick={() => { void deleteCurrentPortfolio(); }}>{deletingPortfolio ? 'Excluindo…' : 'Excluir carteira deste mês'}</button></div>{auditSnapshot && <span className="success-text">Exportação concluída: {auditSnapshot.orderCount.toLocaleString('pt-BR')} ordens. Exclusão liberada.</span>}</div>}
          {importMode === 'substituir' && orders.length === 0 && portfolioDeleted && <div className="mapping-note"><strong>Carteira anterior excluída</strong><span>Selecione a planilha geral do novo mês e confirme a importação para disponibilizar as ordens às equipes.</span></div>}
          {importMode === 'complementar' && <div className="mapping-note"><strong>Importação complementar</strong><span>As novas ordens serão acrescentadas à carteira atual. As ordens existentes e seus registros serão preservados; números já cadastrados não serão duplicados.</span></div>}
          <label className="upload-dropzone">
            <span className="file-icon">XLSX</span>
            <span><strong>{importMode === 'complementar' ? 'Selecione a planilha com as novas ordens' : 'Selecione a carteira geral do mês'}</strong><small>As abas de apresentação e resumo não serão importadas.</small></span>
            <span className="button button-secondary file-button">Selecionar arquivo</span>
            <input type="file" accept=".xlsx,.xls" onChange={onFile} />
          </label>
          {file && (
            <>
              <div className="file-selected"><div><strong>{file.fileName}</strong><small>{rowsToPreview.length.toLocaleString('pt-BR')} ordens válidas · {columns.length} colunas{excludedRows ? ` · ${excludedRows} linha(s) serão ignoradas` : ''}</small></div>
                <span>{sheetName}</span>
              </div>
              <div className="import-preview">
                <div className="import-preview-heading">
                  <strong>Conferência antes de importar</strong>
                  <small>Mostrando até {Math.min(4, rowsToPreview.length)} de {rowsToPreview.length.toLocaleString('pt-BR')} linhas aceitas. Esta conferência não grava nada.</small>
                </div>
                <div className="table-scroll"><table className="admin-table preview-table"><thead><tr><th>Ordem</th><th>Equipe</th><th>Serviço</th><th>Qtd. ajustada</th><th>Responsável</th></tr></thead>
                  <tbody>{mappedPreview.map((row, index) => <tr key={index}><td>{row.numConsequencia || '—'}</td><td>{row.equipe || '—'}</td><td>{row.servico || '—'}</td><td>{row.qtdAjustada || '—'}</td><td>{row.responsavel || '—'}</td></tr>)}{mappedPreview.length === 0 && <tr><td colSpan={5} className="table-empty">Nenhuma linha atende aos campos obrigatórios.</td></tr>}</tbody>
                </table></div>
                {excludedRows > 0 && <p className="table-note">{excludedRows} linha(s) incompleta(s) serão ignoradas{importMode === 'complementar' ? ' por falta de número, empresa, equipe, responsável, serviço ou quantidade ajustada.' : ' por falta de número, empresa, equipe ou responsável.'}</p>}
              </div>
              <div className="import-actions"><span>{importMode === 'complementar' ? 'Novas linhas precisam ter número, empresa, equipe, responsável, serviço e quantidade.' : 'Linhas sem EMPRESA, EQUIPE ou RESPONSÁVEL não serão incluídas.'}</span><button className="button button-primary" disabled={importing || (importMode === 'substituir' && orders.length > 0)} onClick={() => { void importRows(); }}>{importing ? 'Importando…' : importMode === 'complementar' ? 'Acrescentar à carteira atual' : orders.length > 0 ? 'Exclua a carteira atual primeiro' : 'Importar carteira do novo mês'}</button></div>
            </>
          )}
          {message && <div className="inline-success">{message}</div>}
          {error && <div className="inline-error" role="alert">{error}</div>}
        </section>

        <section className="panel import-history-panel">
          <div className="panel-heading"><div><h2>Importações recentes</h2><p className="muted">Carteiras do mês e ordens complementares</p></div></div>
          <div className="import-history-list">
            {imports.slice(0, 4).map((item) => (
              <article className="import-history-item" key={item.id}>
                <strong>{item.source}</strong><span>{item.fileName}</span><div><small>{formatDate(item.importedAt)}</small><small className="success-text">{item.orderCount} adicionada(s)</small></div>
                {Boolean(item.duplicateCount || item.excludedCount) && <small>{item.duplicateCount || 0} duplicada(s) · {item.excludedCount || 0} incompleta(s) ignorada(s)</small>}
              </article>
            ))}
          </div>
          <div className="mapping-note"><strong>Filtro de linhas incompletas</strong><span>Linhas sem EMPRESA, EQUIPE ou RESPONSÁVEL não entram na carteira. Na importação complementar, também são exigidos serviço e quantidade ajustada.</span></div>
        </section>
      </div>

    </main>
  );
}

function ProtocolsPage({ orders }: { orders: Order[] }) {
  const recorded = orders.filter((order) => order.protocolo);
  return (
    <main className="admin-content">
      <section className="panel orders-panel">
        <div className="panel-heading"><div><h2>Registros de auditoria</h2><p className="muted">Execuções e impedimentos enviados pelas equipes.</p></div><span className="count-chip">{recorded.length} protocolos</span></div>
        <div className="table-scroll"><table className="admin-table protocols-table"><thead><tr><th>Protocolo</th><th>Ordem</th><th>Equipe</th><th>Responsável</th><th>Registrado por</th><th>Resultado do registro</th><th>Problema relatado</th><th>Evidência</th><th>Data</th></tr></thead>
          <tbody>{recorded.map((order) => <tr key={order.id}><td className="protocol-cell">{order.protocolo}</td><td>{order.numConsequencia}</td><td>{order.equipe}</td><td>{order.responsavel || '—'}</td><td>{order.registradoPor || '—'}</td><td><StatusBadge status={reportedStatus(order)} /></td><td className="issue-cell">{hasReportedImpediment(order) ? <><strong>{order.motivoImpedimento || 'Impedimento'}</strong>{order.observacao && <span>{order.observacao}</span>}</> : '—'}</td><td>{order.foto ? <PhotoEvidence photo={order.foto} orderNumber={order.numConsequencia} /> : '—'}</td><td>{formatDate(order.dataRegistro)}</td></tr>)}{recorded.length === 0 && <tr><td colSpan={9} className="table-empty">Nenhum protocolo registrado.</td></tr>}</tbody>
        </table></div>
        <div className="protocol-footnote">Cada protocolo conserva a identificação da ordem, equipe, responsável, operador e horário do registro.</div>
      </section>
    </main>
  );
}

function AccessPage({ orders, profiles, setProfiles, saveStatus, saveError, onRetrySave, created, setCreated }: { orders: Order[]; profiles: AccessProfile[]; setProfiles: (profiles: AccessProfile[]) => void; saveStatus: AdminSaveStatus; saveError: string; onRetrySave: () => void; created: AccessProfile | null; setCreated: (profile: AccessProfile | null) => void }) {
  type NewProfileKind = 'neoenergia' | 'vencer';
  const [showForm, setShowForm] = useState(false);
  const [kind, setKind] = useState<NewProfileKind>('neoenergia');
  const [responsible, setResponsible] = useState('');
  const [operatorName, setOperatorName] = useState('');
  const [label, setLabel] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const responsibleChoices = [...new Set([
    ...orders.filter((order) => canonicalCompany(order.empresa) === kind).map((order) => order.responsavel),
    ...profiles.filter((profile) => canonicalProfileKind(profile.kind) === kind).map((profile) => profile.responsible || ''),
  ].map((value) => value.trim()).filter((value) => value && !isCancelOrderValue(value)))].sort((a, b) => a.localeCompare(b, 'pt-BR'));

  function createAccess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const cleanCode = code.trim().toUpperCase();
    const cleanPassword = password.trim();
    if (!responsible.trim()) {
      setError('Escolha ou informe o valor exato da coluna RESPONSÁVEL.');
      return;
    }
    if (isCancelOrderValue(responsible)) {
      setError('Uma ordem de cancelamento não pode ser usada como responsável de acesso.');
      return;
    }
    if (kind === 'neoenergia' && !orders.some((order) =>
      canonicalCompany(order.empresa) === kind && normalize(order.responsavel) === normalize(responsible.trim()))) {
      setError('Para Neoenergia, selecione um responsável que exista na carteira atual.');
      return;
    }
    if (!operatorName.trim()) {
      setError('Informe o nome que ficará registrado nos protocolos.');
      return;
    }
    if (cleanCode.length < 4) {
      setError('O código de acesso precisa ter pelo menos 4 caracteres.');
      return;
    }
    if (profiles.some((profile) => normalize(profile.code) === normalize(cleanCode))) {
      setError('Esse código já está em uso. Escolha outro.');
      return;
    }
    if (cleanPassword.length < 4) {
      setError('A senha precisa ter pelo menos 4 caracteres.');
      return;
    }
    if (cleanPassword !== confirmPassword.trim()) {
      setError('As senhas não coincidem.');
      return;
    }
    const profile: AccessProfile = {
      id: 'profile-' + Date.now(),
      kind,
      label: label.trim() || `${kindLabels[kind]} • ${responsible.trim()} • ${operatorName.trim()}`,
      operatorName: operatorName.trim(),
      code: cleanCode,
      password: cleanPassword,
      team: '',
      responsible: responsible.trim(),
      active: true,
    };
    setProfiles([...profiles, profile]);
    setCreated(profile);
    setOperatorName('');
    setLabel('');
    setResponsible('');
    setCode('');
    setPassword('');
    setConfirmPassword('');
    setShowForm(false);
  }

  function toggle(profile: AccessProfile) {
    setProfiles(profiles.map((item) => item.id === profile.id ? { ...item, active: !item.active } : item));
  }

  return (
    <main className="admin-content">
      <section className="panel access-panel">
        <div className="panel-heading"><div><h2>Perfis de acesso</h2><p className="muted">Cada acesso libera somente as ordens do responsável selecionado.</p></div><button className="button button-primary" onClick={() => setShowForm((value) => !value)}>+ Criar perfil</button></div>
        <div className="security-note"><strong>Escopo do acesso</strong><span>Escolha Neoenergia ou Vencer e vincule ao RESPONSÁVEL da carteira. O campo equipe/carteira foi removido; Inspetor entra no grupo Neoenergia.</span></div>
        {created && <div className="created-credentials"><div><strong>{saveStatus === 'error' ? 'Acesso ainda não salvo' : saveStatus === 'saved' ? 'Acesso salvo no servidor' : 'Salvando acesso no servidor…'}</strong><span>{kindLabels[created.kind]} · {created.responsible || created.team || 'Sem responsável'} · {created.operatorName}</span><span>{saveStatus === 'error' ? (saveError || 'Não repasse este acesso ainda. Tente salvar novamente.') : saveStatus === 'saved' ? 'Guarde os dados: a senha não poderá ser consultada depois.' : 'Aguarde a confirmação antes de repassar o código e a senha.'}</span></div>{saveStatus === 'saved' && <code>{created.code} / {created.password}</code>}{saveStatus === 'error' && <button className="text-button" onClick={onRetrySave}>Tentar novamente</button>}{saveStatus === 'saved' && <button className="text-button" onClick={() => setCreated(null)}>Fechar</button>}</div>}
        {showForm && (
          <form className="access-form" onSubmit={createAccess}>
            <div className="form-heading"><h3>Novo perfil</h3><p>Defina o tipo, o responsável e as credenciais que serão entregues à equipe.</p></div>
            <div className="form-grid">
              <label className="field-group"><span>Tipo de acesso</span><select value={kind} onChange={(event) => { setKind(event.target.value as NewProfileKind); setResponsible(''); }}><option value="neoenergia">Neoenergia</option><option value="vencer">Vencer</option></select></label>
              <label className="field-group"><span>Responsável da planilha</span><input list="access-responsible-options" value={responsible} onChange={(event) => setResponsible(event.target.value)} placeholder="Escolha ou digite como aparece na planilha" required /><datalist id="access-responsible-options">{responsibleChoices.map((option) => <option key={option} value={option} />)}</datalist></label>
              <label className="field-group"><span>Nome registrado nos protocolos</span><input value={operatorName} onChange={(event) => setOperatorName(event.target.value)} placeholder="Ex.: João Silva" autoComplete="name" required /></label>
              <label className="field-group"><span>Código de acesso escolhido pelo supervisor</span><input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="Ex.: NEO-1524" autoComplete="off" minLength={4} required /></label>
              <label className="field-group"><span>Senha escolhida pelo supervisor</span><input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder="Mínimo de 4 caracteres" autoComplete="new-password" minLength={4} required /></label>
              <label className="field-group"><span>Confirme a senha</span><input value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} type="password" placeholder="Digite a senha novamente" autoComplete="new-password" minLength={4} required /></label>
              <label className="field-group"><span>Identificação do perfil (opcional)</span><input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Ex.: Vegetação • Garanhuns" /></label>
            </div>
            {error && <div className="inline-error" role="alert">{error}</div>}
            <div className="form-actions"><button type="button" className="button button-ghost" onClick={() => setShowForm(false)}>Cancelar</button><button className="button button-primary" type="submit">Salvar e criar acesso</button></div>
          </form>
        )}
        <div className="table-scroll"><table className="admin-table access-table"><thead><tr><th>Perfil</th><th>Tipo</th><th>Responsável</th><th>Nome auditado</th><th>Código</th><th>Estado</th><th>Ação</th></tr></thead>
          <tbody>{profiles.map((profile) => <tr key={profile.id}><td><strong>{profile.label}</strong></td><td>{kindLabels[profile.kind]}</td><td>{profile.responsible || profile.team || '—'}</td><td>{profile.operatorName || profile.responsible || profile.label}</td><td><code>{profile.code}</code></td><td><span className={profile.active ? 'profile-active' : 'profile-inactive'}>{profile.active ? 'Ativo' : 'Desativado'}</span></td><td><button className="table-action" onClick={() => toggle(profile)}>{profile.active ? 'Desativar' : 'Ativar'}</button></td></tr>)}</tbody>
        </table></div>
        <p className="local-warning">Os perfis e as ordens são salvos no servidor. As senhas são protegidas e não podem ser consultadas depois de criadas.</p>
      </section>
    </main>
  );
}
