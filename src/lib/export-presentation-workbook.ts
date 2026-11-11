import type { CellStyle, WorkSheet } from 'xlsx-js-style';
import type { Order } from '../types';
import { parseNumericQuantity } from './quantity.js';

interface Group {
  label: string;
  planned: number;
  completed: number;
}

export interface PresentationWorkbookData {
  company: string;
  responsible: string;
  operatorName: string;
  planned: number;
  completed: number;
  completedOrders: number;
  fronts: Group[];
  advances: Group[];
  utds: Group[];
  selectedFront: string;
  orders: Array<{ order: Order; front: string; utd: string }>;
}

const navy = '003C5B';
const ink = '183746';
const green = '087344';
const bluePale = 'EAF4F8';
const rowPale = 'F7FAFB';
const white = 'FFFFFF';
const border = { color: { rgb: 'D5E3E8' }, style: 'thin' as const };
const titleStyle: CellStyle = { font: { name: 'Aptos', sz: 18, bold: true, color: { rgb: white } }, fill: { fgColor: { rgb: navy } }, alignment: { vertical: 'center' } };
const sectionStyle: CellStyle = { font: { name: 'Aptos', sz: 12, bold: true, color: { rgb: navy } }, fill: { fgColor: { rgb: bluePale } }, alignment: { vertical: 'center' } };
const headerStyle: CellStyle = { font: { name: 'Aptos', sz: 10, bold: true, color: { rgb: white } }, fill: { fgColor: { rgb: navy } }, alignment: { vertical: 'center', wrapText: true }, border: { bottom: border } };
const bodyStyle: CellStyle = { font: { name: 'Aptos', sz: 10, color: { rgb: ink } }, alignment: { vertical: 'center', wrapText: true }, border: { bottom: border } };
const alternateStyle: CellStyle = { ...bodyStyle, fill: { fgColor: { rgb: rowPale } } };
const numericStyle: CellStyle = { ...bodyStyle, alignment: { horizontal: 'right', vertical: 'center' } };
const noteStyle: CellStyle = { font: { name: 'Aptos', sz: 10, color: { rgb: '526E7A' } }, alignment: { vertical: 'center', wrapText: true } };

function cellAddress(column: number, row: number): string {
  return String.fromCharCode(65 + column) + row;
}

function styleRow(sheet: WorkSheet, row: number, first: number, last: number, style: CellStyle): void {
  for (let column = first; column <= last; column += 1) {
    const address = cellAddress(column, row);
    const cell = sheet[address] || { t: 's', v: '' };
    cell.s = style;
    sheet[address] = cell;
  }
}

function ratio(completed: number, planned: number): number {
  return planned > 0 ? completed / planned : 0;
}

function slug(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'carteira';
}

function status(order: Order): string {
  return order.status === 'executada' ? 'Executada' : 'Pendente';
}

function lastRegistration(order: Order): string {
  const last = order.situacaoRegistro || (order.status === 'impedimento' ? 'impedimento' : order.status === 'executada' ? 'executada' : undefined);
  return last === 'impedimento' ? 'Impedimento' : last === 'executada' ? 'Execução' : 'Sem registro';
}

