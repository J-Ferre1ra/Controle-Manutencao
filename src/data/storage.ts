import { demoImports, demoOrders, demoProfiles } from './sample-data';
import type { AccessProfile, ImportRecord, Order, ProfileKind } from '../types';

const ORDERS_KEY = 'neoenergia-demo-orders-v1';
const PROFILES_KEY = 'neoenergia-demo-profiles-v1';
const IMPORTS_KEY = 'neoenergia-demo-imports-v1';

function readJson<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function loadOrders(): Order[] {
  return readJson<Order[]>(ORDERS_KEY, demoOrders).map((order) => {
    if (!order.id.startsWith('order-')) return order;
    const team = order.equipe === 'Inspeção 01' ? 'Inspetor 01' : order.equipe === 'Própria 02' ? 'Neoenergia 02' : order.equipe;
    return team === order.equipe ? order : { ...order, equipe: team };
  });
}

export function saveOrders(orders: Order[]): void {
  localStorage.setItem(ORDERS_KEY, JSON.stringify(orders));
}

export function loadProfiles(): AccessProfile[] {
  const profiles = readJson<AccessProfile[]>(PROFILES_KEY, demoProfiles);
  return profiles.map((profile) => {
    const storedKind = String((profile as AccessProfile & { kind: string }).kind);
    const teamAndLabel = (profile.team + ' ' + profile.label).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const kind: ProfileKind = storedKind === 'inspecao' ? 'inspetor'
      : storedKind === 'propria' ? 'neoenergia'
        : storedKind === 'terceirizada' ? (teamAndLabel.includes('nper') ? 'nper' : 'vencer')
          : (['inspetor', 'vencer', 'nper', 'neoenergia'].includes(storedKind) ? storedKind as ProfileKind : 'inspetor');
    const isDemoProfile = profile.id.startsWith('profile-') && (profile.code === 'INSP-04' || profile.code === 'PROPRIA-02');
    const team = profile.team === 'Inspeção 01' ? 'Inspetor 01' : profile.team === 'Própria 02' ? 'Neoenergia 02' : profile.team;
    const label = profile.code === 'INSP-04' ? 'Inspetor 01 • João Silva'
      : profile.code === 'PROPRIA-02' ? 'Neoenergia 02 • Carlos Menezes' : profile.label;
    const operatorName = profile.operatorName || profile.responsible || (profile.code === 'INSP-04' ? 'João Silva' : profile.code === 'PROPRIA-02' ? 'Carlos Menezes' : profile.label);
    return { ...profile, kind, team: isDemoProfile ? team : profile.team, label: isDemoProfile ? label : profile.label, operatorName };
  });
}

export function saveProfiles(profiles: AccessProfile[]): void {
  localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
}

export function loadImports(): ImportRecord[] {
  return readJson(IMPORTS_KEY, demoImports);
}

export function saveImports(imports: ImportRecord[]): void {
  localStorage.setItem(IMPORTS_KEY, JSON.stringify(imports));
}

export function resetDemoData(): void {
  localStorage.removeItem(ORDERS_KEY);
  localStorage.removeItem(PROFILES_KEY);
  localStorage.removeItem(IMPORTS_KEY);
}
