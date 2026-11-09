import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, KeyboardEvent } from 'react';
import { apiRequest, readSharedState } from './data/api';
import type { SharedAppState, SyncCursor } from './data/api';
import { exportControlWorkbook, headersFromSheet, mapSpreadsheetRow, readWorkbook, rowsFromSheet } from './lib/excel';
import type { ParsedWorkbook } from './lib/excel';
import { parseNumericQuantity } from './lib/quantity.js';
import type { AccessProfile, AdminPage, ExecutionNotification, ImportRecord, Order, OrderStatus, ProfileKind, SessionProfile } from './types';

const SYNC_POLL_INTERVAL_MS = 2 * 60 * 1000;

const kindLabels: Record<ProfileKind, string> = {
  inspetor: 'Neoenergia',
  vencer: 'Vencer',
  nper: 'Neoenergia',
  neoenergia: 'Neoenergia',
};

const pageLabels: Record<AdminPage, { title: string; subtitle: string }> = {
  painel: { title: 'Visão geral', subtitle: 'Ordens executadas, pendências e produtividade por responsável.' },
  controle: { title: 'Controle', subtitle: 'Gráficos de execução por situação, equipe, serviço e responsável.' },
  ordens: { title: 'Ordens', subtitle: 'Consulte e exporte as ordens das carteiras importadas.' },
  importacao: { title: 'Importar planilhas', subtitle: 'Carregue as carteiras do mês e distribua as ordens.' },
  protocolos: { title: 'Protocolos', subtitle: 'Consulte os registros de execução e impedimento.' },
  acessos: { title: 'Acessos', subtitle: 'Crie, edite e remova acessos das equipes.' },
};

function normalize(value: string | null | undefined): string {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function normalizeHeader(value: string): string {
  return normalize(value).replace(/[^a-z0-9]+/g, ' ').trim();
}

function canonicalCompany(value: string): string {
  const company = normalize(value);
  return company === 'nper' ? 'neoenergia' : company;
}

function companyLabel(value: string): string {
  const company = canonicalCompany(value);
  if (company === 'neoenergia') return 'Neoenergia';
  if (company === 'vencer') return 'Vencer';
  return value;
}

function canonicalProfileKind(value: string): 'neoenergia' | 'vencer' {
  return normalize(value) === 'vencer' ? 'vencer' : 'neoenergia';
}

function isCancelOrderValue(value: string): boolean {
  return /^cancelar\s+(?:a\s+)?ordem$/.test(normalize(value));
}

function isCancellationOrder(order: Pick<Order, 'empresa' | 'equipe' | 'responsavel' | 'servico' | 'original'>): boolean {
  return [order.empresa, order.equipe, order.responsavel, order.servico, ...Object.values(order.original || {})]
    .some(isCancelOrderValue);
}

function orderTeamGroupKey(order: Order): string {
  if (isCancellationOrder(order)) return '';
  const team = order.equipe.trim() || order.responsavel.trim();
  return team ? JSON.stringify([canonicalCompany(order.empresa), normalize(team)]) : '';
}

function activeTeamBreakdown(orders: Order[]) {
  const groups = new Map<string, { key: string; label: string; orders: Order[] }>();
  orders.forEach((order) => {
    const team = order.equipe.trim() || order.responsavel.trim();
    const key = orderTeamGroupKey(order);
    if (!key) return;
    const companyName = companyLabel(order.empresa);
    const label = companyName ? `${companyName} • ${team}` : team;
    const group = groups.get(key);
    if (group) group.orders.push(order);
    else groups.set(key, { key, label, orders: [order] });
  });
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
}

function activeResponsibleBreakdown(orders: Order[]) {
  const groups = new Map<string, { key: string; label: string; company: string; responsible: string; orders: Order[] }>();
  orders.forEach((order) => {
    const responsible = order.responsavel.trim();
    if (!responsible || isCancellationOrder(order)) return;
    const company = canonicalCompany(order.empresa);
    if (!['neoenergia', 'vencer'].includes(company)) return;
    const key = JSON.stringify([company, normalize(responsible)]);
    const group = groups.get(key);
    if (group) group.orders.push(order);
    else groups.set(key, { key, label: `${companyLabel(order.empresa)} • ${responsible}`, company, responsible, orders: [order] });
  });
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
}

function submitOnEnter(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}

function parseQuantity(value: string): number {
  return parseNumericQuantity(value) ?? 0;
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
        const submittedPasswords = new Map(profiles.filter((profile) => profile.password).map((profile) => [profile.id, profile.password]));
        if (submittedPasswords.size) {
          setProfiles((current) => {
            let changed = false;
            const next = current.map((profile) => {
              if (profile.password && submittedPasswords.get(profile.id) === profile.password) {
                changed = true;
                return { ...profile, password: '' };
              }
              return profile;
            });
            return changed ? next : current;
          });
        }
        if (dirtyRevision.current === revision) {
          adminDirty.current = false;
          dirtyAdminSections.current.clear();
          setAdminSaveError('');
          setAdminSaveStatus('saved');
        }
      }).catch((error: unknown) => {
        if (error instanceof Error && error.message === 'Sessão encerrada. Entre novamente.') {
          void logout();
          return;
        }
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
      } catch (error) {
        if (error instanceof Error && error.message === 'Sessão encerrada. Entre novamente.') {
          void logout();
          return;
        }
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
            <input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} onKeyDown={submitOnEnter} placeholder="Ex.: NEO-1524" autoComplete="username" required />
          </label>

          <label className="field-group">
            <span>Senha</span>
            <input value={password} onChange={(event) => setPassword(event.target.value)} onKeyDown={submitOnEnter} type="password" placeholder="Digite a senha do perfil" autoComplete="current-password" required />
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
          <label className="field-group"><span>Código do supervisor</span><input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} onKeyDown={submitOnEnter} autoComplete="username" /></label>
          <label className="field-group"><span>Senha</span><input value={password} onChange={(event) => setPassword(event.target.value)} onKeyDown={submitOnEnter} type="password" autoComplete="current-password" /></label>
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
      if (saveError instanceof Error && saveError.message === 'Sessão encerrada. Entre novamente.') onLogout();
      else setError(saveError instanceof Error ? saveError.message : 'Não foi possível registrar a execução.');
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
                  {order.protocolo && <span>Protocolo: {order.protocolo}</span>}
                  {order.registradoPor && <span>Registrado por: {order.registradoPor} · {formatDate(order.dataRegistro)}</span>}
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
                <div><Detail label="Barramento" value={order.barramento || '—'} /><Detail label="Empresa" value={companyLabel(order.empresa) || '—'} /><Detail label="Equipe" value={order.equipe} /><Detail label="Avanço" value={order.avanco || '—'} /><Detail label="Responsável" value={order.responsavel || '—'} /><SpreadsheetFields order={order} /></div>
              </details>
            </article>
          ))}
          {filteredOrders.length === 0 && (
            <div className="empty-state" role="status" aria-live="polite">
              {assignedOrders.length === 0 ? (
                <>
                  <strong>Sem atividades na carteira atual</strong>
                  <span>Seu perfil continua ativo, mas não há ordens vinculadas a {session.responsible || session.team || 'este acesso'} nesta carteira. Se você esperava encontrar ordens, peça à supervisão para conferir a carteira.</span>
                </>
              ) : query.trim() ? (
                <>
                  <strong>Nenhuma ordem encontrada</strong>
                  <span>Tente outro termo ou limpe a busca para ver as ordens deste acesso.</span>
                </>
              ) : tab === 'pendentes' ? (
                <>
                  <strong>Nenhuma ordem pendente</strong>
                  <span>Consulte a aba Registros para ver as ordens já atualizadas.</span>
                </>
              ) : (
                <>
                  <strong>Nenhum registro ainda</strong>
                  <span>As ordens disponíveis para execução estão na aba Pendentes.</span>
                </>
              )}
            </div>
          )}
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
      <SpreadsheetDetails order={order} />
    </section>
  );
}

