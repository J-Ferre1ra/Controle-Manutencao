import { useEffect, useMemo, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { demoImports, demoOrders, demoProfiles, teamOptions } from './data/sample-data';
import { loadImports, loadOrders, loadProfiles, resetDemoData, saveImports, saveOrders, saveProfiles } from './data/storage';
import { exportControlWorkbook, mapSpreadsheetRow, readWorkbook, rowsFromSheet } from './lib/excel';
import type { ParsedWorkbook } from './lib/excel';
import type { AccessProfile, AdminPage, ImportRecord, Order, OrderStatus, ProfileKind, SessionProfile } from './types';

const kindLabels: Record<ProfileKind, string> = {
  inspecao: 'Inspeção',
  terceirizada: 'Terceirizada',
  propria: 'Própria Neoenergia',
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

function parseQuantity(value: string): number {
  const match = value.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
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

function makeProtocol(): string {
  const year = new Date().getFullYear();
  const code = Date.now().toString(36).toUpperCase();
  return 'NEO-' + year + '-' + code;
}

function statusText(status: OrderStatus): string {
  if (status === 'executada') return 'Executada';
  if (status === 'impedimento') return 'Impedimento';
  return 'Pendente';
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

export default function App() {
  const [orders, setOrders] = useState<Order[]>(loadOrders);
  const [profiles, setProfiles] = useState<AccessProfile[]>(loadProfiles);
  const [imports, setImports] = useState<ImportRecord[]>(loadImports);
  const [session, setSession] = useState<SessionProfile | null>(null);
  const [adminMode, setAdminMode] = useState(false);

  useEffect(() => saveOrders(orders), [orders]);
  useEffect(() => saveProfiles(profiles), [profiles]);
  useEffect(() => saveImports(imports), [imports]);

  if (adminMode) {
    return (
      <AdminApp
        orders={orders}
        setOrders={setOrders}
        profiles={profiles}
        setProfiles={setProfiles}
        imports={imports}
        setImports={setImports}
        onLogout={() => setAdminMode(false)}
        onReset={() => {
          resetDemoData();
          setOrders(demoOrders);
          setProfiles(demoProfiles);
          setImports(demoImports);
        }}
      />
    );
  }

  if (session) {
    return <FieldApp session={session} orders={orders} setOrders={setOrders} onLogout={() => setSession(null)} />;
  }

  return <LoginScreen profiles={profiles} onLogin={setSession} onOpenAdmin={() => setAdminMode(true)} />;
}

function LoginScreen({
  profiles,
  onLogin,
  onOpenAdmin,
}: {
  profiles: AccessProfile[];
  onLogin: (session: SessionProfile) => void;
  onOpenAdmin: () => void;
}) {
  const [kind, setKind] = useState<ProfileKind>('inspecao');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [operatorName, setOperatorName] = useState('');
  const [error, setError] = useState('');
  const matched = profiles.find((profile) => profile.kind === kind && normalize(profile.code) === normalize(code));

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const profile = profiles.find(
      (item) => item.kind === kind && item.active && normalize(item.code) === normalize(code) && item.password === password,
    );
    if (!profile) {
      setError('Código, senha ou perfil inválido. Confira os dados ou peça ajuda ao supervisor.');
      return;
    }
    if (!operatorName.trim()) {
      setError('Informe o nome de quem está registrando os serviços.');
      return;
    }
    onLogin({
      kind: profile.kind,
      label: profile.label,
      team: profile.team,
      responsible: profile.responsible,
      operatorName: operatorName.trim(),
    });
  }

  function fillDemo(profile: AccessProfile) {
    setKind(profile.kind);
    setCode(profile.code);
    setPassword(profile.password);
    setOperatorName(profile.responsible || 'Carlos Menezes');
    setError('');
  }

  return (
    <main className="login-page">
      <section className="login-card">
        <div className="login-brand-panel"><Brand /></div>
        <h1>Acesso da equipe</h1>
        <p className="login-intro">Selecione o tipo de equipe, informe o código e diga quem está registrando.</p>

        <form onSubmit={handleSubmit} className="login-form">
          <fieldset className="field-group">
            <legend>Tipo de equipe</legend>
            <div className="segmented-control segmented-three">
              {(['inspecao', 'terceirizada', 'propria'] as ProfileKind[]).map((option) => (
                <button
                  type="button"
                  key={option}
                  className={kind === option ? 'segment active' : 'segment'}
                  onClick={() => { setKind(option); setCode(''); setPassword(''); }}
                >
                  {option === 'inspecao' ? 'Inspetoria' : option === 'terceirizada' ? 'Terceirizada' : 'Própria'}
                </button>
              ))}
            </div>
          </fieldset>

          <label className="field-group">
            <span>Código de acesso</span>
            <input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="Ex.: INSP-04" autoComplete="username" />
          </label>

          <label className="field-group">
            <span>Senha</span>
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder="Digite a senha do perfil" autoComplete="current-password" />
          </label>

          {kind === 'terceirizada' && matched?.responsible && (
            <div className="responsible-confirmation"><span>Responsável vinculado</span><strong>{matched.responsible}</strong></div>
          )}

          <label className="field-group">
            <span>Nome de quem está registrando</span>
            <input value={operatorName} onChange={(event) => setOperatorName(event.target.value)} placeholder="Ex.: João Silva" autoComplete="name" />
          </label>

          {error && <div className="inline-error" role="alert">{error}</div>}
          <button className="button button-primary button-full" type="submit">Entrar nas ordens</button>
        </form>

        <p className="login-note">As ordens aparecem conforme o perfil autorizado pelo supervisor.</p>
        <button className="button button-outline button-full" onClick={onOpenAdmin}>Ver área administrativa • supervisor</button>

        <details className="demo-access">
          <summary>Acessos da demonstração</summary>
          <div className="demo-access-list">
            {profiles.filter((profile) => profile.active).map((profile) => (
              <button type="button" key={profile.id} onClick={() => fillDemo(profile)}>
                <span>{profile.label}</span><code>{profile.code} / {profile.password}</code>
              </button>
            ))}
            <small>Dados demonstrativos, salvos apenas neste navegador.</small>
          </div>
        </details>
      </section>
      <div className="prototype-warning">Protótipo demonstrativo • não use informações operacionais reais</div>
    </main>
  );
}

function FieldApp({
  session,
  orders,
  setOrders,
  onLogout,
}: {
  session: SessionProfile;
  orders: Order[];
  setOrders: (orders: Order[]) => void;
  onLogout: () => void;
}) {
  const [page, setPage] = useState<'lista' | 'registro' | 'protocolo'>('lista');
  const [tab, setTab] = useState<'pendentes' | 'executadas'>('pendentes');
  const [query, setQuery] = useState('');
  const [orderId, setOrderId] = useState<string | null>(null);
  const [lastSaved, setLastSaved] = useState<Order | null>(null);
  const [quantity, setQuantity] = useState(0);
  const [executionMode, setExecutionMode] = useState<'executada' | 'impedimento'>('executada');
  const [observation, setObservation] = useState('');
  const [reason, setReason] = useState('');
  const [photo, setPhoto] = useState('');
  const [error, setError] = useState('');

  const assignedOrders = useMemo(() => orders.filter((order) => {
    const matchesTeam = normalize(order.equipe) === normalize(session.team);
    const matchesResponsible = !session.responsible || normalize(order.responsavel) === normalize(session.responsible);
    return matchesTeam && matchesResponsible;
  }), [orders, session]);

  const filteredOrders = useMemo(() => assignedOrders.filter((order) => {
    const isDone = order.status !== 'pendente';
    const matchesTab = tab === 'pendentes' ? !isDone : isDone;
    const search = normalize(query);
    const matchesSearch = !search || [order.numConsequencia, order.alimentador, order.barramento, order.servico, order.responsavel]
      .some((value) => normalize(value || '').includes(search));
    return matchesTab && matchesSearch;
  }), [assignedOrders, query, tab]);

  const selectedOrder = orders.find((order) => order.id === orderId) ?? null;

  function openOrder(order: Order) {
    setOrderId(order.id);
    setQuantity(order.qtdExecutada ?? parseQuantity(order.qtdAjustada));
    setExecutionMode('executada');
    setObservation('');
    setReason('');
    setPhoto('');
    setError('');
    setPage('registro');
  }

  function handlePhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 1200 * 1024) {
      setError('A imagem deve ter até 1,2 MB nesta demonstração.');
      event.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setPhoto(String(reader.result || ''));
    reader.readAsDataURL(file);
  }

  function saveExecution() {
    if (!selectedOrder) return;
    if (executionMode === 'impedimento' && (!reason || !observation.trim())) {
      setError('Informe o motivo e explique o impedimento antes de salvar.');
      return;
    }
    if (executionMode === 'executada' && quantity < 0) {
      setError('A quantidade realizada não pode ser negativa.');
      return;
    }
    const updated: Order = {
      ...selectedOrder,
      status: executionMode,
      qtdExecutada: executionMode === 'executada' && session.kind !== 'inspecao' ? quantity : undefined,
      observacao: observation.trim(),
      motivoImpedimento: executionMode === 'impedimento' ? reason : undefined,
      foto: executionMode === 'impedimento' ? photo : undefined,
      protocolo: makeProtocol(),
      registradoPor: session.operatorName,
      dataRegistro: new Date().toISOString(),
    };
    setOrders(orders.map((order) => order.id === updated.id ? updated : order));
    setLastSaved(updated);
    setPage('protocolo');
    setError('');
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
            <Detail label="Quantidade" value={lastSaved.qtdExecutada === undefined ? 'Não informada' : lastSaved.qtdExecutada + ' realizada(s)'} />
            <Detail label="Situação" value={statusText(lastSaved.status)} />
            <Detail label="Data" value={formatDate(lastSaved.dataRegistro)} />
          </section>
          <button className="button button-primary button-full" onClick={() => { setPage('lista'); setTab('executadas'); }}>Voltar às ordens</button>
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
          <div className="field-header"><Brand /><span className="team-chip">{session.team}</span></div>
          <button className="back-link" onClick={() => setPage('lista')}>← Voltar às ordens</button>
          <h1>{executionMode === 'impedimento' ? 'Registrar impedimento' : 'Registrar execução'}</h1>
          <OrderSummary order={selectedOrder} />

          <div className="segmented-control segmented-two status-choice" role="group" aria-label="Situação do serviço">
            <button type="button" className={executionMode === 'executada' ? 'segment active' : 'segment'} onClick={() => { setExecutionMode('executada'); setError(''); }}>Executado</button>
            <button type="button" className={executionMode === 'impedimento' ? 'segment active' : 'segment'} onClick={() => { setExecutionMode('impedimento'); setError(''); }}>Impedimento</button>
          </div>

          {executionMode === 'executada' ? (
            <>
              {session.kind !== 'inspecao' && <>
                <label className="section-label quantity-label">Quantidade realizada</label>
                <div className="quantity-stepper">
                  <button type="button" className="step-button" aria-label="Diminuir quantidade" onClick={() => setQuantity((value) => Math.max(0, Math.round((value - 1) * 100) / 100))}>−</button>
                  <div className="quantity-value"><strong>{quantity}</strong><span>{unit || 'unidades'}</span></div>
                  <button type="button" className="step-button step-plus" aria-label="Aumentar quantidade" onClick={() => setQuantity((value) => Math.round((value + 1) * 100) / 100)}>+</button>
                </div>
                <p className="quantity-rule">Previsto: {selectedOrder.qtdAjustada || '—'} · O consolidado usará a quantidade realizada informada.</p>
              </>}
              <label className="field-group textarea-group">
                <span>Observação (opcional)</span>
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
                <span><strong>{photo ? 'Foto adicionada' : 'Adicionar foto de constatação'}</strong><small>Use somente como evidência do impedimento.</small></span>
                <input type="file" accept="image/*" capture="environment" onChange={handlePhoto} />
              </label>
              {photo && <img className="photo-preview" src={photo} alt="Prévia da foto de constatação" />}
            </>
          )}

          {error && <div className="inline-error" role="alert">{error}</div>}
          <button className="button button-primary button-full" onClick={saveExecution}>
            {executionMode === 'impedimento' ? 'Registrar impedimento' : 'Salvar e gerar protocolo'}
          </button>
          <p className="small-note">O registro inclui responsável, equipe, data e horário.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="field-page">
      <div className="field-shell field-list-shell">
        <div className="field-header"><Brand /><span className="team-chip">{session.team}</span></div>
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
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar ordem, alimentador ou barramento" />
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
              {tab === 'pendentes' ? (
                <button className="button button-primary button-full" onClick={() => openOrder(order)}>Registrar execução</button>
              ) : (
                <div className="completed-summary">
                  <span>{order.qtdExecutada === undefined ? order.motivoImpedimento || 'Impedimento registrado' : 'Executado: ' + order.qtdExecutada + (quantityUnit(order.qtdAjustada) ? ' ' + quantityUnit(order.qtdAjustada) : '')}</span>
                  <small>Protocolo: {order.protocolo || '—'}</small>
                </div>
              )}
              <details className="order-extra-details">
                <summary>Ver detalhes</summary>
                <div><Detail label="Barramento" value={order.barramento || '—'} /><Detail label="Empresa" value={order.empresa || '—'} /><Detail label="Equipe" value={order.equipe} /><Detail label="Avanço" value={order.avanco || '—'} /><Detail label="Responsável" value={order.responsavel || '—'} /></div>
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
  profiles,
  setProfiles,
  imports,
  setImports,
  onLogout,
  onReset,
}: {
  orders: Order[];
  setOrders: (orders: Order[]) => void;
  profiles: AccessProfile[];
  setProfiles: (profiles: AccessProfile[]) => void;
  imports: ImportRecord[];
  setImports: (imports: ImportRecord[]) => void;
  onLogout: () => void;
  onReset: () => void;
}) {
  const [page, setPage] = useState<AdminPage>('painel');
  const [search, setSearch] = useState('');
  const [teamFilter, setTeamFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [serviceFilter, setServiceFilter] = useState('');
  const filteredOrders = useMemo(() => orders.filter((order) => {
    const searchValue = normalize(search);
    const textMatch = !searchValue || [order.numConsequencia, order.equipe, order.servico, order.protocolo, order.responsavel]
      .some((value) => normalize(value || '').includes(searchValue));
    const teamMatch = !teamFilter || order.equipe === teamFilter;
    const statusMatch = !statusFilter || order.status === statusFilter;
    const serviceMatch = !serviceFilter || order.servico === serviceFilter;
    return textMatch && teamMatch && statusMatch && serviceMatch;
  }), [orders, search, teamFilter, statusFilter, serviceFilter]);

  function exportCurrent() {
    void exportControlWorkbook(filteredOrders, 'controle-execucao-neoenergia.xlsx');
  }
  const availableTeams = [...new Set([...teamOptions, ...orders.map((order) => order.equipe), ...profiles.map((profile) => profile.team)].filter(Boolean))];

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
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
            <button key={id} className={page === id ? 'admin-nav-item active' : 'admin-nav-item'} onClick={() => setPage(id)}>
              <span className="nav-icon" aria-hidden="true">{icon}</span>{label}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="admin-label"><span className="online-dot" />Supervisor</span>
          <button className="sidebar-text-button" onClick={onReset}>Restaurar dados da demonstração</button>
          <button className="sidebar-text-button" onClick={onLogout}>Voltar ao acesso</button>
        </div>
      </aside>

      <div className="admin-main">
        <header className="admin-topbar">
          <div>
            <span className="eyebrow">Controle de execução</span>
            <h1>{pageLabels[page].title}</h1>
            <p>{pageLabels[page].subtitle}</p>
          </div>
          <div className="topbar-actions">
            <span className="period-chip">Base demonstrativa</span>
            <button className="button button-primary export-button" onClick={exportCurrent}>Exportar Excel</button>
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
        {page === 'importacao' && <ImportPage orders={orders} setOrders={setOrders} imports={imports} setImports={setImports} teamChoices={availableTeams} />}
        {page === 'protocolos' && <ProtocolsPage orders={orders} />}
        {page === 'acessos' && <AccessPage profiles={profiles} setProfiles={setProfiles} teamChoices={availableTeams} />}
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
  const impediments = orders.filter((order) => order.status === 'impedimento').length;
  const teams = [...new Set(orders.map((order) => order.equipe).filter(Boolean))];
  const teamStats = teams.map((team) => {
    const assigned = orders.filter((order) => order.equipe === team);
    const complete = assigned.filter((order) => order.status === 'executada').length;
    return { label: team, complete, total: assigned.length, percent: assigned.length ? Math.round(complete / assigned.length * 100) : 0 };
  });
  const contractorGroups = [...new Set(orders
    .filter((order) => order.responsavel && (normalize(order.empresa).includes('vencer') || normalize(order.empresa).includes('nper')))
    .map((order) => order.empresa + ' • ' + order.responsavel))];
  const contractorStats = contractorGroups.map((group) => {
      const [company, name] = group.split(' • ');
      const assigned = orders.filter((order) => order.empresa === company && order.responsavel === name);
      const complete = assigned.filter((order) => order.status === 'executada').length;
      return { label: company + ' • ' + name, complete, total: assigned.length, percent: assigned.length ? Math.round(complete / assigned.length * 100) : 0 };
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
        <StatCard title="Ordens importadas" value={orders.length.toLocaleString('pt-BR')} detail="base demonstrativa" />
        <StatCard title="Executadas" value={executed.toLocaleString('pt-BR')} detail="no período selecionado" tone="success" onClick={() => quickFilter('executada')} />
        <StatCard title="Impedimentos" value={impediments.toLocaleString('pt-BR')} detail="para análise interna" tone="warning" onClick={() => quickFilter('impedimento')} />
        <StatCard title="Equipes ativas" value={teams.length.toLocaleString('pt-BR')} detail="com ordens liberadas" />
      </section>

      <section className="panel consolidated-panel">
        <div className="panel-heading"><h2>Efetivação dos serviços</h2><span className="demo-tag">Dados demonstrativos</span></div>
        <div className="filter-row">
          <label className="search-field admin-search"><span>⌕</span><input placeholder="Buscar OS, equipe ou protocolo" onChange={(event) => { setSearch(event.target.value); setPage('ordens'); }} /></label>
          <select aria-label="Filtrar equipe" onChange={(event) => { setTeamFilter(event.target.value); setPage('ordens'); }}><option value="">Todas as equipes</option>{teams.map((team) => <option key={team}>{team}</option>)}</select>
          <select aria-label="Filtrar serviço" onChange={(event) => { setServiceFilter(event.target.value); setPage('ordens'); }}><option value="">Todos os serviços</option>{[...new Set(orders.map((order) => order.servico).filter(Boolean))].map((service) => <option key={service}>{service}</option>)}</select>
          <select aria-label="Filtrar situação" onChange={(event) => { setStatusFilter(event.target.value); setPage('ordens'); }}><option value="">Todas as situações</option><option value="pendente">Pendente</option><option value="executada">Executada</option><option value="impedimento">Impedimento</option></select>
          <span className="period-chip compact-period">Base demonstrativa</span>
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
            <div className="panel-heading compact-heading"><h3>Efetivação por responsável • terceirizadas</h3></div>
            <div className="progress-grid">{contractorStats.map((stat) => <ProgressBar key={stat.label} {...stat} />)}</div>
          </div>
        )}
      </section>
    </main>
  );
}

function ControlPage({ orders }: { orders: Order[] }) {
  const executed = orders.filter((order) => order.status === 'executada').length;
  const impediments = orders.filter((order) => order.status === 'impedimento').length;
  const pending = orders.filter((order) => order.status === 'pendente').length;
  const total = orders.length;
  const executedPercent = total ? executed / total * 100 : 0;
  const impedimentEnd = total ? (executed + impediments) / total * 100 : 0;
  const donutBackground = total
    ? `conic-gradient(#00a859 0 ${executedPercent}%, #e6a13b ${executedPercent}% ${impedimentEnd}%, #dce6e9 ${impedimentEnd}% 100%)`
    : '#dce6e9';

  const teams = [...new Set(orders.map((order) => order.equipe.trim() || 'Sem equipe'))];
  const teamStats = teams.map((team) => {
    const assigned = orders.filter((order) => (order.equipe.trim() || 'Sem equipe') === team);
    const complete = assigned.filter((order) => order.status === 'executada').length;
    return { label: team, complete, total: assigned.length, percent: assigned.length ? Math.round(complete / assigned.length * 100) : 0 };
  }).sort((a, b) => b.total - a.total);

  const responsibleGroups = new Map<string, { label: string; orders: Order[] }>();
  orders.forEach((order) => {
    const responsible = order.responsavel.trim();
    if (!responsible) return;
    const company = order.empresa.trim();
    const key = company + '\u0000' + responsible;
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
    const considered = groupOrders.reduce((sum, order) => sum + Math.max(parseQuantity(order.qtdAjustada), order.qtdExecutada ?? 0), 0);
    return { label, planned, reported, considered };
  }).sort((a, b) => b.considered - a.considered).slice(0, 8);
  const maxQuantity = Math.max(1, ...quantityStats.map((item) => Math.max(item.planned, item.reported)));
  const quantityText = (value: number) => value.toLocaleString('pt-BR', { maximumFractionDigits: 2 });

  return (
    <main className="admin-content control-page">
      <section className="control-metrics">
        <div className="control-metric"><span>Ordens na carteira</span><strong>{total.toLocaleString('pt-BR')}</strong><small>base atual</small></div>
        <div className="control-metric"><span>Executadas</span><strong className="metric-success">{executed.toLocaleString('pt-BR')}</strong><small>{Math.round(executedPercent)}% da carteira</small></div>
        <div className="control-metric"><span>Impedimentos</span><strong className="metric-warning">{impediments.toLocaleString('pt-BR')}</strong><small>precisam de análise</small></div>
        <div className="control-metric"><span>Pendentes</span><strong>{pending.toLocaleString('pt-BR')}</strong><small>aguardando execução</small></div>
      </section>

      <section className="control-chart-grid">
        <div className="panel">
          <div className="panel-heading"><div><h2>Situação das ordens</h2><p className="muted">Distribuição da carteira atual</p></div></div>
          <div className="status-chart-layout">
            <div className="status-donut" role="img" aria-label={`${executed} executadas, ${impediments} com impedimento e ${pending} pendentes`} style={{ background: donutBackground }}>
              <div className="status-donut-center"><strong>{total ? Math.round(executedPercent) + '%' : '—'}</strong><span>executadas</span></div>
            </div>
            <div className="status-legend">
              <div className="status-legend-item"><span><i className="status-dot dot-executed" />Executadas</span><strong>{executed}</strong></div>
              <div className="status-legend-item"><span><i className="status-dot dot-impediment" />Impedimentos</span><strong>{impediments}</strong></div>
              <div className="status-legend-item"><span><i className="status-dot dot-pending" />Pendentes</span><strong>{pending}</strong></div>
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
          <p className="table-note">A quantidade considerada em cada ordem segue o maior valor entre o ajustado na planilha e o informado pela equipe.</p>
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
        <thead><tr><th>OS</th><th>Equipe</th><th>Serviço</th><th>Previsto</th><th>Executado</th><th>Situação</th><th>Protocolo</th></tr></thead>
        <tbody>
          {orders.map((order) => (
            <tr key={order.id}>
              <td>OS {order.numConsequencia}</td><td>{order.equipe}</td><td>{order.servico}</td><td>{order.qtdAjustada || '—'}</td>
              <td>{order.qtdExecutada === undefined ? '—' : order.qtdExecutada + (quantityUnit(order.qtdAjustada) ? ' ' + quantityUnit(order.qtdAjustada) : '')}</td>
              <td><StatusBadge status={order.status} /></td><td>{order.protocolo || '—'}</td>
            </tr>
          ))}
          {orders.length === 0 && <tr><td colSpan={7} className="table-empty">Nenhuma ordem para exibir.</td></tr>}
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
  const teams = [...new Set(orders.map((order) => order.equipe).filter(Boolean))];
  return (
    <main className="admin-content">
      <section className="panel orders-panel">
        <div className="panel-heading"><div><h2>Ordens da carteira</h2><p className="muted">{orders.length} registros na seleção atual</p></div><button className="button button-secondary" onClick={onExport}>Exportar seleção</button></div>
        <div className="filter-row orders-filter-row">
          <label className="search-field admin-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar OS, equipe, responsável ou protocolo" /></label>
          <select value={teamFilter} onChange={(event) => setTeamFilter(event.target.value)}><option value="">Todas as equipes</option>{teams.map((team) => <option key={team}>{team}</option>)}</select>
          <select value={serviceFilter} onChange={(event) => setServiceFilter(event.target.value)}><option value="">Todos os serviços</option>{[...new Set(orders.map((order) => order.servico).filter(Boolean))].map((service) => <option key={service}>{service}</option>)}</select>
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
  teamChoices,
}: {
  orders: Order[];
  setOrders: (orders: Order[]) => void;
  imports: ImportRecord[];
  setImports: (imports: ImportRecord[]) => void;
  teamChoices: string[];
}) {
  const [source, setSource] = useState<'controle' | 'inspecao' | 'nper' | 'vencer'>('controle');
  const [team, setTeam] = useState('');
  const [file, setFile] = useState<ParsedWorkbook | null>(null);
  const [sheetName, setSheetName] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const rows = useMemo(() => file && sheetName ? rowsFromSheet(file.workbook, sheetName) : [], [file, sheetName]);
  const mappedPreview = useMemo(() => rows.slice(0, 4).map((row) => {
    const mapped = mapSpreadsheetRow(row, team);
    return { ...mapped, equipe: source === 'controle' ? (mapped.equipe || team) : team };
  }), [rows, team, source]);
  const columns = rows[0] ? Object.keys(rows[0].values) : [];

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const selectedFile = event.target.files?.[0];
    if (!selectedFile) return;
    setError('');
    setMessage('');
    try {
      const workbook = await readWorkbook(selectedFile);
      setFile(workbook);
      setSheetName(workbook.sheetNames[0] || '');
    } catch {
      setError('Não consegui ler essa planilha. Selecione um arquivo .xlsx válido.');
      setFile(null);
    }
  }

  function importRows() {
    if (!file || rows.length === 0) {
      setError('Selecione um arquivo e uma aba com ordens.');
      return;
    }
    const isMaster = source === 'controle' || normalize(sheetName) === 'acompanhamento';
    const isInspection = source === 'inspecao';
    const mappedRows = rows.map((row) => mapSpreadsheetRow(row, team)).filter((row) => row.numConsequencia);
    if (mappedRows.length === 0) {
      setError('Não encontrei uma coluna de identificação da ordem. Confira se a aba tem NUM_CONSEQUENCIA, ORDEM ou OS.');
      return;
    }
    if (!team.trim() && (!isMaster || mappedRows.some((row) => !row.equipe.trim()))) {
      setError(isMaster ? 'Informe uma equipe padrão para as linhas sem equipe.' : 'Informe a equipe que receberá esta carteira.');
      return;
    }
    const nextOrders = source === 'controle'
      ? orders.filter((order) => !order.id.startsWith('order-'))
      : [...orders];
    mappedRows.forEach((mapped, index) => {
      const existingIndex = nextOrders.findIndex((order) =>
        order.numConsequencia === mapped.numConsequencia &&
        (isInspection ? order.sourceKind === 'inspecao' : order.sourceKind !== 'inspecao'),
      );
      if (existingIndex >= 0) {
        const existing = nextOrders[existingIndex];
        const merged: Order = {
          ...existing,
          alimentador: mapped.alimentador || existing.alimentador,
          barramento: mapped.barramento || existing.barramento,
          qtdAjustada: mapped.qtdAjustada || existing.qtdAjustada,
          numConsequencia: mapped.numConsequencia,
          empresa: mapped.empresa || existing.empresa,
          equipe: isMaster ? (mapped.equipe || existing.equipe) : team,
          servico: mapped.servico || existing.servico,
          avanco: mapped.avanco || existing.avanco,
          responsavel: mapped.responsavel || existing.responsavel,
          endereco: mapped.endereco || existing.endereco,
          original: { ...(existing.original || {}), ...(mapped.original || {}) },
          sourceColumns: isMaster ? columns : existing.sourceColumns?.length ? existing.sourceColumns : columns,
          sourceSheet: isMaster ? sheetName : existing.sourceSheet || sheetName,
          sourceFile: isMaster ? file.fileName : existing.sourceFile || file.fileName,
          sourceKind: isMaster ? 'controle' : isInspection ? 'inspecao' : existing.sourceKind || source,
        };
        nextOrders[existingIndex] = merged;
      } else {
        nextOrders.push({
          ...mapped,
          id: 'import-' + Date.now() + '-' + index,
          equipe: isMaster ? (mapped.equipe || team) : team,
          status: 'pendente',
          sourceColumns: columns,
          sourceSheet: sheetName,
          sourceFile: file.fileName,
          sourceKind: isMaster ? 'controle' : source,
        });
      }
    });
    setOrders(nextOrders);
    const sourceLabel = source === 'controle' ? 'CONTROLE • Geral' : source === 'inspecao' ? 'INSPEÇÃO' : source === 'nper' ? 'NPER' : 'VENCER';
    const record: ImportRecord = {
      id: 'import-' + Date.now(),
      fileName: file.fileName,
      source: sourceLabel,
      team: isMaster ? 'Carteira geral' : team,
      importedAt: new Date().toISOString(),
      orderCount: mappedRows.length,
      sheetName,
    };
    setImports([record, ...imports.filter((item) => !item.id.startsWith('import-demo'))]);
    setMessage(mappedRows.length + ' ordens lidas. Nenhuma planilha enviada anteriormente foi carregada automaticamente.');
    setError('');
  }

  return (
    <main className="admin-content">
      <div className="import-layout">
        <section className="panel import-form-panel">
          <div className="panel-heading"><h2>1. Selecione a fonte e a equipe</h2><span className="step-chip">Somente supervisor</span></div>
          <label className="field-group admin-field"><span>Planilha de origem</span>
            <select value={source} onChange={(event) => setSource(event.target.value as typeof source)}>
              <option value="controle">CONTROLE • carteira geral</option><option value="inspecao">INSPEÇÃO</option><option value="nper">NPER</option><option value="vencer">VENCER</option>
            </select>
          </label>
          <label className="field-group admin-field"><span>{source === 'controle' ? 'Equipe para linhas sem equipe' : 'Equipe que receberá esta carteira'}</span>
            <input list="import-team-choices" value={team} onChange={(event) => setTeam(event.target.value)} placeholder="Digite ou selecione uma equipe" />
            <datalist id="import-team-choices">{teamChoices.map((option) => <option key={option} value={option} />)}</datalist>
          </label>
          <label className="upload-dropzone">
            <span className="file-icon">XLSX</span>
            <span><strong>Arraste a planilha ou escolha um arquivo</strong><small>Arquivo Excel .xlsx • os dados só entram após validação</small></span>
            <span className="button button-secondary file-button">Selecionar arquivo</span>
            <input type="file" accept=".xlsx,.xls" onChange={onFile} />
          </label>
          {file && (
            <>
              <div className="file-selected"><div><strong>{file.fileName}</strong><small>{rows.length} linhas · {columns.length} colunas</small></div>
                {file.sheetNames.length > 1 && <select aria-label="Aba da planilha" value={sheetName} onChange={(event) => setSheetName(event.target.value)}>{file.sheetNames.map((name) => <option key={name}>{name}</option>)}</select>}
                {file.sheetNames.length === 1 && <span>{sheetName}</span>}
              </div>
              <div className="import-actions"><span>Prévia disponível · confira a identificação e as atribuições.</span><button className="button button-primary" onClick={importRows}>Validar e importar</button></div>
            </>
          )}
          {message && <div className="inline-success">{message}</div>}
          {error && <div className="inline-error" role="alert">{error}</div>}
        </section>

        <section className="panel import-history-panel">
          <div className="panel-heading"><div><h2>Importações recentes</h2><p className="muted">Histórico demonstrativo neste navegador</p></div></div>
          <div className="import-history-list">
            {imports.slice(0, 4).map((item) => (
              <article className="import-history-item" key={item.id}>
                <strong>{item.source}</strong><span>{item.fileName}</span><div><small>{formatDate(item.importedAt)}</small><small className="success-text">{item.orderCount} ordens</small></div>
              </article>
            ))}
          </div>
          <div className="mapping-note"><strong>Relacionamento das carteiras</strong><span>NPER e VENCER podem ser relacionados ao CONTROLE pela coluna ORDEM / NUM_CONSEQUENCIA. INSPEÇÃO usa OS como identificador próprio.</span></div>
        </section>
      </div>

      <section className="panel preview-panel">
        <div className="panel-heading"><div><h2>Prévia das ordens identificadas</h2><p className="muted">Apenas prévia local antes da importação.</p></div><span className="demo-tag">{rows.length ? rows.length + ' linhas no arquivo' : 'Sem arquivo selecionado'}</span></div>
        <div className="table-scroll"><table className="admin-table preview-table"><thead><tr><th>Ordem</th><th>Equipe</th><th>Serviço</th><th>Qtd. ajustada</th><th>Responsável</th></tr></thead>
          <tbody>{mappedPreview.map((row, index) => <tr key={index}><td>{row.numConsequencia || '—'}</td><td>{row.equipe || team}</td><td>{row.servico || '—'}</td><td>{row.qtdAjustada || '—'}</td><td>{row.responsavel || '—'}</td></tr>)}{mappedPreview.length === 0 && <tr><td colSpan={5} className="table-empty">Selecione uma planilha para visualizar os dados.</td></tr>}</tbody>
        </table></div>
        <p className="table-note">Os arquivos recebidos deste mês foram usados apenas para analisar o formato. Nenhum registro deles foi incluído nos dados demonstrativos.</p>
      </section>
    </main>
  );
}

function ProtocolsPage({ orders }: { orders: Order[] }) {
  const recorded = orders.filter((order) => order.protocolo);
  return (
    <main className="admin-content">
      <section className="panel orders-panel">
        <div className="panel-heading"><div><h2>Registros de auditoria</h2><p className="muted">Execuções e impedimentos enviados pelas equipes.</p></div><span className="count-chip">{recorded.length} protocolos</span></div>
        <div className="table-scroll"><table className="admin-table protocols-table"><thead><tr><th>Protocolo</th><th>Ordem</th><th>Equipe</th><th>Responsável</th><th>Registrado por</th><th>Situação</th><th>Evidência</th><th>Data</th></tr></thead>
          <tbody>{recorded.map((order) => <tr key={order.id}><td className="protocol-cell">{order.protocolo}</td><td>{order.numConsequencia}</td><td>{order.equipe}</td><td>{order.responsavel || '—'}</td><td>{order.registradoPor || '—'}</td><td><StatusBadge status={order.status} /></td><td>{order.foto ? <a className="table-action" href={order.foto} target="_blank" rel="noreferrer">Ver foto</a> : '—'}</td><td>{formatDate(order.dataRegistro)}</td></tr>)}{recorded.length === 0 && <tr><td colSpan={8} className="table-empty">Nenhum protocolo registrado.</td></tr>}</tbody>
        </table></div>
        <div className="protocol-footnote">Cada protocolo conserva a identificação da ordem, equipe, responsável, operador e horário do registro.</div>
      </section>
    </main>
  );
}

function AccessPage({ profiles, setProfiles, teamChoices }: { profiles: AccessProfile[]; setProfiles: (profiles: AccessProfile[]) => void; teamChoices: string[] }) {
  const [showForm, setShowForm] = useState(false);
  const [kind, setKind] = useState<ProfileKind>('inspecao');
  const [team, setTeam] = useState(teamOptions[0]);
  const [responsible, setResponsible] = useState('');
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<AccessProfile | null>(null);
  const [error, setError] = useState('');

  function createAccess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if (kind === 'terceirizada' && !responsible.trim()) {
      setError('Informe o responsável para limitar a carteira às ordens dele.');
      return;
    }
    const suffix = String(Math.floor(1000 + Math.random() * 9000));
    const codePrefix = kind === 'inspecao' ? 'INSP' : kind === 'terceirizada' ? 'TERC' : 'PROPRIA';
    const profile: AccessProfile = {
      id: 'profile-' + Date.now(),
      kind,
      label: label.trim() || (team + (responsible ? ' • ' + responsible.trim() : '')),
      code: codePrefix + '-' + suffix,
      password: String(Math.floor(1000 + Math.random() * 9000)),
      team,
      responsible: kind === 'terceirizada' ? responsible.trim() : undefined,
      active: true,
    };
    setProfiles([...profiles, profile]);
    setCreated(profile);
    setLabel('');
    setResponsible('');
    setShowForm(false);
  }

  function toggle(profile: AccessProfile) {
    setProfiles(profiles.map((item) => item.id === profile.id ? { ...item, active: !item.active } : item));
  }

  return (
    <main className="admin-content">
      <section className="panel access-panel">
        <div className="panel-heading"><div><h2>Perfis de acesso</h2><p className="muted">Cada perfil libera somente a carteira vinculada.</p></div><button className="button button-primary" onClick={() => { setShowForm((value) => !value); setCreated(null); }}>+ Criar perfil</button></div>
        <div className="security-note"><strong>Atribuição por acesso</strong><span>Para terceirizadas, crie um perfil individual por responsável. Assim, a pessoa entra com o próprio código e vê apenas as ordens com o mesmo RESPONSÁVEL.</span></div>
        {created && <div className="created-credentials"><div><strong>Acesso criado</strong><span>Guarde estes dados e repasse ao perfil correspondente.</span></div><code>{created.code} / {created.password}</code><button className="text-button" onClick={() => setCreated(null)}>Fechar</button></div>}
        {showForm && (
          <form className="access-form" onSubmit={createAccess}>
            <div className="form-heading"><h3>Novo perfil</h3><p>O supervisor administra os códigos; nenhum cadastro é feito pela equipe.</p></div>
            <div className="form-grid">
              <label className="field-group"><span>Tipo de acesso</span><select value={kind} onChange={(event) => setKind(event.target.value as ProfileKind)}><option value="inspecao">Inspeção</option><option value="terceirizada">Terceirizada</option><option value="propria">Própria Neoenergia</option></select></label>
              <label className="field-group"><span>Equipe / carteira</span><input list="access-team-choices" value={team} onChange={(event) => setTeam(event.target.value)} placeholder="Digite ou selecione uma equipe" /><datalist id="access-team-choices">{teamChoices.map((option) => <option key={option} value={option} />)}</datalist></label>
              {kind === 'terceirizada' && <label className="field-group"><span>Responsável da planilha</span><input value={responsible} onChange={(event) => setResponsible(event.target.value)} placeholder="Nome como aparece em RESPONSÁVEL" /></label>}
              <label className="field-group"><span>Nome do perfil (opcional)</span><input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Ex.: Vencer LM • responsável" /></label>
            </div>
            {error && <div className="inline-error">{error}</div>}
            <div className="form-actions"><button type="button" className="button button-ghost" onClick={() => setShowForm(false)}>Cancelar</button><button className="button button-primary" type="submit">Criar código e senha</button></div>
          </form>
        )}
        <div className="table-scroll"><table className="admin-table access-table"><thead><tr><th>Perfil</th><th>Tipo</th><th>Equipe</th><th>Responsável</th><th>Código</th><th>Estado</th><th>Ação</th></tr></thead>
          <tbody>{profiles.map((profile) => <tr key={profile.id}><td><strong>{profile.label}</strong></td><td>{kindLabels[profile.kind]}</td><td>{profile.team}</td><td>{profile.responsible || '—'}</td><td><code>{profile.code}</code></td><td><span className={profile.active ? 'profile-active' : 'profile-inactive'}>{profile.active ? 'Ativo' : 'Desativado'}</span></td><td><button className="table-action" onClick={() => toggle(profile)}>{profile.active ? 'Desativar' : 'Ativar'}</button></td></tr>)}</tbody>
        </table></div>
        <p className="local-warning">Demonstração local: códigos e senhas ficam neste navegador. A proteção real depende de autenticação e regras no banco.</p>
      </section>
    </main>
  );
}
