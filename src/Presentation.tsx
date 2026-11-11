import { useEffect, useMemo, useState } from 'react';
import {
  monthPercent, mtdPercent, normalizePresentationLabel, presentationFront,
  presentationPeriod, presentationUtd, summarizePresentation,
} from './lib/presentation-data.js';
import type { PresentationGroup, PresentationPeriod } from './lib/presentation-data.js';
import type { Order } from './types';

type ExportContext = { company: string; responsible: string; operatorName: string };
type SheetSection = { title: string; band: string; rows: PresentationGroup[] };

const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 0 });
const knownUtds = ['AFOGADOS', 'ARCOVERDE', 'BOM CONSELHO', 'FLORESTA', 'GARANHUNS'];
const knownProgress = ['ESTRUTURAIS', 'PONTO QUENTE / CONEXÃO', 'PARA-RAIO', 'VEGETAÇÃO LM', 'VEGETAÇÃO LV', 'VEGETAÇÃO DENSA', 'PARA-RAIOS', 'ESPAÇADOR', 'CLIENTE', 'INSPEÇÃO'];

function percentage(value: number | undefined): string {
  return value === undefined ? '—' : percent.format(value);
}

function performanceClass(value: number | undefined): string {
  if (value === undefined) return 'presentation-signal-neutral';
  if (value >= 0.95) return 'presentation-signal-good';
  if (value >= 0.9) return 'presentation-signal-warning';
  return 'presentation-signal-low';
}

function canonicalUtd(value: string): string {
  const normalized = normalizePresentationLabel(value);
  return knownUtds.find((utd) => normalized === normalizePresentationLabel(utd) || normalized.startsWith(`${normalizePresentationLabel(utd)} `)) || value.toUpperCase();
}

function orderedGroups(groups: PresentationGroup[], order: string[], includeEmpty: boolean): PresentationGroup[] {
  const byName = new Map(groups.map((group) => [normalizePresentationLabel(group.label), group]));
  const standard = order.map((label) => byName.get(normalizePresentationLabel(label))
    || (includeEmpty ? { label, planned: 0, completed: 0, orders: 0, completedOrders: 0 } : undefined))
    .filter((group): group is PresentationGroup => Boolean(group));
  const remaining = groups.filter((group) => !order.some((label) => normalizePresentationLabel(label) === normalizePresentationLabel(group.label)))
    .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
  return [...standard, ...remaining];
}

function SheetBlock({ section, period }: { section: SheetSection; period: PresentationPeriod }) {
  return <section className={`presentation-sheet-section ${section.band}`} aria-label={section.title}>
    <div className="presentation-sheet-band"><span>{section.title}</span></div>
    <div className="presentation-sheet-table-wrap">
      <table className="presentation-sheet-table">
        <thead><tr><th scope="col">UTD</th><th scope="col">CARTEIRA</th><th scope="col">REALIZADO</th><th scope="col">% MTD</th><th scope="col">% MÊS</th></tr></thead>
        <tbody>{section.rows.map((row) => {
          const mtd = mtdPercent(row.planned, row.completed, period);
          const month = monthPercent(row.planned, row.completed);
          return <tr key={row.label}>
            <th scope="row">{row.label}{row.label === 'ADERÊNCIA DE CARTEIRA' && <small>ordens</small>}</th>
            <td data-label="Carteira">{number.format(row.planned)}</td>
            <td data-label="Realizado">{number.format(row.completed)}</td>
            <td data-label="% MTD"><span className="presentation-percent"><i className={performanceClass(mtd)} aria-hidden="true" />{percentage(mtd)}</span></td>
            <td data-label="% mês"><span className="presentation-percent"><i className={performanceClass(month)} aria-hidden="true" />{percentage(month)}</span></td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  </section>;
}

export function Presentation({ orders, compact = false, exportContext }: { orders: Order[]; compact?: boolean; exportContext?: ExportContext }) {
  const [today, setToday] = useState(() => new Date());
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

  useEffect(() => {
    const timer = window.setInterval(() => setToday(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const period = useMemo(() => presentationPeriod(orders, today), [orders, today]);
  const sections = useMemo(() => {
    const fronts: Array<{ title: string; front: string; band: string; utds: string[] }> = [
      { title: 'PODA LM', front: 'Poda LM', band: 'presentation-band-poda', utds: knownUtds },
      { title: 'BOBCAT', front: 'Bobcat', band: 'presentation-band-bobcat', utds: knownUtds },
      { title: 'LV', front: 'Linha viva', band: 'presentation-band-lv', utds: ['ARCOVERDE', 'GARANHUNS'] },
    ];
    const result: SheetSection[] = fronts.map(({ title, front, band, utds }) => ({
      title, band,
      rows: orderedGroups(
        summarizePresentation(orders.filter((order) => presentationFront(order) === front), (order) => canonicalUtd(presentationUtd(order))),
        utds, !compact,
      ),
    })).filter((section) => !compact || section.rows.length > 0);
    const byProgress = orderedGroups(summarizePresentation(orders, (order) => (order.avanco.trim() || 'SEM AVANÇO').toUpperCase()), knownProgress, false);
    const completedOrders = orders.filter((order) => order.status === 'executada').length;
    result.push({ title: 'CARTEIRA', band: 'presentation-band-carteira', rows: [
      ...byProgress,
      { label: 'ADERÊNCIA DE CARTEIRA', planned: orders.length, completed: completedOrders, orders: orders.length, completedOrders },
    ] });
    return result;
  }, [orders, compact]);

  async function downloadPresentation() {
    if (!exportContext || exporting || orders.length === 0) return;
    setExporting(true);
    setExportError('');
    try {
      const { exportPresentationWorkbook } = await import('./lib/export-presentation-workbook');
      await exportPresentationWorkbook({ ...exportContext, orders, period });
    } catch {
      setExportError('Não foi possível gerar a apresentação. Tente novamente.');
    } finally {
      setExporting(false);
    }
  }

  return <div className={compact ? 'presentation presentation-compact' : 'presentation'}>
    <div className="presentation-intro">
      <div><h2>{compact ? 'Apresentação da equipe' : 'Apresentação da carteira'}</h2><p>Dados atuais da quantidade ajustada. A última linha da carteira considera o número de ordens.</p></div>
      <div className="presentation-actions"><span className="presentation-live"><i />Dados atuais</span>{exportContext && orders.length > 0 && <button type="button" className="button button-export presentation-export" onClick={() => { void downloadPresentation(); }} disabled={exporting}>{exporting ? 'Gerando Excel…' : 'Exportar apresentação'}</button>}</div>
    </div>
    {exportError && <div className="inline-error" role="alert">{exportError}</div>}
    {orders.length === 0 ? <div className="presentation-empty">Nenhuma ordem vinculada a este acesso nesta carteira.</div> : <>
      <p className="presentation-period"><strong>{period.label}</strong><span>{period.businessDays} dias úteis no mês · {period.workedDays} considerados até hoje (menos 1 dia útil)</span></p>
      <div className="presentation-sheet">{sections.map((section) => <SheetBlock key={section.title} section={section} period={period} />)}</div>
      <p className="presentation-formula">% MTD = realizado ÷ meta proporcional aos dias úteis considerados. % mês = realizado ÷ carteira. Cores: vermelho abaixo de 90%, amarelo de 90% a 94%, verde a partir de 95%.</p>
    </>}
  </div>;
}