const mappedSpreadsheetHeaders = new Set([
  'ALIMENTADOR', 'ALIM', 'BARRAMENTO', 'BARRA', 'QTD AJUSTADA', 'QUANT AJUSTADA',
  'QUANTIDADE AJUSTADA', 'QTD PREVISTA', 'QUANTIDADE', 'QUANT', 'QTD', 'KM PLANO', 'NUM CONSEQUENCIA',
  'NUMERO DA ORDEM', 'ORDEM', 'OS', 'EMPRESA', 'CONTRATADA', 'EQUIPE', 'TURMA', 'SERVICO',
  'DEFEITO', 'TIPO EMR', 'TIPO DE REDE', 'DESCRICAO DO SERVICO', 'DESCRICAO', 'AVANCO', 'PROGRESSO',
  'RESPONSAVEL', 'ENCARREGADO', 'ENDERECO', 'LOCAL',
].map(normalizeHeader));

function spreadsheetFields(order: Order): [string, string][] {
  return Object.entries(order.original || {}).filter(([header, value]) =>
    Boolean(header.trim() && value.trim()) && !mappedSpreadsheetHeaders.has(normalizeHeader(header)));
}

function SpreadsheetFields({ order, className = '' }: { order: Order; className?: string }) {
  const fields = spreadsheetFields(order);
  if (fields.length === 0) return null;
  return <div className={['spreadsheet-fields', className].filter(Boolean).join(' ')}>{fields.map(([label, value]) => <Detail key={label} label={label} value={value} />)}</div>;
}

function SpreadsheetDetails({ order }: { order: Order }) {
  const count = spreadsheetFields(order).length;
  if (count === 0) return null;
  return <details className="spreadsheet-details"><summary>Outros dados da planilha ({count})</summary><SpreadsheetFields order={order} /></details>;
}

function SpreadsheetToggleButton({ order, expanded, onToggle }: { order: Order; expanded: boolean; onToggle: () => void }) {
  const count = spreadsheetFields(order).length;
  if (count === 0) return null;
  return <button type="button" className="spreadsheet-toggle" aria-expanded={expanded} onClick={onToggle}>{expanded ? 'Ocultar dados da planilha' : 'Outros dados da planilha'} ({count})</button>;
}

