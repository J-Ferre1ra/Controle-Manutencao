import type * as XLSX from 'xlsx';
import type { Order, OrderStatus } from '../types';

export interface ParsedWorkbook {
  workbook: XLSX.WorkBook;
  sheetNames: string[];
  fileName: string;
}

export interface SpreadsheetRow {
  values: Record<string, string>;
}

const exportColumns = [
  'ALIMENTADOR',
  'BARRAMENTO',
  'QTD AJUSTADA',
  'QTD EXECUTADA',
  'NUM_CONSEQUENCIA',
  'EMPRESA',
  'EQUIPE',
  'SERVIÇO',
  'AVANÇO',
  'RESPONSÁVEL',
  'SITUAÇÃO',
  'MOTIVO DO IMPEDIMENTO',
  'OBSERVAÇÃO',
  'REGISTRADO POR',
  'DATA DO REGISTRO',
  'PROTOCOLO',
];

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

function textValue(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

function columnNumber(column: string): number {
  return [...column.toUpperCase()].reduce((value, character) => value * 26 + character.charCodeAt(0) - 64, 0) - 1;
}

function columnName(index: number): string {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function cellPosition(address: string): { row: number; column: number } | null {
  const match = address.match(/^([A-Z]+)(\d+)$/i);
  return match ? { column: columnNumber(match[1]), row: Number(match[2]) - 1 } : null;
}

function findValue(row: Record<string, unknown>, aliases: string[]): string {
  const entries = Object.entries(row);
  for (const alias of aliases) {
    const target = normalize(alias);
    const match = entries.find(([key]) => normalize(key) === target);
    if (match) return textValue(match[1]);
  }
  return '';
}

export async function readWorkbook(file: File): Promise<ParsedWorkbook> {
  const XLSX = await import('xlsx');
  const data = await file.arrayBuffer();
  const workbook = XLSX.read(data, { type: 'array', cellDates: true });
  return { workbook, sheetNames: workbook.SheetNames, fileName: file.name };
}

export function rowsFromSheet(workbook: XLSX.WorkBook, sheetName: string): SpreadsheetRow[] {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return [];
  const range = sheet['!ref']?.split(':');
  if (!range?.length) return [];
  const start = cellPosition(range[0]);
  const end = cellPosition(range[1] || range[0]);
  if (!start || !end || end.row <= start.row) return [];
  const cellValue = (row: number, column: number): unknown => {
    const cell = sheet[columnName(column) + (row + 1)] as { v?: unknown; w?: string } | undefined;
    return cell?.w ?? cell?.v ?? '';
  };
  const headers = Array.from({ length: end.column - start.column + 1 }, (_, index) =>
    textValue(cellValue(start.row, start.column + index)),
  );
  return Array.from({ length: end.row - start.row }, (_, rowIndex) => {
    const row = start.row + rowIndex + 1;
    const values: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (header) values[header] = textValue(cellValue(row, start.column + index));
    });
    return { values };
  });
}

export function mapSpreadsheetRow(row: SpreadsheetRow, teamFallback: string): Omit<Order, 'id' | 'status'> {
  const raw = row.values;
  return {
    alimentador: findValue(raw, ['ALIMENTADOR', 'ALIM']),
    barramento: findValue(raw, ['BARRAMENTO', 'BARRA']),
    qtdAjustada: findValue(raw, ['QTD AJUSTADA', 'QTD. AJUSTADA', 'QUANT AJUSTADA', 'QUANTIDADE AJUSTADA', 'QTD PREVISTA', 'QUANTIDADE', 'QUANT', 'QTD']),
    numConsequencia: findValue(raw, ['NUM_CONSEQUENCIA', 'NUM CONSEQUENCIA', 'NÚMERO DA ORDEM', 'ORDEM', 'OS']),
    empresa: findValue(raw, ['EMPRESA', 'CONTRATADA']),
    equipe: findValue(raw, ['EQUIPE', 'TURMA']) || teamFallback,
    servico: findValue(raw, ['SERVIÇO', 'SERVICO', 'DEFEITO', 'TIPO EMR', 'TIPO DE REDE', 'DESCRIÇÃO DO SERVIÇO', 'DESCRICAO']),
    avanco: findValue(raw, ['AVANÇO', 'AVANCO', 'PROGRESSO']),
    responsavel: findValue(raw, ['RESPONSÁVEL', 'RESPONSAVEL', 'ENCARREGADO']),
    endereco: findValue(raw, ['ENDEREÇO', 'ENDERECO', 'LOCAL']),
    original: raw,
  };
}

