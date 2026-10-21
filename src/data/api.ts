import type { AccessProfile, ImportRecord, Order, SessionProfile } from '../types';

export interface SharedAppState {
  orders: Order[];
  profiles: AccessProfile[];
  imports: ImportRecord[];
  sync?: SyncCursor;
  full?: boolean;
  unchanged?: boolean;
}

export interface SyncCursor {
  catalogRevision: number;
  changeRevision: number;
}

export interface RemoteSession extends SessionProfile {
  isAdmin: boolean;
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
  });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || 'Não foi possível conversar com o servidor.');
  return data;
}

export async function readSharedState(cursor?: SyncCursor | null): Promise<SharedAppState> {
  const query = cursor
    ? `?catalogRevision=${cursor.catalogRevision}&changeRevision=${cursor.changeRevision}`
    : '';
  return apiRequest<SharedAppState>(`/api/state${query}`);
}
