import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { parseNumericQuantity } from './lib/quantity.js';
import type { Order } from './types';

type Group = { label: string; planned: number; completed: number; orders: number; completedOrders: number };
type ExportContext = { company: string; responsible: string; operatorName: string };

const fronts = ['Poda LM', 'Roço manual', 'Bobcat', 'Linha viva', 'Estrutural próprio', 'Outros serviços'];
const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });

function normalize(value: string | undefined): string {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

function adjusted(order: Order): number {
  return parseNumericQuantity(order.qtdAjustada) ?? 0;
}

function frontOf(order: Order): string {
  const service = normalize(order.servico);
  const team = normalize(order.equipe);
  const progress = normalize(order.avanco);
  if (service === 'poda lv' || progress === 'vegetacao lv') return 'Linha viva';
  if (service === 'poda lm' || team === 'poda lm') return 'Poda LM';
  if (service === 'roco manual') return 'Roço manual';
  if (service === 'roco mecanizado' || team === 'bobcat') return 'Bobcat';
  if (progress === 'estruturais' && normalize(order.empresa) !== 'vencer') return 'Estrutural próprio';
  return 'Outros serviços';
}

function utdOf(order: Order): string {
  const original = Object.entries(order.original || {}).find(([header]) => normalize(header) === 'utd')?.[1]?.trim();
  if (original) return original;
  const responsible = order.responsavel.replace(/^LV\s+/i, '').trim();
  return responsible || 'Sem UTD';
}

function summarize(orders: Order[], labelOf: (order: Order) => string): Group[] {
  const groups = new Map<string, Group>();
  for (const order of orders) {
    const label = labelOf(order) || 'Sem classificação';
    const group = groups.get(label) || { label, planned: 0, completed: 0, orders: 0, completedOrders: 0 };
    const quantity = adjusted(order);
    group.planned += quantity;
    group.orders += 1;
    if (order.status === 'executada') {
      group.completed += quantity;
      group.completedOrders += 1;
    }
    groups.set(label, group);
  }
  return [...groups.values()];
}

function Chart({ groups, title }: { groups: Group[]; title: string }) {
  const rows = groups.map((group) => ({ ...group, pending: Math.max(0, group.planned - group.completed) }));
  if (!rows.length) return <p className="presentation-empty">Nenhum dado nesta seleção.</p>;
  return <><div className="presentation-chart" role="img" aria-label={title}>
    <ResponsiveContainer width="100%" height={Math.max(135, rows.length * 44 + 32)}>
      <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 22, left: 0, bottom: 8 }}>
        <CartesianGrid stroke="#e8eef0" horizontal={false} />
        <XAxis type="number" tickFormatter={(value: number) => number.format(value)} tick={{ fill: '#6d838d', fontSize: 12 }} />
        <YAxis type="category" dataKey="label" width={112} tick={{ fill: '#365460', fontSize: 12 }} tickFormatter={(label: string) => label.length > 17 ? `${label.slice(0, 16)}…` : label} />
        <Tooltip formatter={(value, name) => [number.format(Number(value || 0)), name === 'completed' ? 'Executada' : 'Pendente']} labelStyle={{ color: '#173e50' }} />
        <Bar name="completed" dataKey="completed" stackId="quantity" fill="#00a859" maxBarSize={22} />
        <Bar name="pending" dataKey="pending" stackId="quantity" fill="#c5d9dc" maxBarSize={22} />
      </BarChart>
    </ResponsiveContainer>
  </div><div className="presentation-values" aria-label={`Valores de ${title}`}>
    <p>Concluída / carteira</p>
    <div>{rows.map((row) => <div key={row.label}><span>{row.label}</span><strong>{number.format(row.completed)} / {number.format(row.planned)}</strong></div>)}</div>
  </div></>;
}

