import { demoImports, demoOrders, demoProfiles } from './sample-data';
import type { AccessProfile, ImportRecord, Order } from '../types';

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
  return readJson(ORDERS_KEY, demoOrders);
}

export function saveOrders(orders: Order[]): void {
  localStorage.setItem(ORDERS_KEY, JSON.stringify(orders));
}

export function loadProfiles(): AccessProfile[] {
  return readJson(PROFILES_KEY, demoProfiles);
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
