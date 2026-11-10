import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';

export interface PresentationPdfGroup {
  label: string;
  planned: number;
  completed: number;
}

export interface PresentationPdfData {
  company: string;
  responsible: string;
  operatorName: string;
  planned: number;
  completed: number;
  orderCount: number;
  completedOrders: number;
  fronts: PresentationPdfGroup[];
  advances: PresentationPdfGroup[];
  utds: PresentationPdfGroup[];
  selectedFront: string;
}

const pageWidth = 595.28;
const pageHeight = 841.89;
const margin = 42;
const contentWidth = pageWidth - margin * 2;
const navy = rgb(0, 0.235, 0.357);
const green = rgb(0, 0.659, 0.349);
const muted = rgb(0.37, 0.47, 0.51);
const pale = rgb(0.96, 0.98, 0.98);
const pending = rgb(0.77, 0.85, 0.86);
const line = rgb(0.84, 0.9, 0.91);
const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });

function safeText(value: string, font: PDFFont): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  try {
    font.encodeText(text);
    return text;
  } catch {
    return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '?');
  }
}

function fitText(value: string, font: PDFFont, size: number, width: number): string {
  let text = safeText(value, font);
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  while (text.length > 1 && font.widthOfTextAtSize(text + '...', size) > width) text = text.slice(0, -1);
  return text.trimEnd() + '...';
}

function fileSlug(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'equipe';
}

export async function exportPresentationPdf(data: PresentationPdfData): Promise<void> {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Apresentação da carteira da equipe');
  pdf.setAuthor('Controle de Execução de Ordens');
  pdf.setSubject('Quantidade ajustada e aderência da carteira atual');
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const date = new Date();
  const generatedAt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
  let page: PDFPage;
  let y = pageHeight - 82;

  const addPage = () => {
    page = pdf.addPage([pageWidth, pageHeight]);
    page.drawCircle({ x: margin + 5, y: pageHeight - 39, size: 5, color: green });
    page.drawText('CONTROLE DE EXECUÇÃO', { x: margin + 17, y: pageHeight - 43, size: 11, font: bold, color: navy });
    page.drawLine({ start: { x: margin, y: pageHeight - 54 }, end: { x: pageWidth - margin, y: pageHeight - 54 }, thickness: 0.8, color: line });
    y = pageHeight - 82;
  };
  const ensureSpace = (height: number) => { if (y - height < 72) addPage(); };
  const text = (value: string, x: number, baseline: number, size = 10, font: PDFFont = regular, color = navy, maxWidth = contentWidth) => {
    page.drawText(fitText(value, font, size, maxWidth), { x, y: baseline, size, font, color });
  };
  const section = (title: string, subtitle: string, followingHeight = 44) => {
    ensureSpace(38 + followingHeight);
    text(title, margin, y, 13, bold);
    y -= 17;
    text(subtitle, margin, y, 9, regular, muted);
    y -= 21;
  };
  const cards = (items: Array<{ label: string; value: string }>) => {
    ensureSpace(83);
    const gap = 9;
    const width = (contentWidth - gap * (items.length - 1)) / items.length;
    items.forEach((item, index) => {
      const x = margin + index * (width + gap);
      page.drawRectangle({ x, y: y - 63, width, height: 70, color: pale, borderColor: line, borderWidth: 0.7 });
      text(item.label, x + 10, y - 9, 8.5, regular, muted, width - 20);
      text(item.value, x + 10, y - 36, 19, bold, navy, width - 20);
    });
    y -= 85;
  };
  const groups = (items: PresentationPdfGroup[]) => {
    if (items.length === 0) {
      text('Nenhum dado nesta seleção.', margin, y, 10, regular, muted);
      y -= 29;
      return;
    }
    const scale = Math.max(1, ...items.map((item) => item.planned));
    for (const item of items) {
      ensureSpace(44);
      const value = `${number.format(item.completed)} / ${number.format(item.planned)}`;
      const valueWidth = bold.widthOfTextAtSize(value, 9);
      text(item.label, margin, y, 9, regular, navy, contentWidth - valueWidth - 14);
      text(value, pageWidth - margin - valueWidth, y, 9, bold);
      const barY = y - 15;
      page.drawRectangle({ x: margin, y: barY, width: contentWidth, height: 7, color: pale });
      if (item.planned > 0) {
        const plannedWidth = contentWidth * item.planned / scale;
        const completedWidth = plannedWidth * Math.min(1, Math.max(0, item.completed / item.planned));
        page.drawRectangle({ x: margin, y: barY, width: plannedWidth, height: 7, color: pending });
        if (completedWidth > 0) page.drawRectangle({ x: margin, y: barY, width: completedWidth, height: 7, color: green });
      }
      y -= 34;
    }
    y -= 9;
  };

  addPage();
  text('Apresentação da equipe', margin, y, 20, bold);
  y -= 24;
  text(`${data.company} · ${data.responsible}`, margin, y, 11, bold);
  y -= 17;
  text(`Acesso: ${data.operatorName}  |  Gerado em: ${generatedAt}`, margin, y, 9, regular, muted);
  y -= 31;

  cards([
    { label: 'Quantidade ajustada', value: number.format(data.planned) },
    { label: 'Concluída', value: number.format(data.completed) },
    { label: 'Pendente', value: number.format(Math.max(0, data.planned - data.completed)) },
  ]);
  section('Frentes de serviço', 'Quantidade ajustada concluída / carteira');
  groups(data.fronts);
  section('Defeitos por avanço', 'Quantidade ajustada concluída / carteira');
  groups(data.advances);
  section(`Visão por UTD · ${data.selectedFront}`, 'Quantidade ajustada concluída / carteira');
  groups(data.utds);
  section('Aderência da carteira', 'Nesta seção, a medida é o número de ordens.', 83);
  cards([
    { label: 'Ordens na carteira', value: number.format(data.orderCount) },
    { label: 'Executadas', value: number.format(data.completedOrders) },
    { label: 'Aderência', value: data.orderCount ? `${Math.round(data.completedOrders / data.orderCount * 100)}%` : '0%' },
  ]);
  ensureSpace(44);
  text('Os gráficos usam QTD. AJUSTADA das ordens; o valor realmente realizado fica no protocolo.', margin, y, 8.5, regular, muted);

  pdf.getPages().forEach((currentPage, index) => {
    currentPage.drawLine({ start: { x: margin, y: 54 }, end: { x: pageWidth - margin, y: 54 }, thickness: 0.8, color: line });
    currentPage.drawText(`Carteira atual · ${generatedAt}`, { x: margin, y: 39, size: 8, font: regular, color: muted });
    const pagination = `${index + 1} / ${pdf.getPageCount()}`;
    currentPage.drawText(pagination, { x: pageWidth - margin - regular.widthOfTextAtSize(pagination, 8), y: 39, size: 8, font: regular, color: muted });
  });

  const bytes = await pdf.save();
  const blob = new Blob([new Uint8Array(bytes).buffer as ArrayBuffer], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `apresentacao-${fileSlug(data.responsible)}-${date.toISOString().slice(0, 10)}.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