export async function exportPresentationWorkbook(data: PresentationWorkbookData): Promise<void> {
  const XLSX = await import('xlsx-js-style');
  const workbook = XLSX.utils.book_new();
  const generatedAt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date());
  const presentationRows: Array<Array<string | number>> = [
    ['APRESENTAÇÃO · CONTROLE DA EXECUÇÃO'],
    [`${data.company} · ${data.responsible}`],
    [`Gerado em ${generatedAt} · ${data.operatorName}`],
    [],
    ['RESUMO DA CARTEIRA'],
    ['Quantidade ajustada', 'Concluída', 'Pendente', '% do mês', 'Ordens'],
    [data.planned, data.completed, Math.max(0, data.planned - data.completed), ratio(data.completed, data.planned), data.orders.length],
    [],
  ];
  const sectionRows = [5];
  const headerRows = [6];
  const metricRows = [7];
  const percentCells = ['D7'];

  function appendGroups(title: string, groups: Group[]): void {
    sectionRows.push(presentationRows.push([title]));
    headerRows.push(presentationRows.push(['Categoria / UTD', 'Carteira', 'Concluída', 'Pendente', '% do mês']));
    if (groups.length === 0) presentationRows.push(['Sem dados nesta seleção']);
    else groups.forEach((group) => {
      const row = presentationRows.push([
        group.label,
        group.planned,
        group.completed,
        Math.max(0, group.planned - group.completed),
        ratio(group.completed, group.planned),
      ]);
      metricRows.push(row);
      percentCells.push(`E${row}`);
    });
    presentationRows.push([]);
  }

  appendGroups('FRENTES DE SERVIÇO · QTD. AJUSTADA', data.fronts);
  appendGroups('DEFEITOS POR AVANÇO · QTD. AJUSTADA', data.advances);
  appendGroups(`VISÃO POR UTD · ${data.selectedFront.toUpperCase()}`, data.utds);

  sectionRows.push(presentationRows.push(['ADERÊNCIA DA CARTEIRA · NÚMERO DE ORDENS']));
  headerRows.push(presentationRows.push(['Ordens na carteira', 'Executadas', 'Pendentes', 'Aderência']));
  const adherenceRow = presentationRows.push([
    data.orders.length,
    data.completedOrders,
    data.orders.length - data.completedOrders,
    ratio(data.completedOrders, data.orders.length),
  ]);
  metricRows.push(adherenceRow);
  percentCells.push(`D${adherenceRow}`);
  presentationRows.push([]);
  const noteRow = presentationRows.push(['Concluída usa QTD. AJUSTADA das ordens executadas. A quantidade realmente realizada consta em ORDENS e no protocolo. Impedimentos continuam pendentes.']);

  const presentation = XLSX.utils.aoa_to_sheet(presentationRows);
  presentation['!cols'] = [{ wch: 39 }, { wch: 19 }, { wch: 19 }, { wch: 19 }, { wch: 18 }];
  presentation['!rows'] = presentationRows.map((_, index) => ({ hpt: index === 0 ? 32 : sectionRows.includes(index + 1) ? 25 : headerRows.includes(index + 1) ? 30 : index + 1 === noteRow ? 37 : 21 }));
  presentation['!merges'] = [1, 2, 3, noteRow, ...sectionRows].map((row) => ({ s: { r: row - 1, c: 0 }, e: { r: row - 1, c: 4 } }));
  styleRow(presentation, 1, 0, 4, titleStyle);
  for (const row of [2, 3, noteRow]) styleRow(presentation, row, 0, 4, noteStyle);
  for (const row of sectionRows) styleRow(presentation, row, 0, 4, sectionStyle);
  for (const row of headerRows) styleRow(presentation, row, 0, 4, headerStyle);
  for (const row of metricRows) {
    styleRow(presentation, row, 0, 4, row % 2 ? bodyStyle : alternateStyle);
    for (let column = 1; column <= 4; column += 1) {
      const cell = presentation[cellAddress(column, row)];
      if (cell) cell.s = { ...numericStyle, ...(row % 2 === 0 ? { fill: { fgColor: { rgb: rowPale } } } : {}) };
    }
  }
  for (const address of percentCells) {
    const cell = presentation[address];
    if (cell) cell.z = '0%';
  }
  XLSX.utils.book_append_sheet(workbook, presentation, 'APRESENTAÇÃO');

  const columns = ['OS', 'UTD', 'EMPRESA', 'RESPONSÁVEL', 'EQUIPE', 'FRENTE', 'SERVIÇO', 'AVANÇO', 'ALIMENTADOR', 'BARRAMENTO', 'QTD. AJUSTADA', 'QTD. REALIZADA', 'SITUAÇÃO', 'ÚLTIMO REGISTRO', 'MOTIVO DO IMPEDIMENTO', 'OBSERVAÇÃO', 'PROTOCOLO', 'REGISTRADO POR', 'DATA DO REGISTRO'];
  const orderRows: Array<Array<string | number>> = [
    ['ORDENS DA CARTEIRA'],
    [`${data.company} · ${data.responsible}`],
    [`Gerado em ${generatedAt} · ${data.orders.length} ordens`],
    columns,
    ...data.orders.map(({ order, front, utd }) => [
      order.numConsequencia, utd, order.empresa, order.responsavel, order.equipe, front,
      order.servico, order.avanco, order.alimentador, order.barramento,
      parseNumericQuantity(order.qtdAjustada) ?? order.qtdAjustada,
      order.qtdExecutada ?? '', status(order), lastRegistration(order),
      order.motivoImpedimento ?? '', order.observacao ?? '', order.protocolo ?? '',
      order.registradoPor ?? '', order.dataRegistro ? new Date(order.dataRegistro).toLocaleString('pt-BR') : '',
    ]),
  ];
  const orders = XLSX.utils.aoa_to_sheet(orderRows);
  orders['!cols'] = [22, 19, 16, 24, 20, 20, 28, 23, 19, 19, 18, 18, 16, 21, 30, 42, 28, 24, 21].map((wch) => ({ wch }));
  orders['!rows'] = orderRows.map((_, index) => ({ hpt: index === 0 ? 32 : index === 3 ? 32 : 22 }));
  orders['!merges'] = [1, 2, 3].map((row) => ({ s: { r: row - 1, c: 0 }, e: { r: row - 1, c: columns.length - 1 } }));
  orders['!autofilter'] = { ref: `A4:S${Math.max(orderRows.length, 4)}` };
  styleRow(orders, 1, 0, columns.length - 1, titleStyle);
  for (const row of [2, 3]) styleRow(orders, row, 0, columns.length - 1, noteStyle);
  styleRow(orders, 4, 0, columns.length - 1, headerStyle);
  for (let row = 5; row <= orderRows.length; row += 1) {
    styleRow(orders, row, 0, columns.length - 1, row % 2 ? bodyStyle : alternateStyle);
    const statusCell = orders[`M${row}`];
    if (statusCell) statusCell.s = { ...bodyStyle, font: { name: 'Aptos', sz: 10, bold: true, color: { rgb: statusCell.v === 'Executada' ? green : navy } }, fill: { fgColor: { rgb: statusCell.v === 'Executada' ? 'E8F7ED' : bluePale } } };
  }
  XLSX.utils.book_append_sheet(workbook, orders, 'ORDENS');
  XLSX.writeFile(workbook, `apresentacao-${slug(data.responsible)}-${new Date().toISOString().slice(0, 10)}.xlsx`, { bookType: 'xlsx', cellStyles: true });
}