function statusLabel(status: OrderStatus): string {
  if (status === 'executada') return 'Executada';
  if (status === 'impedimento') return 'Impedimento';
  return 'Pendente';
}

function normalizeHeader(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

function valueForHeader(header: string, order: Order): string | number {
  const key = normalizeHeader(header);
  if (key === 'ALIMENTADOR' || key === 'ALIM') return order.alimentador;
  if (key === 'BARRAMENTO' || key === 'BARRA') return order.barramento;
  if (key.startsWith('QTD') || key.startsWith('QUANT')) {
    return key.includes('EXECUT') ? (order.qtdExecutada ?? '') : order.qtdAjustada;
  }
  if (key === 'NUM CONSEQUENCIA' || key === 'ORDEM' || key === 'OS') return order.numConsequencia;
  if (key === 'EMPRESA' || key === 'CONTRATADA') return order.empresa;
  if (key === 'EQUIPE' || key === 'TURMA') return order.equipe;
  if (key === 'SERVICO' || key === 'DEFEITO' || key === 'DESCRICAO') return order.servico;
  if (key === 'AVANCO' || key === 'PROGRESSO') return order.avanco;
  if (key === 'RESPONSAVEL') return order.responsavel;
  if (order.original && order.original[header] !== undefined) return order.original[header];
  return '';
}

function columnsForTeam(orders: Order[]): string[] {
  const sourceColumns = orders.find((order) => order.sourceColumns?.length)?.sourceColumns;
  const columns = sourceColumns?.length ? [...sourceColumns] : exportColumns.slice(0, 10);
  const normalized = columns.map(normalizeHeader);
  if (!normalized.includes('QTD EXECUTADA')) {
    const quantityIndex = normalized.findIndex((value) => value.startsWith('QTD') || value.startsWith('QUANT'));
    columns.splice(quantityIndex >= 0 ? quantityIndex + 1 : 3, 0, 'QTD EXECUTADA');
  }
  ['SITUAÇÃO', 'MOTIVO DO IMPEDIMENTO', 'OBSERVAÇÃO', 'REGISTRADO POR', 'DATA DO REGISTRO', 'PROTOCOLO'].forEach((column) => {
    if (!columns.map(normalizeHeader).includes(normalizeHeader(column))) columns.push(column);
  });
  return columns;
}

export async function exportOrdersByTeam(orders: Order[], fileName = 'ordens-execucao.xlsx'): Promise<void> {
  const XLSX = await import('xlsx');
  const workbook = XLSX.utils.book_new();
  const teams = [...new Set(orders.map((order) => order.equipe || 'Sem equipe'))];
  teams.forEach((team, index) => {
    const teamOrders = orders.filter((order) => (order.equipe || 'Sem equipe') === team);
    const columns = columnsForTeam(teamOrders);
    const rows = teamOrders.map((order) => {
      const row: Record<string, string | number> = {};
      columns.forEach((header) => {
        const normalized = normalizeHeader(header);
        if (normalized === 'SITUACAO') row[header] = statusLabel(order.status);
        else if (normalized === 'MOTIVO DO IMPEDIMENTO') row[header] = order.motivoImpedimento ?? '';
        else if (normalized === 'OBSERVACAO') row[header] = order.observacao ?? '';
        else if (normalized === 'REGISTRADO POR') row[header] = order.registradoPor ?? '';
        else if (normalized === 'DATA DO REGISTRO') row[header] = order.dataRegistro ? new Date(order.dataRegistro).toLocaleString('pt-BR') : '';
        else if (normalized === 'PROTOCOLO') row[header] = order.protocolo ?? '';
        else row[header] = valueForHeader(header, order);
      });
      return row;
    });
    const sheet = XLSX.utils.json_to_sheet(rows, { header: columns });
    sheet['!cols'] = [
      { wch: 18 }, { wch: 16 }, { wch: 18 }, { wch: 18 }, { wch: 20 }, { wch: 18 },
      { wch: 20 }, { wch: 30 }, { wch: 14 }, { wch: 24 }, { wch: 18 }, { wch: 28 },
      { wch: 42 }, { wch: 24 }, { wch: 24 }, { wch: 24 },
    ];
    XLSX.utils.book_append_sheet(workbook, sheet, (team || 'Equipe ' + (index + 1)).slice(0, 31));
  });
  XLSX.writeFile(workbook, fileName);
}
