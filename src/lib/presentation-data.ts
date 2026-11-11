import type { Order } from '../types';
import { parseNumericQuantity } from './quantity.js';

export type PresentationGroup = {
  label: string;
  planned: number;
  completed: number;
  orders: number;
  completedOrders: number;
};

export type PresentationPeriod = {
  year: number;
  month: number;
  label: string;
  businessDays: number;
  workedDays: number;
};

export const presentationFronts = ['Poda LM', 'Roço manual', 'Bobcat', 'Linha viva', 'Estrutural próprio', 'Outros serviços'];

const monthNames = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

export function normalizePresentationLabel(value: string | undefined): string {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

export function adjustedQuantity(order: Order): number {
  return parseNumericQuantity(order.qtdAjustada) ?? 0;
}

export function presentationFront(order: Order): string {
  const service = normalizePresentationLabel(order.servico);
  const team = normalizePresentationLabel(order.equipe);
  const progress = normalizePresentationLabel(order.avanco);
  if (service === 'poda lv' || progress === 'vegetacao lv') return 'Linha viva';
  if (service === 'poda lm' || team === 'poda lm') return 'Poda LM';
  if (service === 'roco manual') return 'Roço manual';
  if (service === 'roco mecanizado' || team === 'bobcat') return 'Bobcat';
  if (progress === 'estruturais' && normalizePresentationLabel(order.empresa) !== 'vencer') return 'Estrutural próprio';
  return 'Outros serviços';
}

export function presentationUtd(order: Order): string {
  const original = Object.entries(order.original || {}).find(([header]) => normalizePresentationLabel(header) === 'utd')?.[1]?.trim();
  if (original) return original;
  const responsible = order.responsavel.replace(/^LV\s+/i, '').trim();
  return responsible || 'Sem UTD';
}

export function summarizePresentation(orders: Order[], labelOf: (order: Order) => string): PresentationGroup[] {
  const groups = new Map<string, PresentationGroup>();
  for (const order of orders) {
    const label = labelOf(order) || 'Sem classificação';
    const group = groups.get(label) || { label, planned: 0, completed: 0, orders: 0, completedOrders: 0 };
    const quantity = adjustedQuantity(order);
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

function monthFromFile(name: string | undefined): { year: number; month: number } | undefined {
  if (!name) return undefined;
  const normalized = normalizePresentationLabel(name);
  const year = normalized.match(/(?:^|\D)(20\d{2})(?=\D|$)/)?.[1];
  if (!year) return undefined;
  const namedMonth = monthNames.findIndex((month) => new RegExp(`\\b${month}\\b`).test(normalized));
  if (namedMonth >= 0) return { year: Number(year), month: namedMonth + 1 };
  const numeric = normalized.match(/(?:^|\D)(?:20\d{2})[-_. ]+(0?[1-9]|1[0-2])(?=\D|$)/)
    || normalized.match(/(?:^|\D)(0?[1-9]|1[0-2])[-_. ]+20\d{2}(?=\D|$)/);
  return numeric ? { year: Number(year), month: Number(numeric[1]) } : undefined;
}

function recifeDate(now: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Recife', year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(now);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value('year'), month: value('month'), day: value('day') };
}

function countBusinessDays(year: number, month: number, lastDay: number): number {
  let count = 0;
  for (let day = 1; day <= lastDay; day += 1) {
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count += 1;
  }
  return count;
}

export function presentationPeriod(orders: Order[], now = new Date()): PresentationPeriod {
  const today = recifeDate(now);
  const explicitCounts = new Map<string, number>();
  const legacyCounts = new Map<string, number>();
  for (const order of orders) {
    const referenceMonth = order.referenceMonth;
    if (referenceMonth && /^20\d{2}-(0[1-9]|1[0-2])$/.test(referenceMonth)) {
      explicitCounts.set(referenceMonth, (explicitCounts.get(referenceMonth) || 0) + 1);
      continue;
    }
    // Carteiras anteriores ao campo de período ainda precisam manter seu MTD original.
    const month = monthFromFile(order.sourceFile);
    if (month) {
      const key = `${month.year}-${month.month}`;
      legacyCounts.set(key, (legacyCounts.get(key) || 0) + 1);
    }
  }
  const counts = explicitCounts.size ? explicitCounts : legacyCounts;
  const selected = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  const [year, month] = selected ? selected.split('-').map(Number) : [today.year, today.month];
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const businessDays = countBusinessDays(year, month, lastDay);
  const beforeMonth = today.year < year || (today.year === year && today.month < month);
  const afterMonth = today.year > year || (today.year === year && today.month > month);
  const elapsedDay = beforeMonth ? 0 : afterMonth ? lastDay : today.day;
  // Ao encerrar o mês, a meta final considera todos os dias úteis da carteira.
  const workedDays = afterMonth ? businessDays : Math.max(0, countBusinessDays(year, month, elapsedDay) - 1);
  const formatted = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, month - 1, 1)));
  const label = formatted.charAt(0).toUpperCase() + formatted.slice(1);
  return { year, month, label, businessDays, workedDays };
}

export function isPortfolioExpired(period: Pick<PresentationPeriod, 'year' | 'month'>, now = new Date()): boolean {
  const today = recifeDate(now);
  return today.year > period.year || (today.year === period.year && today.month > period.month);
}

export function portfolioDeadlineLabel(period: Pick<PresentationPeriod, 'year' | 'month'>): string {
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(period.year, period.month, 0)));
}

export function expectedToDate(planned: number, period: PresentationPeriod): number {
  return period.businessDays > 0 ? planned * period.workedDays / period.businessDays : 0;
}

export function mtdPercent(planned: number, completed: number, period: PresentationPeriod): number | undefined {
  const expected = expectedToDate(planned, period);
  return expected > 0 ? completed / expected : undefined;
}

export function monthPercent(planned: number, completed: number): number | undefined {
  return planned > 0 ? completed / planned : undefined;
}