export function Presentation({ orders, compact = false, exportContext }: { orders: Order[]; compact?: boolean; exportContext?: ExportContext }) {
  const [front, setFront] = useState('Poda LM');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const frontGroups = useMemo(() => {
    const groups = summarize(orders, frontOf);
    return fronts.map((label) => groups.find((group) => group.label === label)).filter((group): group is Group => Boolean(group));
  }, [orders]);
  const progressGroups = useMemo(() => summarize(orders, (order) => order.avanco.trim() || 'Sem avanço')
    .sort((a, b) => b.planned - a.planned), [orders]);
  const selectedFront = frontGroups.some((group) => group.label === front) ? front : frontGroups[0]?.label || front;
  const byUtd = useMemo(() => summarize(orders.filter((order) => frontOf(order) === selectedFront), utdOf)
    .sort((a, b) => b.planned - a.planned), [orders, selectedFront]);
  const total = orders.reduce((sum, order) => sum + adjusted(order), 0);
  const completed = orders.reduce((sum, order) => sum + (order.status === 'executada' ? adjusted(order) : 0), 0);
  const completedOrders = orders.filter((order) => order.status === 'executada').length;
  const percent = total > 0 ? Math.round(completed / total * 100) : 0;
  const ordersPercent = orders.length > 0 ? Math.round(completedOrders / orders.length * 100) : 0;

  async function downloadPresentation() {
    if (!exportContext || exporting || orders.length === 0) return;
    setExporting(true);
    setExportError('');
    try {
      const { exportPresentationPdf } = await import('./lib/export-presentation-pdf');
      await exportPresentationPdf({
        ...exportContext,
        planned: total,
        completed,
        orderCount: orders.length,
        completedOrders,
        fronts: frontGroups,
        advances: progressGroups,
        utds: byUtd,
        selectedFront,
      });
    } catch {
      setExportError('Não foi possível gerar o PDF. Tente novamente.');
    } finally {
      setExporting(false);
    }
  }

  return <div className={compact ? 'presentation presentation-compact' : 'presentation'}>
    <div className="presentation-intro"><div><h2>{compact ? 'Sua carteira em números' : 'Apresentação da carteira'}</h2><p>Quantidade ajustada da carteira atual, atualizada conforme as ordens são registradas.</p></div><div className="presentation-actions"><span className="presentation-live"><i />Dados atuais</span>{exportContext && orders.length > 0 && <button type="button" className="button button-secondary presentation-export" onClick={() => { void downloadPresentation(); }} disabled={exporting}>{exporting ? 'Gerando PDF…' : 'Exportar PDF'}</button>}</div></div>
    {exportError && <div className="inline-error" role="alert">{exportError}</div>}
    {orders.length === 0 ? <div className="presentation-empty">Nenhuma ordem vinculada a este acesso nesta carteira.</div> : <>
      <section className="presentation-summary" aria-label="Resumo da quantidade ajustada">
        <div><span>Quantidade ajustada</span><strong>{number.format(total)}</strong><small>prevista na carteira</small></div>
        <div><span>Quantidade executada</span><strong>{number.format(completed)}</strong><small>ajustada nas ordens concluídas</small></div>
        <div><span>Quantidade pendente</span><strong>{number.format(Math.max(0, total - completed))}</strong><small>{percent}% da quantidade concluída</small></div>
      </section>
      <section className="presentation-panel"><div className="presentation-panel-heading"><div><h3>Frentes de serviço</h3><p>Quantidade ajustada por tipo de trabalho</p></div><span className="presentation-key"><i /> Executada <i /> Pendente</span></div><Chart groups={frontGroups} title="Quantidade ajustada executada e pendente por frente de serviço" /></section>
      <section className="presentation-panel"><div className="presentation-panel-heading"><div><h3>Defeitos por avanço</h3><p>Distribuição da quantidade ajustada da coluna AVANÇO</p></div></div><Chart groups={progressGroups} title="Quantidade ajustada executada e pendente por avanço" /></section>
      <section className="presentation-panel"><div className="presentation-panel-heading"><div><h3>Visão por UTD</h3><p>Carteira e execução da frente selecionada</p></div><label className="presentation-front-select">Frente<select value={selectedFront} onChange={(event) => setFront(event.target.value)}>{frontGroups.map((group) => <option key={group.label}>{group.label}</option>)}</select></label></div><Chart groups={byUtd} title={`Quantidade ajustada de ${selectedFront} por UTD`} /></section>
      <section className="presentation-panel presentation-orders"><div className="presentation-panel-heading"><div><h3>Aderência da carteira</h3><p>Nesta seção, a medida é o número de ordens.</p></div></div><div className="presentation-order-stats"><div><strong>{number.format(orders.length)}</strong><span>ordens na carteira</span></div><div><strong>{number.format(completedOrders)}</strong><span>ordens executadas</span></div><div><strong>{ordersPercent}%</strong><span>das ordens concluídas</span></div></div></section>
    </>}
  </div>;
}
