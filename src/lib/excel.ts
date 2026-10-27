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
  'STATUS DO ÚLTIMO REGISTRO',
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
  const adjustedQuantity = findValue(raw, ['QTD AJUSTADA', 'QTD. AJUSTADA', 'QUANT AJUSTADA', 'QUANTIDADE AJUSTADA', 'QTD PREVISTA', 'QUANTIDADE', 'QUANT', 'QTD']);
  const plannedKilometers = findValue(raw, ['KM_PLANO', 'KM PLANO']);
  const executedQuantity = findValue(raw, ['QTD EXECUTADA', 'QUANT EXECUTADA', 'QUANTIDADE EXECUTADA']);
  return {
    alimentador: findValue(raw, ['ALIMENTADOR', 'ALIM']),
    barramento: findValue(raw, ['BARRAMENTO', 'BARRA']),
    qtdAjustada: adjustedQuantity || (plannedKilometers ? plannedKilometers + ' km' : ''),
    qtdExecutada: numericQuantity(executedQuantity) ?? undefined,
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

function latestRegistrationStatus(order: Order): OrderStatus | undefined {
  return order.situacaoRegistro || (order.status === 'impedimento' || order.status === 'executada' ? order.status : undefined);
}

function registrationStatusLabel(order: Order): string {
  const status = latestRegistrationStatus(order);
  return status ? statusLabel(status) : 'Sem registro';
}

function normalizeHeader(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

function canonicalCompany(value: string): string {
  const normalized = normalizeHeader(value);
  return normalized === 'NPER' ? 'NEOENERGIA' : normalized;
}

function companyLabel(value: string): string {
  return canonicalCompany(value) === 'NEOENERGIA' ? 'Neoenergia' : value || 'Sem empresa';
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
  ['SITUAÇÃO', 'STATUS DO ÚLTIMO REGISTRO', 'MOTIVO DO IMPEDIMENTO', 'OBSERVAÇÃO', 'REGISTRADO POR', 'DATA DO REGISTRO', 'PROTOCOLO'].forEach((column) => {
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
        else if (normalized === 'STATUS DO ULTIMO REGISTRO') row[header] = registrationStatusLabel(order);
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

const controlColumns = [
  'UTD',
  'ALIMENTADOR',
  'CHAVE_DIRECIONADORA',
  'BARRAMENTO',
  'QTD. AJUSTADA',
  'NUM_CONSEQUENCIA',
  'TIPO_DOCUMENTO',
  'INF',
  'STATUS',
  'TIPO DE PRIORIZAÇÃO',
  'MÊS PROGRAMADO',
  'EMPRESA',
  'EQUIPE',
  'SERVIÇO',
  'AVANÇO',
  'EQM',
  'RESPONSÁVEL',
  'QTD EXECUTADA',
  'QTD CONSIDERADA',
  'SITUAÇÃO DA EXECUÇÃO',
  'STATUS DO ÚLTIMO REGISTRO',
  'MOTIVO DO IMPEDIMENTO',
  'OBSERVAÇÃO',
  'REGISTRADO POR',
  'DATA DO REGISTRO',
  'PROTOCOLO',
];

function numericQuantity(value: string | number | undefined): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = value.trim().replace(/[^\d,.-]/g, '');
  if (!cleaned) return null;
  const normalized = cleaned.includes(',') && cleaned.includes('.')
    ? cleaned.replace(/\./g, '').replace(',', '.')
    : cleaned.replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function formulaCell(sheet: XLSX.WorkSheet, address: string, formula: string, value: number, format?: string): void {
  sheet[address] = { t: 'n', f: formula, v: value, ...(format ? { z: format } : {}) };
}

function formulaSheet(XLSX: typeof import('xlsx'), rows: unknown[][], widths: number[]): XLSX.WorkSheet {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = widths.map((wch) => ({ wch }));
  return sheet;
}

function setFilter(sheet: XLSX.WorkSheet, rowCount: number, columnCount: number): void {
  sheet['!autofilter'] = { ref: `A1:${columnName(columnCount - 1)}${Math.max(rowCount, 1)}` };
}

/** Exports a consolidated workbook inspired by the supplied Controle workbook, without its monthly order data. */
export async function exportControlWorkbook(orders: Order[], fileName = 'controle-execucao-neoenergia.xlsx'): Promise<void> {
  const XLSX = await import('xlsx');
  const workbook = XLSX.utils.book_new();
  const sourceColumns = [...new Set(orders.flatMap((order) => order.sourceColumns ?? []))];
  const columns: string[] = [];
  const seenColumns = new Set<string>();
  [...sourceColumns, ...controlColumns].forEach((header) => {
    const key = normalizeHeader(header);
    if (key && !seenColumns.has(key)) {
      seenColumns.add(key);
      columns.push(header);
    }
  });

  const masterRows: unknown[][] = [columns];
  orders.forEach((order) => {
    const row = columns.map((header) => {
      const key = normalizeHeader(header);
      if (key === 'QTD AJUSTADA') return numericQuantity(order.qtdAjustada) ?? order.qtdAjustada;
      if (key === 'QTD EXECUTADA') return order.qtdExecutada ?? '';
      if (key === 'QTD CONSIDERADA') return '';
      if (key === 'EQUIPE') return order.equipe || 'Sem equipe';
      if (key === 'EMPRESA') return order.empresa || 'Sem empresa';
      if (key === 'SITUACAO DA EXECUCAO') return statusLabel(order.status);
      if (key === 'STATUS DO ULTIMO REGISTRO') return registrationStatusLabel(order);
      if (key === 'MOTIVO DO IMPEDIMENTO') return order.motivoImpedimento ?? '';
      if (key === 'OBSERVACAO') return order.observacao ?? '';
      if (key === 'REGISTRADO POR') return order.registradoPor ?? '';
      if (key === 'DATA DO REGISTRO') return order.dataRegistro ? new Date(order.dataRegistro).toLocaleString('pt-BR') : '';
      if (key === 'PROTOCOLO') return order.protocolo ?? '';
      return valueForHeader(header, order);
    });
    masterRows.push(row);
  });

  const master = XLSX.utils.aoa_to_sheet(masterRows);
  const quantityIndex = columns.findIndex((header) => normalizeHeader(header) === 'QTD CONSIDERADA');
  const adjustedIndex = columns.findIndex((header) => normalizeHeader(header) === 'QTD AJUSTADA');
  const executedIndex = columns.findIndex((header) => normalizeHeader(header) === 'QTD EXECUTADA');
  const statusColumnIndex = columns.findIndex((header) => normalizeHeader(header) === 'SITUACAO DA EXECUCAO');
  const registrationStatusIndex = columns.findIndex((header) => normalizeHeader(header) === 'STATUS DO ULTIMO REGISTRO');
  orders.forEach((order, index) => {
    const rowNumber = index + 2;
    const executed = order.qtdExecutada ?? 0;
    const statusCell = `${columnName(statusColumnIndex)}${rowNumber}`;
    const formula = `IF(${statusCell}="Executada",IFERROR(VALUE(${columnName(executedIndex)}${rowNumber}),0),0)`;
    formulaCell(master, `${columnName(quantityIndex)}${rowNumber}`, formula, order.status === 'executada' ? executed : 0, '0.##');
  });
  master['!cols'] = columns.map((header) => {
    const key = normalizeHeader(header);
    if (key.includes('OBSERVACAO') || key.includes('MOTIVO')) return { wch: 38 };
    if (key === 'SERVICO' || key === 'TIPO DE PRIORIZACAO') return { wch: 30 };
    if (key === 'PROTOCOLO') return { wch: 25 };
    if (key.includes('DATA')) return { wch: 22 };
    if (key.includes('RESPONSAVEL') || key === 'EMPRESA' || key === 'EQUIPE') return { wch: 22 };
    return { wch: 17 };
  });
  setFilter(master, masterRows.length, columns.length);
  XLSX.utils.book_append_sheet(workbook, master, 'ACOMPANHAMENTO');

  const lastRow = Math.max(orders.length + 1, 2);
  const range = (column: number) => `ACOMPANHAMENTO!$${columnName(column)}$2:$${columnName(column)}$${lastRow}`;
  const statusColumn = statusColumnIndex;
  const adjustedRange = range(adjustedIndex);
  const executedRange = range(executedIndex);
  const consideredRange = range(quantityIndex);
  const statusRange = range(statusColumn);
  const registrationStatusRange = range(registrationStatusIndex);
  const total = orders.length;
  const completed = orders.filter((order) => order.status === 'executada').length;
  const blocked = orders.filter((order) => latestRegistrationStatus(order) === 'impedimento').length;
  const pending = orders.filter((order) => order.status === 'pendente').length;
  const plannedQuantity = orders.reduce((sum, order) => sum + (numericQuantity(order.qtdAjustada) ?? 0), 0);
  const reportedQuantity = orders.reduce((sum, order) => sum + (order.qtdExecutada ?? 0), 0);
  const consideredQuantity = orders.reduce((sum, order) => sum + (order.status === 'executada' ? order.qtdExecutada ?? 0 : 0), 0);
  const presentationRows: unknown[][] = [
    ['APRESENTAÇÃO • CONTROLE DA EXECUÇÃO'],
    ['Indicador', 'Resultado'],
    ['Ordens na carteira', ''],
    ['Executadas', ''],
    ['Impedimentos', ''],
    ['Pendentes', ''],
    ['Percentual executado', ''],
    ['Quantidade ajustada', ''],
    ['Quantidade informada pelas equipes', ''],
    ['Quantidade considerada', ''],
    [],
    ['Impedimentos são tentativas registradas; essas ordens continuam pendentes até uma execução. A quantidade considerada soma a QTD EXECUTADA das ordens executadas.'],
  ];
  const presentation = formulaSheet(XLSX, presentationRows, [42, 20]);
  formulaCell(presentation, 'B3', `COUNTIF(${statusRange},"<>")`, total);
  formulaCell(presentation, 'B4', `COUNTIF(${statusRange},"Executada")`, completed);
  formulaCell(presentation, 'B5', `COUNTIF(${registrationStatusRange},"Impedimento")`, blocked);
  formulaCell(presentation, 'B6', `COUNTIF(${statusRange},"Pendente")`, pending);
  formulaCell(presentation, 'B7', 'IF(B3=0,0,B4/B3)', total ? completed / total : 0, '0%');
  formulaCell(presentation, 'B8', `SUM(${adjustedRange})`, plannedQuantity, '0.##');
  formulaCell(presentation, 'B9', `SUM(${executedRange})`, reportedQuantity, '0.##');
  formulaCell(presentation, 'B10', `SUM(${consideredRange})`, consideredQuantity, '0.##');
  XLSX.utils.book_append_sheet(workbook, presentation, 'APRESENTAÇÃO');

  const teamColumn = columns.findIndex((header) => normalizeHeader(header) === 'EQUIPE');
  const teams = [...new Set(orders.map((order) => order.equipe || 'Sem equipe'))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const teamRows: unknown[][] = [['EQUIPE', 'ORDENS', 'EXECUTADAS', 'IMPEDIMENTOS', 'PENDENTES', '% EXECUÇÃO', 'QTD. AJUSTADA', 'QTD EXECUTADA', 'QTD CONSIDERADA']];
  teams.forEach((team) => teamRows.push([team, '', '', '', '', '', '', '', '']));
  const byTeam = formulaSheet(XLSX, teamRows, [27, 13, 14, 16, 13, 15, 17, 17, 19]);
  teams.forEach((team, index) => {
    const rowNumber = index + 2;
    const teamCriteria = `$A${rowNumber}`;
    const teamRange = range(teamColumn);
    const teamOrders = orders.filter((order) => (order.equipe || 'Sem equipe') === team);
    const countStatus = (status: OrderStatus) => teamOrders.filter((order) => status === 'impedimento'
      ? latestRegistrationStatus(order) === status
      : order.status === status).length;
    const teamPlanned = teamOrders.reduce((sum, order) => sum + (numericQuantity(order.qtdAjustada) ?? 0), 0);
    const teamReported = teamOrders.reduce((sum, order) => sum + (order.qtdExecutada ?? 0), 0);
    const teamConsidered = teamOrders.reduce((sum, order) => sum + (order.status === 'executada' ? order.qtdExecutada ?? 0 : 0), 0);
    formulaCell(byTeam, `B${rowNumber}`, `COUNTIF(${teamRange},${teamCriteria})`, teamOrders.length);
    formulaCell(byTeam, `C${rowNumber}`, `COUNTIFS(${teamRange},${teamCriteria},${statusRange},"Executada")`, countStatus('executada'));
    formulaCell(byTeam, `D${rowNumber}`, `COUNTIFS(${teamRange},${teamCriteria},${registrationStatusRange},"Impedimento")`, countStatus('impedimento'));
    formulaCell(byTeam, `E${rowNumber}`, `COUNTIFS(${teamRange},${teamCriteria},${statusRange},"Pendente")`, countStatus('pendente'));
    formulaCell(byTeam, `F${rowNumber}`, `IF(B${rowNumber}=0,0,C${rowNumber}/B${rowNumber})`, teamOrders.length ? countStatus('executada') / teamOrders.length : 0, '0%');
    formulaCell(byTeam, `G${rowNumber}`, `SUMIF(${teamRange},${teamCriteria},${adjustedRange})`, teamPlanned, '0.##');
    formulaCell(byTeam, `H${rowNumber}`, `SUMIF(${teamRange},${teamCriteria},${executedRange})`, teamReported, '0.##');
    formulaCell(byTeam, `I${rowNumber}`, `SUMIF(${teamRange},${teamCriteria},${consideredRange})`, teamConsidered, '0.##');
  });
  setFilter(byTeam, teamRows.length, teamRows[0].length);
  XLSX.utils.book_append_sheet(workbook, byTeam, 'POR EQUIPE');

  const responsibleGroups = [...new Map(orders
    .filter((order) => order.responsavel.trim())
    .map((order) => {
      const companyKey = canonicalCompany(order.empresa || 'Sem empresa');
      const responsibleKey = normalizeHeader(order.responsavel);
      return [`${companyKey}\u0000${responsibleKey}`, { companyKey, company: companyLabel(order.empresa), responsible: order.responsavel }];
    })).values()]
    .sort((a, b) => `${a.company} ${a.responsible}`.localeCompare(`${b.company} ${b.responsible}`, 'pt-BR'));
  const responsibleRows: unknown[][] = [['EMPRESA', 'RESPONSÁVEL', 'ORDENS', 'EXECUTADAS', 'IMPEDIMENTOS', 'PENDENTES', '% EXECUÇÃO', 'QTD. AJUSTADA', 'QTD EXECUTADA', 'QTD CONSIDERADA']];
  responsibleGroups.forEach(({ company, responsible }) => responsibleRows.push([company, responsible, '', '', '', '', '', '', '', '']));
  const byResponsible = formulaSheet(XLSX, responsibleRows, [25, 28, 13, 14, 16, 13, 15, 17, 17, 19]);
  const companyColumn = columns.findIndex((header) => normalizeHeader(header) === 'EMPRESA');
  const responsibleColumn = columns.findIndex((header) => normalizeHeader(header) === 'RESPONSAVEL');
  responsibleGroups.forEach(({ companyKey, responsible }, index) => {
    const rowNumber = index + 2;
    const groupRange = (column: number) => `ACOMPANHAMENTO!$${columnName(column)}$2:$${columnName(column)}$${lastRow}`;
    const companyRange = groupRange(companyColumn);
    const responsibleRange = groupRange(responsibleColumn);
    const responsibleCriteria = `$B${rowNumber}`;
    const groupOrders = orders.filter((order) => canonicalCompany(order.empresa || 'Sem empresa') === companyKey && normalizeHeader(order.responsavel) === normalizeHeader(responsible));
    const sourceCompanies = [...new Map(groupOrders.map((order) => {
      const company = order.empresa || 'Sem empresa';
      return [normalizeHeader(company), company];
    })).values()];
    const companyCriteriaTerms = sourceCompanies.map((value) => `"${value.replace(/"/g, '""')}"`);
    const countFormula = (status?: OrderStatus) => companyCriteriaTerms.map((companyValue) =>
      `COUNTIFS(${companyRange},${companyValue},${responsibleRange},${responsibleCriteria}${status ? `,${status === 'impedimento' ? registrationStatusRange : statusRange},"${statusLabel(status)}"` : ''})`,
    ).join('+');
    const sumFormula = (sumRange: string) => companyCriteriaTerms.map((companyValue) =>
      `SUMIFS(${sumRange},${companyRange},${companyValue},${responsibleRange},${responsibleCriteria})`,
    ).join('+');
    const countStatus = (status: OrderStatus) => groupOrders.filter((order) => status === 'impedimento'
      ? latestRegistrationStatus(order) === status
      : order.status === status).length;
    const groupPlanned = groupOrders.reduce((sum, order) => sum + (numericQuantity(order.qtdAjustada) ?? 0), 0);
    const groupReported = groupOrders.reduce((sum, order) => sum + (order.qtdExecutada ?? 0), 0);
    const groupConsidered = groupOrders.reduce((sum, order) => sum + (order.status === 'executada' ? order.qtdExecutada ?? 0 : 0), 0);
    formulaCell(byResponsible, `C${rowNumber}`, countFormula(), groupOrders.length);
    formulaCell(byResponsible, `D${rowNumber}`, countFormula('executada'), countStatus('executada'));
    formulaCell(byResponsible, `E${rowNumber}`, countFormula('impedimento'), countStatus('impedimento'));
    formulaCell(byResponsible, `F${rowNumber}`, countFormula('pendente'), countStatus('pendente'));
    formulaCell(byResponsible, `G${rowNumber}`, `IF(C${rowNumber}=0,0,D${rowNumber}/C${rowNumber})`, groupOrders.length ? countStatus('executada') / groupOrders.length : 0, '0%');
    formulaCell(byResponsible, `H${rowNumber}`, sumFormula(adjustedRange), groupPlanned, '0.##');
    formulaCell(byResponsible, `I${rowNumber}`, sumFormula(executedRange), groupReported, '0.##');
    formulaCell(byResponsible, `J${rowNumber}`, sumFormula(consideredRange), groupConsidered, '0.##');
  });
  setFilter(byResponsible, responsibleRows.length, responsibleRows[0].length);
  XLSX.utils.book_append_sheet(workbook, byResponsible, 'POR RESPONSÁVEL');

  XLSX.writeFile(workbook, fileName);
}
