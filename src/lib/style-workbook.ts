import { unzipSync, zipSync } from 'fflate';

const mainNamespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function parseXml(xml: string, description: string): XMLDocument {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.getElementsByTagName('parsererror').length) throw new Error(`Não foi possível ler ${description}.`);
  return document;
}

function child(parent: Element, localName: string): Element | undefined {
  return Array.from(parent.children).find((element) => element.localName === localName);
}

function elements(parent: Element): Element[] {
  return Array.from(parent.children);
}

function updateCount(element: Element): void {
  element.setAttribute('count', String(element.children.length));
}

function ensureSection(document: XMLDocument, localName: string, before: string): Element {
  const root = document.documentElement;
  const found = child(root, localName);
  if (found) return found;
  const section = document.createElementNS(mainNamespace, localName);
  const next = child(root, before);
  if (next) root.insertBefore(section, next);
  else root.appendChild(section);
  return section;
}

function columnIndex(address: string): number {
  const letters = address.match(/^[A-Z]+/i)?.[0].toUpperCase() || 'A';
  return [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function readHeaderStyles(sheetXml: string): number[] {
  const document = parseXml(sheetXml, 'o cabeçalho do modelo');
  const row = Array.from(document.getElementsByTagNameNS(mainNamespace, 'row'))
    .find((element) => element.getAttribute('r') === '1');
  if (!row) throw new Error('O cabeçalho da planilha modelo não foi encontrado.');
  const styles: number[] = [];
  for (const cell of Array.from(row.getElementsByTagNameNS(mainNamespace, 'c'))) {
    const address = cell.getAttribute('r') || '';
    styles[columnIndex(address)] = Number(cell.getAttribute('s') || 0);
  }
  if (!styles.length) throw new Error('O cabeçalho do modelo não tem estilos.');
  let last = styles[0] || 0;
  return Array.from({ length: styles.length }, (_, index) => {
    if (styles[index] !== undefined) last = styles[index];
    return last;
  });
}

function readCellStyle(sheetXml: string, address: string): number {
  const document = parseXml(sheetXml, 'um estilo do modelo');
  const cell = Array.from(document.getElementsByTagNameNS(mainNamespace, 'c'))
    .find((element) => element.getAttribute('r') === address);
  if (!cell) throw new Error(`A célula ${address} não existe no modelo visual.`);
  return Number(cell.getAttribute('s') || 0);
}

function mergeTemplateStyles(outputXml: string, templateXml: string, templateStyleIds: number[]): {
  serialize: () => string;
  styleMap: Map<number, number>;
  rowStyle: number;
  bodyStyle: number;
  bodyStyleForFormat: (formatId: number) => number;
} {
  const output = parseXml(outputXml, 'os estilos da exportação');
  const template = parseXml(templateXml, 'os estilos do modelo');
  const outputRoot = output.documentElement;
  const templateRoot = template.documentElement;
  const outputXfs = child(outputRoot, 'cellXfs');
  const templateXfs = child(templateRoot, 'cellXfs');
  if (!outputXfs || !templateXfs) throw new Error('Os estilos de célula do arquivo não foram encontrados.');

  const outputNumFmts = ensureSection(output, 'numFmts', 'fonts');
  const templateNumFmts = child(templateRoot, 'numFmts');
  const formatMap = new Map<number, number>();
  const outputFormats = elements(outputNumFmts);
  const nextFormatId = () => Math.max(163, ...outputFormats.map((format) => Number(format.getAttribute('numFmtId') || 0))) + 1;
  for (const format of templateNumFmts ? elements(templateNumFmts) : []) {
    const sourceId = Number(format.getAttribute('numFmtId') || 0);
    if (sourceId < 164) {
      formatMap.set(sourceId, sourceId);
      continue;
    }
    const code = format.getAttribute('formatCode') || '';
    const existing = outputFormats.find((candidate) => candidate.getAttribute('formatCode') === code);
    if (existing) formatMap.set(sourceId, Number(existing.getAttribute('numFmtId')));
    else {
      const clone = output.importNode(format, true) as Element;
      const destinationId = nextFormatId();
      clone.setAttribute('numFmtId', String(destinationId));
      outputNumFmts.appendChild(clone);
      outputFormats.push(clone);
      formatMap.set(sourceId, destinationId);
    }
  }
  updateCount(outputNumFmts);

  const componentMaps = new Map<string, Map<number, number>>();
  for (const sectionName of ['fonts', 'fills', 'borders']) {
    const destination = child(outputRoot, sectionName);
    const source = child(templateRoot, sectionName);
    if (!destination || !source) throw new Error(`O modelo está sem a seção ${sectionName}.`);
    const map = new Map<number, number>();
    for (const [index, item] of elements(source).entries()) {
      const destinationIndex = destination.children.length;
      destination.appendChild(output.importNode(item, true));
      map.set(index, destinationIndex);
    }
    updateCount(destination);
    componentMaps.set(sectionName, map);
  }

  const styleMap = new Map<number, number>();
  const addTemplateStyle = (sourceStyleId: number, formatOverride?: number): number => {
    const key = formatOverride === undefined ? sourceStyleId : -((sourceStyleId + 1) * 100_000 + formatOverride);
    const existing = styleMap.get(key);
    if (existing !== undefined) return existing;
    const source = elements(templateXfs)[sourceStyleId];
    if (!source) throw new Error(`O estilo ${sourceStyleId} não existe no modelo.`);
    const clone = output.importNode(source, true) as Element;
    for (const [attribute, sectionName] of [['fontId', 'fonts'], ['fillId', 'fills'], ['borderId', 'borders']] as const) {
      const sourceId = Number(source.getAttribute(attribute) || 0);
      clone.setAttribute(attribute, String(componentMaps.get(sectionName)?.get(sourceId) ?? 0));
    }
    const sourceFormat = formatOverride ?? Number(source.getAttribute('numFmtId') || 0);
    clone.setAttribute('numFmtId', String(formatOverride === undefined ? formatMap.get(sourceFormat) ?? sourceFormat : sourceFormat));
    clone.setAttribute('xfId', '0');
    if (sourceFormat !== 0) clone.setAttribute('applyNumberFormat', '1');
    const newId = outputXfs.children.length;
    outputXfs.appendChild(clone);
    styleMap.set(key, newId);
    return newId;
  };

  for (const id of templateStyleIds) addTemplateStyle(id);
  updateCount(outputXfs);
  const bodyStyle = addTemplateStyle(54);
  const rowStyle = addTemplateStyle(63);
  const bodyFormats = new Map<number, number>([[0, bodyStyle]]);
  const bodyStyleForFormat = (formatId: number): number => {
    const existing = bodyFormats.get(formatId);
    if (existing !== undefined) return existing;
    const styled = addTemplateStyle(54, formatId);
    bodyFormats.set(formatId, styled);
    updateCount(outputXfs);
    return styled;
  };

  return { serialize: () => new XMLSerializer().serializeToString(output), styleMap, rowStyle, bodyStyle, bodyStyleForFormat };
}

function applySheetStyles(
  sheetXml: string,
  headerStyles: number[],
  merged: ReturnType<typeof mergeTemplateStyles>,
  originalFormatByStyle: number[],
  options: { master: boolean; presentationSummary: boolean; titleStyle: number },
): string {
  const document = parseXml(sheetXml, 'uma aba da exportação');
  const rows = Array.from(document.getElementsByTagNameNS(mainNamespace, 'row'));
  for (const row of rows) {
    const rowNumber = Number(row.getAttribute('r') || 0);
    const cells = Array.from(row.getElementsByTagNameNS(mainNamespace, 'c'));
    if (options.presentationSummary && rowNumber === 1) {
      const titleStyle = merged.styleMap.get(options.titleStyle) ?? merged.bodyStyle;
      for (const cell of cells) cell.setAttribute('s', String(titleStyle));
      continue;
    }
    const headerRowNumber = options.presentationSummary ? 2 : 1;
    if (rowNumber === headerRowNumber) {
      for (const cell of cells) {
        const index = columnIndex(cell.getAttribute('r') || 'A');
        const modelStyle = options.master
          ? headerStyles[Math.min(index, headerStyles.length - 1)]
          : headerStyles[0];
        cell.setAttribute('s', String(merged.styleMap.get(modelStyle) ?? merged.bodyStyle));
      }
      continue;
    }
    row.setAttribute('customFormat', '1');
    row.setAttribute('s', String(merged.rowStyle));
    for (const cell of cells) {
      const previousStyle = Number(cell.getAttribute('s') || 0);
      const formatId = originalFormatByStyle[previousStyle] || 0;
      cell.setAttribute('s', String(merged.bodyStyleForFormat(formatId)));
    }
  }
  return new XMLSerializer().serializeToString(document);
}

/** Reuses the original workbook's typography, colors and borders across every exported sheet. */
export function styleWorkbookLikeTemplate(workbookBytes: Uint8Array, templateBytes: Uint8Array): Uint8Array {
  const workbook = unzipSync(workbookBytes);
  const template = unzipSync(templateBytes);
  const stylesPath = 'xl/styles.xml';
  const modelOrdersPath = 'xl/worksheets/sheet2.xml';
  const modelPresentationPath = 'xl/worksheets/sheet1.xml';
  if (!workbook[stylesPath] || !template[stylesPath] || !template[modelOrdersPath] || !template[modelPresentationPath]) {
    throw new Error('Não foi possível aplicar o padrão visual do modelo à planilha.');
  }

  const outputStyles = parseXml(decoder.decode(workbook[stylesPath]), 'os estilos da exportação');
  const outputXfs = child(outputStyles.documentElement, 'cellXfs');
  if (!outputXfs) throw new Error('A exportação não contém estilos de célula.');
  const originalFormatByStyle = elements(outputXfs).map((xf) => Number(xf.getAttribute('numFmtId') || 0));
  const modelStyleXml = decoder.decode(template[stylesPath]);
  const modelStyles = parseXml(modelStyleXml, 'os estilos do modelo');
  const modelXfs = child(modelStyles.documentElement, 'cellXfs');
  if (!modelXfs) throw new Error('O modelo não contém estilos de célula.');
  const headerStyles = readHeaderStyles(decoder.decode(template[modelOrdersPath]));
  const titleStyle = readCellStyle(decoder.decode(template[modelPresentationPath]), 'A1');
  const requiredStyles = [...new Set([...headerStyles, titleStyle, 54, 63])];
  const merged = mergeTemplateStyles(decoder.decode(workbook[stylesPath]), modelStyleXml, requiredStyles);

  for (const [path, bytes] of Object.entries(workbook)) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(path)) continue;
    const sheetNumber = Number(path.match(/sheet(\d+)\.xml$/)?.[1] || 0);
    workbook[path] = encoder.encode(applySheetStyles(decoder.decode(bytes), headerStyles, merged, originalFormatByStyle, {
      master: sheetNumber === 1,
      presentationSummary: sheetNumber === 2,
      titleStyle,
    }));
  }
  workbook[stylesPath] = encoder.encode(merged.serialize());
  return zipSync(workbook, { level: 6 });
}
