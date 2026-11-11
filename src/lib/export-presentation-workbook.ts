import { unzipSync, zipSync } from 'fflate';
import type { Order } from '../types';
import {
  adjustedQuantity, expectedToDate, monthPercent, mtdPercent, normalizePresentationLabel,
  presentationFront, presentationUtd,
} from './presentation-data.js';
import type { PresentationPeriod } from './presentation-data.js';

export interface PresentationWorkbookData {
  company: string;
  responsible: string;
  operatorName: string;
  orders: Order[];
  period: PresentationPeriod;
}

const xmlNamespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const headers = [
  'UTD', 'ALIMENTADOR', 'CHAVE_DIRECIONADORA', 'BARRAMENTO', 'QTD. AJUSTADA',
  'NUM_CONSEQUENCIA', 'TIPO_DOCUMENTO', 'INF', 'STATUS', 'TIPO DE PRIORIZAÇÃO',
  'MÊS PROGRAMADO', 'EMPRESA', 'EQUIPE', 'SERVIÇO', 'AVANÇO', 'EQM',
  'RESPONSÁVEL', 'INF IMPORTANTE', 'CHAVE A SER DESLIGADA', 'DEF. DIA', 'SAT',
];

function excelDate(year: number, month: number, day: number): number {
  return Math.round((Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

function safeXml(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function slug(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'carteira';
}

function sheetCell(document: XMLDocument, address: string): Element {
  const all = document.getElementsByTagNameNS(xmlNamespace, 'c');
  for (let index = 0; index < all.length; index += 1) {
    if (all[index].getAttribute('r') === address) return all[index];
  }
  const rowNumber = Number(address.match(/\d+$/)?.[0]);
  const rows = document.getElementsByTagNameNS(xmlNamespace, 'row');
  for (let index = 0; index < rows.length; index += 1) {
    if (Number(rows[index].getAttribute('r')) !== rowNumber) continue;
    const cell = document.createElementNS(xmlNamespace, 'c');
    cell.setAttribute('r', address);
    const target = address.match(/^[A-Z]+/)?.[0] || '';
    const siblings = rows[index].getElementsByTagNameNS(xmlNamespace, 'c');
    for (let sibling = 0; sibling < siblings.length; sibling += 1) {
      const column = siblings[sibling].getAttribute('r')?.match(/^[A-Z]+/)?.[0] || '';
      if (column.length > target.length || (column.length === target.length && column > target)) {
        rows[index].insertBefore(cell, siblings[sibling]);
        return cell;
      }
    }
    rows[index].appendChild(cell);
    return cell;
  }
  throw new Error(`Célula do modelo não encontrada: ${address}`);
}

function setNumber(document: XMLDocument, address: string, value: number, formula?: string): void {
  const cell = sheetCell(document, address);
  while (cell.firstChild) cell.removeChild(cell.firstChild);
  cell.setAttribute('t', 'n');
  if (formula) {
    const element = document.createElementNS(xmlNamespace, 'f');
    element.textContent = formula;
    cell.appendChild(element);
  }
  const result = document.createElementNS(xmlNamespace, 'v');
  result.textContent = String(value);
  cell.appendChild(result);
}

function setText(document: XMLDocument, address: string, value: string): void {
  const cell = sheetCell(document, address);
  while (cell.firstChild) cell.removeChild(cell.firstChild);
  cell.setAttribute('t', 'inlineStr');
  const inline = document.createElementNS(xmlNamespace, 'is');
  const text = document.createElementNS(xmlNamespace, 't');
  text.textContent = value;
  inline.appendChild(text);
  cell.appendChild(inline);
}

function setRatio(document: XMLDocument, address: string, value: number | undefined, formula: string): void {
  const cell = sheetCell(document, address);
  while (cell.firstChild) cell.removeChild(cell.firstChild);
  cell.setAttribute('t', value === undefined ? 'str' : 'n');
  const element = document.createElementNS(xmlNamespace, 'f');
  element.textContent = formula;
  cell.appendChild(element);
  const result = document.createElementNS(xmlNamespace, 'v');
  result.textContent = value === undefined ? '' : String(value);
  cell.appendChild(result);
}

function metric(orders: Order[]): { planned: number; completed: number } {
  return orders.reduce((total, order) => {
    const quantity = adjustedQuantity(order);
    total.planned += quantity;
    if (order.status === 'executada') total.completed += quantity;
    return total;
  }, { planned: 0, completed: 0 });
}

function utdMatches(value: string, label: string): boolean {
  const normalized = normalizePresentationLabel(value).replace(/^lv\s+/, '');
  const expected = normalizePresentationLabel(label);
  return normalized === expected || normalized.startsWith(`${expected} `);
}

function presentationSheet(xml: string, orders: Order[], period: PresentationPeriod): string {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.getElementsByTagName('parsererror').length) throw new Error('Modelo da apresentação inválido.');
  const lastDay = new Date(Date.UTC(period.year, period.month, 0)).getUTCDate();
  setNumber(document, 'Q2', excelDate(period.year, period.month, 1));
  setNumber(document, 'R2', excelDate(period.year, period.month, lastDay));
  setNumber(document, 'Q3', period.businessDays, 'NETWORKDAYS.INTL(Q2,R2,1)');
  setNumber(document, 'Q4', period.workedDays, 'IF(TODAY()<Q2,0,MAX(0,NETWORKDAYS.INTL(Q2,MIN(TODAY(),R2),1)-1))');

  function fill(row: number, planned: number, completed: number): void {
    const daily = period.businessDays > 0 ? planned / period.businessDays : 0;
    setNumber(document, `C${row}`, planned);
    setNumber(document, `D${row}`, completed);
    setNumber(document, `K${row}`, daily, `IFERROR(C${row}/$Q$3,0)`);
    setNumber(document, `L${row}`, expectedToDate(planned, period), `K${row}*$Q$4`);
    setRatio(document, `E${row}`, mtdPercent(planned, completed, period), `IF(L${row}=0,"",D${row}/L${row})`);
    setRatio(document, `F${row}`, monthPercent(planned, completed), `IF(C${row}=0,"",D${row}/C${row})`);
  }

  const sections: Array<{ front: string; rows: Array<[number, string]> }> = [
    { front: 'Poda LM', rows: [[3, 'AFOGADOS'], [4, 'ARCOVERDE'], [5, 'BOM CONSELHO'], [6, 'FLORESTA'], [7, 'GARANHUNS']] },
    { front: 'Roço manual', rows: [[11, 'AFOGADOS'], [12, 'ARCOVERDE'], [13, 'BOM CONSELHO'], [14, 'FLORESTA'], [15, 'GARANHUNS']] },
    { front: 'Bobcat', rows: [[19, 'AFOGADOS'], [20, 'ARCOVERDE'], [21, 'BOM CONSELHO'], [22, 'FLORESTA'], [23, 'GARANHUNS']] },
    { front: 'Linha viva', rows: [[26, 'ARCOVERDE'], [27, 'GARANHUNS']] },
    { front: 'Estrutural próprio', rows: [[30, 'ARCOVERDE'], [31, 'GARANHUNS'], [32, 'FLORESTA']] },
  ];
  for (const section of sections) {
    const sectionOrders = orders.filter((order) => presentationFront(order) === section.front);
    const matched = section.rows.map(([row, utd]) => ({
      row,
      orders: sectionOrders.filter((order) => utdMatches(presentationUtd(order), utd)),
    }));
    const extras = sectionOrders.filter((order) => !section.rows.some(([, utd]) => utdMatches(presentationUtd(order), utd)));
    if (extras.length) {
      const target = matched.find((group) => group.orders.length === 0) || matched[matched.length - 1];
      const labels = [...new Set(extras.map((order) => presentationUtd(order)))];
      setText(document, `B${target.row}`, target.orders.length === 0 && labels.length === 1 ? labels[0].toUpperCase() : 'DEMAIS UTDs');
      target.orders.push(...extras);
    }
    for (const group of matched) {
      const values = metric(group.orders);
      fill(group.row, values.planned, values.completed);
    }
  }
  const progressRows: Array<[number, string]> = [
    [36, 'ESTRUTURAIS'], [37, 'PONTO QUENTE / CONEXÃO'], [38, 'PARA-RAIO'],
    [39, 'VEGETAÇÃO LM'], [40, 'VEGETAÇÃO LV'], [41, 'VEGETAÇÃO DENSA'],
    [42, 'PARA-RAIOS'], [43, 'ESPAÇADOR'], [44, 'CLIENTE'], [45, 'INSPEÇÃO'],
  ];
  const matchedProgress = progressRows.map(([row, progress]) => ({
    row,
    orders: orders.filter((order) => normalizePresentationLabel(order.avanco) === normalizePresentationLabel(progress)),
  }));
  const extraProgress = orders.filter((order) => !progressRows.some(([, progress]) => normalizePresentationLabel(order.avanco) === normalizePresentationLabel(progress)));
  if (extraProgress.length) {
    const target = [...matchedProgress].reverse().find((group) => group.orders.length === 0) || matchedProgress[matchedProgress.length - 1];
    setText(document, `B${target.row}`, 'OUTROS AVANÇOS');
    target.orders.push(...extraProgress);
  }
  for (const group of matchedProgress) {
    const values = metric(group.orders);
    fill(group.row, values.planned, values.completed);
  }
  fill(46, orders.length, orders.filter((order) => order.status === 'executada').length);
  return new XMLSerializer().serializeToString(document);
}

function originalValue(order: Order, header: string, period: PresentationPeriod): string | number {
  const source = Object.entries(order.original || {}).find(([name]) => normalizePresentationLabel(name) === normalizePresentationLabel(header))?.[1] || '';
  switch (header) {
    case 'UTD': return presentationUtd(order);
    case 'ALIMENTADOR': return order.alimentador;
    case 'BARRAMENTO': return order.barramento;
    case 'QTD. AJUSTADA': return adjustedQuantity(order);
    case 'NUM_CONSEQUENCIA': return order.numConsequencia;
    case 'STATUS': return order.status === 'executada' ? 'EXEC' : 'PEND';
    case 'MÊS PROGRAMADO': return source || period.label.split(' ')[0].toUpperCase();
    case 'EMPRESA': return order.empresa;
    case 'EQUIPE': return order.equipe;
    case 'SERVIÇO': return order.servico;
    case 'AVANÇO': return order.avanco;
    case 'RESPONSÁVEL': return order.responsavel;
    default: return source;
  }
}

function orderSheet(xml: string, orders: Order[], period: PresentationPeriod): string {
  const header = xml.match(/<row r="1"[^>]*>[\s\S]*?<\/row>/)?.[0];
  if (!header || !/<sheetData>/.test(xml)) throw new Error('Modelo de ordens inválido.');
  const rows = orders.map((order, index) => {
    const rowNumber = index + 2;
    const cells = headers.map((headerName, column) => {
      const address = `${String.fromCharCode(65 + column)}${rowNumber}`;
      const value = originalValue(order, headerName, period);
      if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${address}" s="54" t="n"><v>${value}</v></c>`;
      if (!value) return `<c r="${address}" s="54" t="n"/>`;
      return `<c r="${address}" s="54" t="inlineStr"><is><t xml:space="preserve">${safeXml(String(value))}</t></is></c>`;
    }).join('');
    return `<row r="${rowNumber}" customFormat="1" s="63">${cells}</row>`;
  });
  const endRow = orders.length + 1;
  return xml.replace(/<sheetData>[\s\S]*?<\/sheetData>/, `<sheetData>${header}${rows.join('')}</sheetData>`)
    .replace(/<dimension ref="[^"]+"/, `<dimension ref="A1:U${endRow}"`)
    .replace(/<autoFilter ref="[^"]+"/, `<autoFilter ref="A1:U${endRow}"`);
}

export async function exportPresentationWorkbook(data: PresentationWorkbookData): Promise<void> {
  const response = await fetch('/modelo-apresentacao.xlsx');
  if (!response.ok) throw new Error('Modelo da apresentação indisponível.');
  const template = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const presentationPath = 'xl/worksheets/sheet1.xml';
  const ordersPath = 'xl/worksheets/sheet2.xml';
  if (!template[presentationPath] || !template[ordersPath]) throw new Error('Modelo da apresentação incompleto.');
  template[presentationPath] = encoder.encode(presentationSheet(decoder.decode(template[presentationPath]), data.orders, data.period));
  template[ordersPath] = encoder.encode(orderSheet(decoder.decode(template[ordersPath]), data.orders, data.period));
  const file = new Blob([zipSync(template, { level: 6 }) as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = `apresentacao-${slug(data.responsible)}-${data.period.year}-${String(data.period.month).padStart(2, '0')}.xlsx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