function SpreadsheetExpandedRow({ order, colSpan, onClose }: { order: Order; colSpan: number; onClose: () => void }) {
  const panelRef = useRef<HTMLElement | null>(null);
  const [panelWidth, setPanelWidth] = useState(0);
  useEffect(() => {
    const panel = panelRef.current;
    const tableScroll = panel?.closest('.table-scroll');
    if (!(tableScroll instanceof HTMLElement)) return;
    const updateWidth = () => {
      const cellPadding = window.matchMedia('(max-width: 900px)').matches ? 0 : 26;
      setPanelWidth(Math.max(0, tableScroll.clientWidth - cellPadding));
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(tableScroll);
    return () => observer.disconnect();
  }, []);
  if (spreadsheetFields(order).length === 0) return null;
  return (
    <tr className="spreadsheet-expanded-row">
      <td colSpan={colSpan}>
        <section ref={panelRef} className="spreadsheet-expanded-panel" style={panelWidth ? { width: `${panelWidth}px`, maxWidth: `${panelWidth}px` } : undefined}>
          <div className="spreadsheet-expanded-heading"><strong>Outros dados da planilha</strong><button type="button" className="spreadsheet-expanded-close" onClick={onClose}>Fechar</button></div>
          <SpreadsheetFields order={order} className="admin-spreadsheet-fields" />
        </section>
      </td>
    </tr>
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
    const teamMatch = !teamFilter || orderTeamGroupKey(order) === teamFilter;
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
          <button className="sidebar-text-button logout-button" onClick={() => {
            if ((saveStatus === 'saving' || saveStatus === 'error') && !window.confirm('Há alterações ainda sem confirmação do servidor. Deseja sair mesmo assim?')) return;
            onLogout();
          }}>Sair da administração</button>
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

        {page === 'painel' && <Dashboard orders={orders} search={search} setSearch={setSearch} setTeamFilter={setTeamFilter} setStatusFilter={setStatusFilter} setServiceFilter={setServiceFilter} setPage={setPage} />}
        {page === 'controle' && <ControlPage orders={orders} />}
        {page === 'ordens' && (
          <OrdersPage
            orders={filteredOrders}
            allOrders={orders}
            query={search}
            setQuery={setSearch}
            teamFilter={teamFilter}
            setTeamFilter={setTeamFilter}
            statusFilter={statusFilter}
            setStatusFilter={setStatusFilter}
            serviceFilter={serviceFilter}
            setServiceFilter={setServiceFilter}
            onClearFilters={() => { setSearch(''); setTeamFilter(''); setStatusFilter(''); setServiceFilter(''); }}
            onExport={exportCurrent}
          />
        )}
        {page === 'importacao' && <ImportPage orders={orders} setOrders={setOrders} imports={imports} setImports={setImports} onExportPortfolio={exportPortfolioForReplacement} onClearPortfolio={onClearPortfolio} onImportSupplemental={onImportSupplemental} saveStatus={saveStatus} />}
        {page === 'protocolos' && <ProtocolsPage />}
        {page === 'acessos' && <AccessPage orders={orders} profiles={profiles} setProfiles={setProfiles} saveStatus={saveStatus} saveError={saveError} onRetrySave={onRetrySave} created={createdProfile} setCreated={setCreatedProfile} />}
      </div>
    </div>
  );
}

function Dashboard({
  orders,
  search,
  setSearch,
  setTeamFilter,
  setStatusFilter,
  setServiceFilter,
  setPage,
}: {
  orders: Order[];
  search: string;
  setSearch: (value: string) => void;
  setTeamFilter: (value: string) => void;
  setStatusFilter: (value: string) => void;
  setServiceFilter: (value: string) => void;
  setPage: (page: AdminPage) => void;
}) {
  const executed = orders.filter((order) => order.status === 'executada').length;
  const impediments = orders.filter(hasReportedImpediment).length;
  const teamGroups = activeTeamBreakdown(orders);
  const responsibleGroups = activeResponsibleBreakdown(orders);
  const responsibleStats = responsibleGroups.map(({ label, orders: assigned }) => {
    const complete = assigned.filter((order) => order.status === 'executada').length;
    return { label, complete, total: assigned.length, percent: assigned.length ? Math.round(complete / assigned.length * 100) : 0 };
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
        <StatCard title="Executadas" value={executed.toLocaleString('pt-BR')} detail="na carteira atual" tone="success" onClick={() => quickFilter('executada')} />
        <StatCard title="Impedimentos" value={impediments.toLocaleString('pt-BR')} detail="ordens que seguem pendentes" tone="warning" onClick={() => quickFilter('impedimento')} />
        <StatCard title="Responsáveis na carteira" value={responsibleStats.length.toLocaleString('pt-BR')} detail="separados por empresa" />
      </section>

      <section className="panel consolidated-panel">
        <div className="panel-heading"><h2>Efetivação dos serviços</h2><span className="demo-tag">Carteira ativa</span></div>
        <div className="filter-row">
          <form className="search-field admin-search" onSubmit={(event) => { event.preventDefault(); setPage('ordens'); }}><span aria-hidden="true">⌕</span><input value={search} placeholder="Buscar e pressione Enter" onChange={(event) => setSearch(event.target.value)} /></form>
          <select aria-label="Filtrar equipe" onChange={(event) => { setTeamFilter(event.target.value); setPage('ordens'); }}><option value="">Todas as equipes</option>{teamGroups.map((team) => <option key={team.key} value={team.key}>{team.label}</option>)}</select>
          <select aria-label="Filtrar serviço" onChange={(event) => { setServiceFilter(event.target.value); setPage('ordens'); }}><option value="">Todos os serviços</option>{[...new Set(orders.map((order) => order.servico).filter((service) => Boolean(service) && !isCancelOrderValue(service)))].map((service) => <option key={service}>{service}</option>)}</select>
          <select aria-label="Filtrar situação" onChange={(event) => { setStatusFilter(event.target.value); setPage('ordens'); }}><option value="">Todas as situações</option><option value="pendente">Pendente</option><option value="executada">Executada</option><option value="impedimento">Impedimento</option></select>
          <span className="period-chip compact-period">Carteira atual</span>
        </div>
        <OrderTable orders={orders.slice(0, 6)} />
        <p className="table-note">O consolidado usa a quantidade realizada informada pela equipe e mantém a prevista para comparação.</p>
      </section>

      <section className="panel progress-panel">
        <div className="panel-heading"><h2>Efetivação por responsável</h2><span className="muted small">Neoenergia e Vencer · ordens da carteira</span></div>
        {responsibleStats.length > 0
          ? <div className="progress-grid">{responsibleStats.map((stat) => <ProgressBar key={stat.label} {...stat} />)}</div>
          : <div className="empty-state"><strong>Nenhum responsável na carteira</strong><span>Importe uma planilha com a coluna RESPONSÁVEL preenchida.</span></div>}
      </section>
    </main>
  );
}

function ControlPage({ orders }: { orders: Order[] }) {
  const [showAllServices, setShowAllServices] = useState(false);
  const [showAllResponsibles, setShowAllResponsibles] = useState(false);
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
  const allResponsibleStats = [...responsibleGroups.values()].map(({ label, orders: groupOrders }) => {
    const complete = groupOrders.filter((order) => order.status === 'executada').length;
    return { label, complete, total: groupOrders.length, percent: groupOrders.length ? Math.round(complete / groupOrders.length * 100) : 0 };
  }).sort((a, b) => b.total - a.total);
  const responsibleStats = showAllResponsibles ? allResponsibleStats : allResponsibleStats.slice(0, 10);

  const serviceGroups = new Map<string, Order[]>();
  orders.forEach((order) => {
    const service = order.servico.trim() || 'Sem serviço';
    const unit = quantityUnit(order.qtdAjustada) || 'unidades';
    const key = `${service}\u0000${normalize(unit)}`;
    const group = serviceGroups.get(key) ?? [];
    group.push(order);
    serviceGroups.set(key, group);
  });
  const allQuantityStats = [...serviceGroups.entries()].map(([key, groupOrders]) => {
    const [service, unitKey] = key.split('\u0000');
    const unit = quantityUnit(groupOrders[0]?.qtdAjustada) || (unitKey === 'unidades' ? 'unidades' : unitKey);
    const planned = groupOrders.reduce((sum, order) => sum + parseQuantity(order.qtdAjustada), 0);
    const reported = groupOrders.reduce((sum, order) => sum + (order.qtdExecutada ?? 0), 0);
    const considered = groupOrders.reduce((sum, order) => sum + (order.status === 'executada' ? order.qtdExecutada ?? 0 : 0), 0);
    return { label: `${service} · ${unit}`, planned, reported, considered };
  }).sort((a, b) => b.considered - a.considered);
  const quantityStats = showAllServices ? allQuantityStats : allQuantityStats.slice(0, 8);
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
          <div className="panel-heading"><div><h2>Quantidades por serviço</h2><p className="muted">Previsto e informado, separado por unidade</p></div>{allQuantityStats.length > 8 && <button className="text-button" onClick={() => setShowAllServices((value) => !value)}>{showAllServices ? 'Mostrar principais' : `Ver todos (${allQuantityStats.length})`}</button>}</div>
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
          <div className="panel-heading"><div><h2>Execução por responsável</h2><p className="muted">Ordens concluídas vinculadas a cada responsável</p></div>{allResponsibleStats.length > 10 && <button className="text-button" onClick={() => setShowAllResponsibles((value) => !value)}>{showAllResponsibles ? 'Mostrar principais' : `Ver todos (${allResponsibleStats.length})`}</button>}</div>
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

function OrderTableRow({ order }: { order: Order }) {
  const [showSpreadsheetDetails, setShowSpreadsheetDetails] = useState(false);
  return (
    <>
      <tr>
        <td data-label="OS"><div className="order-os-cell"><span>OS {order.numConsequencia}</span><SpreadsheetToggleButton order={order} expanded={showSpreadsheetDetails} onToggle={() => setShowSpreadsheetDetails((open) => !open)} /></div></td>
        <td data-label="Equipe">{order.equipe}</td><td data-label="Serviço">{order.servico}</td><td data-label="Previsto">{order.qtdAjustada || '—'}</td>
        <td data-label="Executado">{order.qtdExecutada === undefined ? '—' : order.qtdExecutada + (quantityUnit(order.qtdAjustada) ? ' ' + quantityUnit(order.qtdAjustada) : '')}</td>
        <td data-label="Situação"><StatusBadge status={order.status} /></td><td data-label="Protocolo">{order.protocolo || '—'}</td>
        <td data-label="Problema relatado" className="issue-cell">{hasReportedImpediment(order) ? <><strong>{order.motivoImpedimento || 'Impedimento'}</strong>{order.observacao && <span>{order.observacao}</span>}</> : '—'}</td>
        <td data-label="Evidência">{hasReportedImpediment(order) && order.foto ? <PhotoEvidence photo={order.foto} orderNumber={order.numConsequencia} /> : '—'}</td>
      </tr>
      {showSpreadsheetDetails && <SpreadsheetExpandedRow order={order} colSpan={9} onClose={() => setShowSpreadsheetDetails(false)} />}
    </>
  );
}

function OrderTable({ orders }: { orders: Order[] }) {
  return (
    <>
      <div className="table-scroll">
        <table className="admin-table">
          <thead><tr><th>OS</th><th>Equipe</th><th>Serviço</th><th>Previsto</th><th>Executado</th><th>Situação</th><th>Protocolo</th><th>Problema relatado</th><th>Evidência</th></tr></thead>
          <tbody>
            {orders.map((order) => <OrderTableRow key={order.id} order={order} />)}
            {orders.length === 0 && <tr><td colSpan={9} className="table-empty">Nenhuma ordem para exibir.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="table-scroll-hint">Deslize horizontalmente para consultar todas as colunas.</p>
    </>
  );
}

function OrdersPage({
  orders,
  allOrders,
  query,
  setQuery,
  teamFilter,
  setTeamFilter,
  statusFilter,
  setStatusFilter,
  serviceFilter,
  setServiceFilter,
  onClearFilters,
  onExport,
}: {
  orders: Order[];
  allOrders: Order[];
  query: string;
  setQuery: (value: string) => void;
  teamFilter: string;
  setTeamFilter: (value: string) => void;
  statusFilter: string;
  setStatusFilter: (value: string) => void;
  serviceFilter: string;
  setServiceFilter: (value: string) => void;
  onClearFilters: () => void;
  onExport: () => void;
}) {
  const teams = activeTeamBreakdown(allOrders);
  const services = [...new Set(allOrders.map((order) => order.servico).filter((service) => Boolean(service) && !isCancelOrderValue(service)))];
  const hasFilters = Boolean(query || teamFilter || statusFilter || serviceFilter);
  return (
    <main className="admin-content">
      <section className="panel orders-panel">
        <div className="panel-heading"><div><h2>Ordens da carteira</h2><p className="muted">{orders.length.toLocaleString('pt-BR')} registros na seleção atual</p></div><div className="orders-heading-actions">{hasFilters && <button className="text-button" onClick={onClearFilters}>Limpar filtros</button>}<button className="button button-secondary" onClick={onExport}>Exportar seleção</button></div></div>
        <div className="filter-row orders-filter-row">
          <label className="search-field admin-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar OS, equipe, responsável ou protocolo" /></label>
          <select value={teamFilter} onChange={(event) => setTeamFilter(event.target.value)}><option value="">Todas as equipes</option>{teams.map((team) => <option key={team.key} value={team.key}>{team.label}</option>)}</select>
          <select value={serviceFilter} onChange={(event) => setServiceFilter(event.target.value)}><option value="">Todos os serviços</option>{services.map((service) => <option key={service}>{service}</option>)}</select>
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
  const cancellationRows = useMemo(() => orderRows.filter(isCancellationOrder), [orderRows]);
  const validRows = useMemo(() => orderRows.filter((row) =>
    !isCancellationOrder(row) && Boolean(row.empresa.trim() && row.responsavel.trim() && row.equipe.trim())), [orderRows]);
  const supplementalRows = useMemo(() => validRows.filter((row) => Boolean(row.servico.trim() && row.qtdAjustada.trim())), [validRows]);
  const rowsToPreview = importMode === 'complementar' ? supplementalRows : validRows;
  const excludedRows = orderRows.length - rowsToPreview.length;
  const excludedIncompleteRows = Math.max(0, excludedRows - cancellationRows.length);
  const mappedPreview = rowsToPreview.slice(0, 4);
  const columns = file && sheetName ? headersFromSheet(file.workbook, sheetName) : [];
  const duplicateHeaders = [...new Set(columns.filter(Boolean).filter((header, index) =>
    columns.findIndex((candidate) => normalizeHeader(candidate) === normalizeHeader(header)) !== index))];

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
      const headers = headersFromSheet(workbook.workbook, selectedSheet);
      const repeated = [...new Set(headers.filter(Boolean).filter((header, index) =>
        headers.findIndex((candidate) => normalizeHeader(candidate) === normalizeHeader(header)) !== index))];
      if (repeated.length) setError(`Cabeçalhos repetidos impedem identificar todos os campos: ${repeated.join(', ')}. Renomeie as colunas repetidas na planilha e selecione o arquivo novamente.`);
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
    if (duplicateHeaders.length) {
      setError(`Cabeçalhos repetidos impedem importar os dados com segurança: ${duplicateHeaders.join(', ')}. Renomeie as colunas e selecione o arquivo novamente.`);
      return;
    }
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
      const additions = orderRows.filter((mapped) => !isCancellationOrder(mapped)).map((mapped) => ({
        ...mapped,
        qtdExecutada: undefined,
        sourceColumns: columns,
        sourceSheet: sheetName,
        sourceFile: file.fileName,
        sourceKind: canonicalCompany(mapped.empresa) === 'vencer' ? 'vencer' as const : 'controle' as const,
      }));
      try {
        const result = await onImportSupplemental({ fileName: file.fileName, sheetName, sourceColumns: columns, orders: additions });
        setMessage(`${result.addedCount.toLocaleString('pt-BR')} nova(s) ordem(ns) acrescentada(s) à carteira.${result.duplicateCount ? ` ${result.duplicateCount} já existia(m) e não foi(ram) duplicada(s).` : ''}${result.excludedCount ? ` ${result.excludedCount} linha(s) incompleta(s) ou inválida(s) foram ignoradas.` : ''}${cancellationRows.length ? ` ${cancellationRows.length} linha(s) “CANCELAR ORDEM” foram desconsideradas.` : ''}`);
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
    setMessage(`${nextOrders.length.toLocaleString('pt-BR')} ordens importadas da carteira geral.${excludedIncompleteRows ? ` ${excludedIncompleteRows} linha(s) com EMPRESA, EQUIPE ou RESPONSÁVEL vazios foram ignoradas.` : ''}${cancellationRows.length ? ` ${cancellationRows.length} linha(s) “CANCELAR ORDEM” foram desconsideradas.` : ''}`);
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
              {duplicateHeaders.length > 0 && <div className="inline-error" role="alert">Cabeçalhos repetidos: {duplicateHeaders.join(', ')}. Renomeie cada coluna na planilha para que nenhum campo seja perdido.</div>}
              <div className="import-preview">
                <div className="import-preview-heading">
                  <strong>Conferência antes de importar</strong>
                  <small>Mostrando até {Math.min(4, rowsToPreview.length)} de {rowsToPreview.length.toLocaleString('pt-BR')} linhas aceitas. Esta conferência não grava nada.</small>
                </div>
                <div className="table-scroll"><table className="admin-table preview-table"><thead><tr><th>Ordem</th><th>Equipe</th><th>Serviço</th><th>Qtd. ajustada</th><th>Responsável</th></tr></thead>
                  <tbody>{mappedPreview.map((row, index) => <tr key={index}><td data-label="Ordem">{row.numConsequencia || '—'}</td><td data-label="Equipe">{row.equipe || '—'}</td><td data-label="Serviço">{row.servico || '—'}</td><td data-label="Qtd. ajustada">{row.qtdAjustada || '—'}</td><td data-label="Responsável">{row.responsavel || '—'}</td></tr>)}{mappedPreview.length === 0 && <tr><td colSpan={5} className="table-empty">Nenhuma linha atende aos campos obrigatórios.</td></tr>}</tbody>
                </table></div>
                {excludedRows > 0 && <p className="table-note">{excludedRows} linha(s) incompleta(s) serão ignoradas{importMode === 'complementar' ? ' por falta de número, empresa, equipe, responsável, serviço ou quantidade ajustada.' : ' por falta de número, empresa, equipe ou responsável.'}</p>}
              </div>
              <div className="import-actions"><span>{importMode === 'complementar' ? 'Novas linhas precisam ter número, empresa, equipe, responsável, serviço e quantidade.' : 'Linhas sem EMPRESA, EQUIPE ou RESPONSÁVEL não serão incluídas.'}</span><button className="button button-primary" disabled={importing || duplicateHeaders.length > 0 || (importMode === 'substituir' && orders.length > 0)} onClick={() => { void importRows(); }}>{importing ? 'Importando…' : importMode === 'complementar' ? 'Acrescentar à carteira atual' : orders.length > 0 ? 'Exclua a carteira atual primeiro' : 'Importar carteira do novo mês'}</button></div>
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

function ProtocolTableRow({ order }: { order: Order }) {
  const [showSpreadsheetDetails, setShowSpreadsheetDetails] = useState(false);
  return (
    <>
      <tr>
        <td data-label="Protocolo" className="protocol-cell">{order.protocolo}</td>
        <td data-label="Ordem"><div className="order-os-cell"><span>{order.numConsequencia}</span><SpreadsheetToggleButton order={order} expanded={showSpreadsheetDetails} onToggle={() => setShowSpreadsheetDetails((open) => !open)} /></div></td>
        <td data-label="Equipe">{order.equipe}</td><td data-label="Responsável">{order.responsavel || '—'}</td><td data-label="Registrado por">{order.registradoPor || '—'}</td>
        <td data-label="Resultado do registro"><StatusBadge status={reportedStatus(order)} /></td>
        <td data-label="Problema relatado" className="issue-cell">{hasReportedImpediment(order) ? <><strong>{order.motivoImpedimento || 'Impedimento'}</strong>{order.observacao && <span>{order.observacao}</span>}</> : '—'}</td>
        <td data-label="Evidência">{order.foto ? <PhotoEvidence photo={order.foto} orderNumber={order.numConsequencia} /> : '—'}</td><td data-label="Data">{formatDate(order.dataRegistro)}</td>
      </tr>
      {showSpreadsheetDetails && <SpreadsheetExpandedRow order={order} colSpan={9} onClose={() => setShowSpreadsheetDetails(false)} />}
    </>
  );
}

function ProtocolsPage() {
  const [records, setRecords] = useState<Order[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function loadRecords(nextCursor: string | null, append: boolean) {
    if (loading) return;
    setLoading(true);
    setError('');
    try {
      const query = nextCursor ? `?cursor=${encodeURIComponent(nextCursor)}` : '';
      const result = await apiRequest<{ records: Order[]; hasMore: boolean; nextCursor: string | null }>(`/api/admin/executions${query}`);
      setRecords((current) => append ? [...current, ...result.records] : result.records);
      setCursor(result.nextCursor);
      setHasMore(result.hasMore);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Não foi possível carregar os registros.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadRecords(null, false); }, []);

  return (
    <main className="admin-content">
      <section className="panel orders-panel">
        <div className="panel-heading"><div><h2>Histórico de auditoria</h2><p className="muted">{records.length.toLocaleString('pt-BR')} registros carregados, incluindo novas tentativas da mesma ordem.</p></div><div className="orders-heading-actions"><button className="button button-secondary" onClick={() => { void loadRecords(null, false); }} disabled={loading}>{loading ? 'Carregando…' : 'Atualizar'}</button></div></div>
        {error && <div className="inline-error" role="alert">{error}</div>}
        <div className="table-scroll"><table className="admin-table protocols-table"><thead><tr><th>Protocolo</th><th>Ordem</th><th>Equipe</th><th>Responsável</th><th>Registrado por</th><th>Resultado do registro</th><th>Problema relatado</th><th>Evidência</th><th>Data</th></tr></thead>
          <tbody>{records.map((order) => <ProtocolTableRow key={order.protocolo || order.id} order={order} />)}{records.length === 0 && !loading && !error && <tr><td colSpan={9} className="table-empty">Nenhum protocolo registrado.</td></tr>}</tbody>
        </table></div>
        <p className="table-scroll-hint">Deslize horizontalmente para consultar todas as colunas.</p>
        {hasMore && <div className="orders-load-more"><button className="button button-secondary" disabled={loading || !cursor} onClick={() => { void loadRecords(cursor, true); }}>{loading ? 'Carregando…' : 'Carregar mais registros'}</button></div>}
        <div className="protocol-footnote">Cada tentativa é exibida separadamente e mantém seu protocolo, responsável, operador, horário e evidência.</div>
      </section>
    </main>
  );
}

function PasswordEye({ visible }: { visible: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.7" />
      {!visible && <path d="M4 4 20 20" />}
    </svg>
  );
}

function AccessPage({ orders, profiles, setProfiles, saveStatus, saveError, onRetrySave, created, setCreated }: { orders: Order[]; profiles: AccessProfile[]; setProfiles: (profiles: AccessProfile[]) => void; saveStatus: AdminSaveStatus; saveError: string; onRetrySave: () => void; created: AccessProfile | null; setCreated: (profile: AccessProfile | null) => void }) {
  type NewProfileKind = 'neoenergia' | 'vencer';
  const [showForm, setShowForm] = useState(false);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [kind, setKind] = useState<NewProfileKind>('neoenergia');
  const [responsible, setResponsible] = useState('');
  const [operatorName, setOperatorName] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState('');
  const responsibleChoices = [...new Set([
    ...orders.filter((order) => canonicalCompany(order.empresa) === kind).map((order) => order.responsavel),
    ...profiles.filter((profile) => canonicalProfileKind(profile.kind) === kind).map((profile) => profile.responsible || ''),
  ].map((value) => String(value ?? '').trim()).filter((value) => value && !isCancelOrderValue(value)))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const responsibleHasCurrentOrders = orders.some((order) =>
    canonicalCompany(order.empresa) === kind && normalize(order.responsavel) === normalize(responsible),
  );

  function resetForm() {
    setShowForm(false);
    setEditingProfileId(null);
    setKind('neoenergia');
    setResponsible('');
    setOperatorName('');
    setCode('');
    setPassword('');
    setConfirmPassword('');
    setShowPassword(false);
    setShowConfirmPassword(false);
    setError('');
  }

  function startCreate() {
    resetForm();
    setCreated(null);
    setShowForm(true);
  }

  function startEdit(profile: AccessProfile) {
    setEditingProfileId(profile.id);
    setKind(canonicalProfileKind(profile.kind));
    setResponsible(profile.responsible || profile.team || '');
    setOperatorName(profile.operatorName || profile.responsible || profile.label);
    setCode(profile.code);
    setPassword('');
    setConfirmPassword('');
    setShowPassword(false);
    setShowConfirmPassword(false);
    setError('');
    setCreated(null);
    setShowForm(true);
  }

  function correctRejectedProfile() {
    if (!created) return;
    setEditingProfileId(created.id);
    setKind(canonicalProfileKind(created.kind));
    setResponsible(created.responsible || created.team || '');
    setOperatorName(created.operatorName || created.responsible || created.label);
    setCode(created.code);
    setPassword(created.password || '');
    setConfirmPassword(created.password || '');
    setShowPassword(false);
    setShowConfirmPassword(false);
    setError(saveError || 'Revise os dados deste acesso e salve novamente.');
    setCreated(null);
    setShowForm(true);
  }

  function saveAccess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const editingProfile = profiles.find((profile) => profile.id === editingProfileId);
    const cleanCode = code.trim().toUpperCase();
    const cleanPassword = password.trim();
    if (!responsible.trim()) {
      setError('Escolha ou informe o valor exato da coluna RESPONSÁVEL.');
      return;
    }
    if (responsible.trim().length > 180) {
      setError('O responsável pode ter até 180 caracteres.');
      return;
    }
    if (isCancelOrderValue(responsible)) {
      setError('Uma ordem de cancelamento não pode ser usada como responsável de acesso.');
      return;
    }
    if (!operatorName.trim()) {
      setError('Informe o nome que ficará registrado nos protocolos.');
      return;
    }
    if (operatorName.trim().length > 120) {
      setError('O nome registrado nos protocolos pode ter até 120 caracteres.');
      return;
    }
    if (editingProfileId && !editingProfile) {
      setError('Esse perfil não está mais disponível. Atualize a página e tente novamente.');
      return;
    }
    if (cleanCode.length < 4) {
      setError('O código de acesso precisa ter de 4 a 64 caracteres.');
      return;
    }
    if (cleanCode.length > 64) {
      setError('O código de acesso precisa ter de 4 a 64 caracteres.');
      return;
    }
    if (profiles.some((profile) => profile.id !== editingProfile?.id && normalize(profile.code) === normalize(cleanCode))) {
      setError('Esse código já está em uso. Escolha outro.');
      return;
    }
    if (!editingProfile && cleanPassword.length < 4) {
      setError('A senha precisa ter pelo menos 4 caracteres.');
      return;
    }
    if (editingProfile && !cleanPassword && confirmPassword.trim()) {
      setError('Digite a nova senha ou deixe os dois campos de senha vazios para mantê-la.');
      return;
    }
    if (cleanPassword && cleanPassword.length < 4) {
      setError('A senha precisa ter pelo menos 4 caracteres.');
      return;
    }
    if (cleanPassword.length > 128) {
      setError('A senha pode ter no máximo 128 caracteres.');
      return;
    }
    if (cleanPassword && cleanPassword !== confirmPassword.trim()) {
      setError('As senhas não coincidem.');
      return;
    }

    const profile: AccessProfile = {
      id: editingProfile?.id || 'profile-' + Date.now(),
      kind,
      label: `${kindLabels[kind]} • ${responsible.trim()} • ${operatorName.trim()}`.slice(0, 180),
      operatorName: operatorName.trim(),
      code: cleanCode,
      password: cleanPassword,
      team: '',
      responsible: responsible.trim(),
      active: editingProfile?.active ?? true,
    };
    setProfiles(editingProfile
      ? profiles.map((item) => item.id === editingProfile.id ? profile : item)
      : [...profiles, profile]);
    setCreated(profile);
    resetForm();
  }

  function toggle(profile: AccessProfile) {
    setCreated(null);
    setProfiles(profiles.map((item) => item.id === profile.id ? { ...item, active: !item.active } : item));
  }

  function remove(profile: AccessProfile) {
    const confirmed = window.confirm(`Excluir permanentemente o acesso "${profile.label}" (${profile.code})? As sessões serão encerradas e não será possível desfazer.`);
    if (!confirmed) return;
    setCreated(null);
    setProfiles(profiles.filter((item) => item.id !== profile.id));
    if (editingProfileId === profile.id) resetForm();
  }

  return (
    <main className="admin-content">
      <section className="panel access-panel">
        <div className="panel-heading"><div><h2>Perfis de acesso</h2><p className="muted">Cada acesso vê as ordens do responsável selecionado.</p></div><button className="button button-primary" onClick={startCreate}>+ Criar perfil</button></div>
        {saveStatus === 'error' && !created && !error && <div className="inline-error access-save-error" role="alert"><span>{saveError || 'O servidor não confirmou esta alteração.'}</span><button className="text-button" onClick={onRetrySave}>Tentar novamente</button></div>}
        {created && <div className="created-credentials" role={saveStatus === 'error' ? 'alert' : 'status'} aria-live={saveStatus === 'error' ? 'assertive' : 'polite'}><div><strong>{saveStatus === 'error' ? 'Não foi possível salvar o perfil' : saveStatus === 'saved' ? 'Alterações salvas' : 'Salvando alterações…'}</strong><span>{kindLabels[created.kind]} · {created.responsible || created.team || 'Sem responsável'} · {created.operatorName}</span><span>{saveStatus === 'error' ? (saveError || 'O servidor não confirmou. Tente novamente.') : created.password ? saveStatus === 'saved' ? 'Guarde o código e a nova senha; ela não poderá ser consultada depois.' : 'Aguarde a confirmação antes de usar as novas credenciais.' : saveStatus === 'saved' ? 'O perfil foi atualizado. A senha existente foi mantida.' : 'Aguarde a confirmação do servidor.'}</span></div>{saveStatus === 'saved' && created.password && <code>{created.code} / {created.password}</code>}{saveStatus === 'error' && <><button className="text-button" onClick={correctRejectedProfile}>Revisar perfil</button><button className="text-button" onClick={onRetrySave}>Tentar novamente</button></>}{saveStatus === 'saved' && <button className="text-button" onClick={() => setCreated(null)}>Fechar</button>}</div>}
        {showForm && (
          <form className="access-form" onSubmit={saveAccess}>
            <div className="form-heading"><h3>{editingProfileId ? 'Editar acesso' : 'Novo acesso'}</h3><p>Escolha o responsável e defina as credenciais.</p></div>
            <div className="form-grid">
              <label className="field-group"><span>Tipo de acesso</span><select value={kind} onChange={(event) => { setKind(event.target.value as NewProfileKind); setResponsible(''); }}><option value="neoenergia">Neoenergia</option><option value="vencer">Vencer</option></select></label>
              <label className="field-group"><span>Responsável</span><input list="access-responsible-options" value={responsible} onChange={(event) => setResponsible(event.target.value)} placeholder="Como aparece na planilha" maxLength={180} required /><datalist id="access-responsible-options">{responsibleChoices.map((option) => <option key={option} value={option} />)}</datalist></label>
              <label className="field-group"><span>Nome registrado nos protocolos</span><input value={operatorName} onChange={(event) => setOperatorName(event.target.value)} placeholder="Ex.: João Silva" autoComplete="name" maxLength={120} required /></label>
              <label className="field-group"><span>Código de acesso</span><input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="Ex.: NEO@01" autoComplete="off" minLength={4} maxLength={64} required /></label>
              <label className="field-group"><span>{editingProfileId ? 'Nova senha (opcional)' : 'Senha'}</span><div className="password-field"><input value={password} onChange={(event) => setPassword(event.target.value)} type={showPassword ? 'text' : 'password'} placeholder={editingProfileId ? 'Vazio mantém a senha atual' : 'Mínimo de 4 caracteres'} autoComplete="new-password" minLength={editingProfileId ? undefined : 4} maxLength={128} required={!editingProfileId} /><button type="button" className="password-visibility" aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'} aria-pressed={showPassword} onClick={() => setShowPassword((visible) => !visible)}><PasswordEye visible={showPassword} /></button></div></label>
              <label className="field-group"><span>{editingProfileId ? 'Confirme a nova senha' : 'Confirme a senha'}</span><div className="password-field"><input value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} type={showConfirmPassword ? 'text' : 'password'} placeholder="Digite a senha novamente" autoComplete="new-password" minLength={editingProfileId ? undefined : 4} maxLength={128} required={!editingProfileId} /><button type="button" className="password-visibility" aria-label={showConfirmPassword ? 'Ocultar confirmação da senha' : 'Mostrar confirmação da senha'} aria-pressed={showConfirmPassword} onClick={() => setShowConfirmPassword((visible) => !visible)}><PasswordEye visible={showConfirmPassword} /></button></div></label>
            </div>
            {responsible.trim() && !responsibleHasCurrentOrders && <div className="access-responsible-notice" role="status">Nenhuma ordem desta carteira está vinculada a “{responsible.trim()}”. O perfil será salvo, mas mostrará “Sem atividades na carteira atual” até uma carteira incluir esse responsável. Confira a grafia.</div>}
            {error && <div className="inline-error" role="alert">{error}</div>}
            <div className="form-actions"><button type="button" className="button button-ghost" onClick={resetForm}>Cancelar</button><button className="button button-primary" type="submit">{editingProfileId ? 'Salvar alterações' : 'Criar acesso'}</button></div>
          </form>
        )}
        <div className="table-scroll"><table className="admin-table access-table"><thead><tr><th>Perfil</th><th>Tipo</th><th>Responsável</th><th>Nome auditado</th><th>Código</th><th>Estado</th><th>Ação</th></tr></thead>
          <tbody>{profiles.map((profile) => <tr key={profile.id}><td data-label="Perfil"><strong>{profile.label}</strong></td><td data-label="Tipo">{kindLabels[profile.kind]}</td><td data-label="Responsável">{profile.responsible || profile.team || '—'}</td><td data-label="Nome auditado">{profile.operatorName || profile.responsible || profile.label}</td><td data-label="Código"><code>{profile.code}</code></td><td data-label="Estado"><span className={profile.active ? 'profile-active' : 'profile-inactive'}>{profile.active ? 'Ativo' : 'Desativado'}</span></td><td data-label="Ação"><div className="access-actions"><button className="table-action" onClick={() => startEdit(profile)}>Editar</button><button className="table-action" onClick={() => toggle(profile)}>{profile.active ? 'Desativar' : 'Ativar'}</button><button className="table-action table-action-danger" onClick={() => remove(profile)}>Excluir</button></div></td></tr>)}</tbody>
        </table></div>
        <p className="local-warning">Alterar um perfil ou excluí-lo encerra as sessões abertas desse acesso.</p>
      </section>
    </main>
  );
}
