export type ProfileKind = 'inspetor' | 'vencer' | 'nper' | 'neoenergia';
export type OrderStatus = 'pendente' | 'executada' | 'impedimento';
export type AdminPage = 'painel' | 'controle' | 'ordens' | 'importacao' | 'protocolos' | 'acessos';

export interface AccessProfile {
  id: string;
  kind: ProfileKind;
  label: string;
  operatorName?: string;
  code: string;
  password: string;
  team: string;
  responsible?: string;
  active: boolean;
}

export interface Order {
  id: string;
  alimentador: string;
  barramento: string;
  qtdAjustada: string;
  qtdExecutada?: number;
  numConsequencia: string;
  empresa: string;
  equipe: string;
  servico: string;
  avanco: string;
  responsavel: string;
  endereco?: string;
  status: OrderStatus;
  observacao?: string;
  motivoImpedimento?: string;
  foto?: string;
  protocolo?: string;
  registradoPor?: string;
  dataRegistro?: string;
  original?: Record<string, string>;
  sourceColumns?: string[];
  sourceSheet?: string;
  sourceFile?: string;
  sourceKind?: 'controle' | 'inspecao' | 'nper' | 'vencer';
}

export interface ImportRecord {
  id: string;
  fileName: string;
  source: string;
  team: string;
  importedAt: string;
  orderCount: number;
  duplicateCount?: number;
  excludedCount?: number;
  sheetName?: string;
}

export interface ExecutionNotification {
  id: string;
  orderNumber: string;
  team: string;
  service: string;
  registeredBy: string;
  status: OrderStatus;
  quantity?: number;
  occurredAt: string;
  protocol: string;
}

export interface SessionProfile {
  kind: ProfileKind;
  label: string;
  team: string;
  responsible?: string;
  operatorName: string;
}
