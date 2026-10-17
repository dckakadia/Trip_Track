import { crc32, inflateRawSync } from 'node:zlib';
import { createSupplier, listSuppliers, type CreateSupplierInput } from '../repositories/supplierRepository.ts';
import { handleDbError } from '../repositories/repositoryHelpers.ts';

// ---------- CSV ----------

export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ---------- Minimal XLSX (zip of XML) ----------

function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  let eocd = -1;
  const scanEnd = Math.max(0, buffer.length - 22 - 65535);
  for (let i = buffer.length - 22; i >= scanEnd; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('Not a valid .xlsx file');
  }
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Corrupt .xlsx file');
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function decodeXml(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    const code = entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return String.fromCodePoint(code);
  });
}

function textOf(block: string): string {
  const parts = block.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? [];
  return parts.map((t) => decodeXml(t.replace(/^<t[^>]*>/, '').replace(/<\/t>$/, ''))).join('');
}

function columnIndex(ref: string): number {
  let index = 0;
  for (const ch of ref) {
    index = index * 26 + (ch.charCodeAt(0) - 64);
  }
  return index - 1;
}

export function parseXlsx(buffer: Buffer): string[][] {
  const entries = readZipEntries(buffer);
  const sheetName =
    [...entries.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort()[0] ?? null;
  if (!sheetName) {
    throw new Error('No worksheet found in .xlsx file');
  }
  const sharedXml = entries.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  const shared = (sharedXml.match(/<si[\s>][\s\S]*?<\/si>/g) ?? []).map(textOf);

  const sheetXml = entries.get(sheetName)!.toString('utf8');
  const rows: string[][] = [];
  for (const rowXml of sheetXml.match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? []) {
    const cells: string[] = [];
    const cellRe = /<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let match;
    while ((match = cellRe.exec(rowXml))) {
      const attrs = match[1] ?? '';
      const inner = match[2] ?? '';
      const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const type = /t="(\w+)"/.exec(attrs)?.[1];
      const v = /<v[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = '';
      if (type === 's') {
        value = shared[Number(v)] ?? '';
      } else if (type === 'inlineStr') {
        value = textOf(inner);
      } else if (v !== undefined) {
        value = decodeXml(v);
      }
      cells[ref ? columnIndex(ref) : cells.length] = value;
    }
    rows.push(Array.from(cells, (cell) => cell ?? ''));
  }
  return rows;
}

// ---------- Header mapping + import ----------

const HEADER_ALIASES: Record<keyof Omit<CreateSupplierInput, 'city_id' | 'priority' | 'skip_reason'>, string[]> = {
  name: ['name', 'suppliername', 'supplier', 'company', 'companyname', 'factory', 'factoryname'],
  name_cn: ['namecn', 'cnname', 'chinesename', 'namechinese', 'suppliernamecn'],
  contact_name: ['contact', 'contactname', 'contactperson'],
  contact_mobile: ['mobile', 'phone', 'tel', 'telephone', 'contactmobile', 'mobilenumber', 'phonenumber'],
  whatsapp: ['whatsapp', 'whatsappnumber', 'whatsappno'],
  email: ['email', 'emailid', 'mail', 'emailaddress'],
  website: ['website', 'web', 'site', 'url', 'homepage'],
  wechat_id: ['wechat', 'wechatid', 'weixin'],
  product_category: ['category', 'productcategory'],
  products: ['products', 'product', 'productlist', 'items'],
  specialty: ['specialty', 'speciality', 'specialties', 'strengths'],
  region: ['region', 'province', 'state', 'area'],
  established: ['established', 'establishedyear', 'founded', 'since', 'yearestablished'],
  employees: ['employees', 'staff', 'workers', 'employeecount', 'headcount'],
  export_markets: ['exportmarkets', 'markets', 'export', 'exports'],
  address_en: ['address', 'addressen', 'englishaddress', 'factoryaddress', 'headquartersfactoryaddress', 'headquarters', 'hqaddress'],
  address_cn: ['addresscn', 'chineseaddress', 'addresschinese'],
  map_url: ['mapurl', 'maplink', 'map', 'googlemaps', 'googlemapslink', 'googlemapsurl'],
  gps_lat: ['lat', 'latitude', 'gpslat', 'gpslatitude'],
  gps_lng: ['lng', 'lon', 'long', 'longitude', 'gpslng', 'gpslongitude'],
  notes: ['notes', 'note', 'remarks', 'remark', 'comments', 'comment']
};

// Recognized secondary columns that have no dedicated field — appended to notes
// so a real-world master sheet loses nothing on import.
const NOTES_EXTRAS: Array<{ label: string; aliases: string[] }> = [
  { label: 'Office', aliases: ['officebranchaddress', 'officeaddress', 'branchaddress', 'branch', 'office'] },
  { label: 'Alt office', aliases: ['alternateoffice', 'alternateaddress', 'otheroffice'] },
  { label: 'Landline', aliases: ['landline', 'fixedline', 'officephone'] }
];

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');
}

export interface SupplierImportResult {
  total_rows: number;
  imported: number;
  skipped_existing: number;
  skipped_invalid: number;
  errors: string[];
}

export async function importSupplierRows(rows: string[][]): Promise<SupplierImportResult> {
  try {
    const headerRow = rows.find((row) => row.some((cell) => cell.trim() !== ''));
    if (!headerRow) {
      throw new Error('The file is empty');
    }
    const headerIndex = rows.indexOf(headerRow);
    const normalized = headerRow.map(normalizeHeader);
    const columns: Partial<Record<keyof typeof HEADER_ALIASES, number>> = {};
    for (const [field, aliases] of Object.entries(HEADER_ALIASES) as Array<[keyof typeof HEADER_ALIASES, string[]]>) {
      const index = normalized.findIndex((header) => aliases.includes(header));
      if (index >= 0) {
        columns[field] = index;
      }
    }
    const extraColumns = NOTES_EXTRAS.map((extra) => ({
      label: extra.label,
      index: normalized.findIndex((header) => extra.aliases.includes(header))
    })).filter((extra) => extra.index >= 0);
    if (columns.name === undefined) {
      throw new Error('No "Name" column found — the first row must contain column headers (e.g. Name, Contact, Mobile, WeChat, Category, Address, Map URL)');
    }

    const existing = new Set((await listSuppliers()).map((supplier) => supplier.name.trim().toLowerCase()));
    const result: SupplierImportResult = {
      total_rows: 0,
      imported: 0,
      skipped_existing: 0,
      skipped_invalid: 0,
      errors: []
    };

    for (let i = headerIndex + 1; i < rows.length; i++) {
      const row = rows[i]!;
      if (row.every((cell) => cell.trim() === '')) {
        continue;
      }
      result.total_rows += 1;

      const cellAt = (index: number | undefined): string | null => {
        const value = index === undefined ? '' : (row[index] ?? '').trim();
        // Real-world sheets commonly use dashes for "no data".
        return value === '' || value === '-' || value === '—' ? null : value;
      };
      const cell = (field: keyof typeof HEADER_ALIASES): string | null => cellAt(columns[field]);
      const cellNumber = (field: keyof typeof HEADER_ALIASES, min: number, max: number): number | null => {
        const raw = cell(field);
        if (raw === null) return null;
        const value = Number(raw);
        return Number.isFinite(value) && value >= min && value <= max ? value : null;
      };

      const name = cell('name');
      if (!name) {
        result.skipped_invalid += 1;
        if (result.errors.length < 10) {
          result.errors.push(`Row ${i + 1}: missing name`);
        }
        continue;
      }
      if (existing.has(name.toLowerCase())) {
        result.skipped_existing += 1;
        continue;
      }

      const extras = extraColumns
        .map((extra) => ({ label: extra.label, value: cellAt(extra.index) }))
        .filter((extra) => extra.value !== null)
        .map((extra) => `${extra.label}: ${extra.value}`);
      const notes = [cell('notes'), ...extras].filter(Boolean).join(' · ') || null;

      await createSupplier({
        name,
        name_cn: cell('name_cn'),
        contact_name: cell('contact_name'),
        contact_mobile: cell('contact_mobile'),
        whatsapp: cell('whatsapp'),
        email: cell('email'),
        website: cell('website'),
        wechat_id: cell('wechat_id'),
        product_category: cell('product_category'),
        products: cell('products'),
        specialty: cell('specialty'),
        region: cell('region'),
        established: cell('established'),
        employees: cell('employees'),
        export_markets: cell('export_markets'),
        address_en: cell('address_en'),
        address_cn: cell('address_cn'),
        map_url: cell('map_url'),
        gps_lat: cellNumber('gps_lat', -90, 90),
        gps_lng: cellNumber('gps_lng', -180, 180),
        notes
      });
      existing.add(name.toLowerCase());
      result.imported += 1;
    }
    return result;
  } catch (error) {
    handleDbError('import suppliers', error);
  }
}

// ---------- Sample sheet (.xlsx writer) ----------

function zipStore(files: Array<[string, string]>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(content);
    const crc = crc32(data) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const SAMPLE_SHEET_ROWS: string[][] = [
  [
    'Name', 'Name CN', 'Contact', 'Mobile', 'WhatsApp', 'Email', 'Website', 'WeChat', 'Category', 'Products',
    'Region', 'Address', 'Address CN', 'Map URL', 'Established', 'Employees', 'Export Markets', 'Specialty', 'Notes'
  ],
  [
    'Golden Sample Textiles',
    '金样纺织',
    'Mr. Chen',
    '+86 138 0000 1111',
    '13800001111',
    'chen@goldensample.cn',
    'www.goldensample.cn',
    'chen_gst',
    'textiles',
    'Cotton totes, canvas bags, garment accessories',
    'Guangdong',
    "Bldg 3, Textile Park, Bao'an, Shenzhen",
    '深圳市宝安区纺织工业园3栋',
    'https://maps.app.goo.gl/example1',
    '2008',
    '200+',
    'North America, Europe',
    'OEM/ODM, custom colors',
    'Preferred cotton supplier'
  ],
  [
    'Pearl Sample Electronics',
    '珠样电子',
    'Ms. Liu',
    '+86 137 2222 3333',
    '-',
    'liu@pearlsample.com',
    '-',
    'liu_pse',
    'electronics',
    'PCB assembly, LED modules',
    'Guangdong',
    '-',
    '广州市白云区电子路88号',
    '-',
    '1996',
    '500',
    'Middle East, Africa',
    '-',
    'MOQ 500 pcs'
  ]
];

export function buildSampleXlsx(): Buffer {
  const strings: string[] = [];
  const indexOf = (value: string): number => {
    let index = strings.indexOf(value);
    if (index < 0) {
      index = strings.length;
      strings.push(value);
    }
    return index;
  };

  const rowsXml = SAMPLE_SHEET_ROWS.map((row, r) => {
    const cells = row
      .map((value, c) => {
        if (value === '') {
          return '';
        }
        const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
        return `<c r="${ref}" t="s"><v>${indexOf(value)}</v></c>`;
      })
      .join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');

  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const relNs = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const sheetXml = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${ns}"><sheetData>${rowsXml}</sheetData></worksheet>`;
  const sharedXml =
    `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="${ns}" count="${strings.length}" uniqueCount="${strings.length}">` +
    strings.map((s) => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`).join('') +
    '</sst>';
  const workbookXml = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Suppliers" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${relNs}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${relNs}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;

  return zipStore([
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rootRels],
    ['xl/workbook.xml', workbookXml],
    ['xl/_rels/workbook.xml.rels', workbookRels],
    ['xl/sharedStrings.xml', sharedXml],
    ['xl/worksheets/sheet1.xml', sheetXml]
  ]);
}

export async function importSupplierFile(filename: string, data: Buffer): Promise<SupplierImportResult> {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.xlsx')) {
    return importSupplierRows(parseXlsx(data));
  }
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    return importSupplierRows(parseCsv(data.toString('utf8')));
  }
  throw new Error('Unsupported file type — upload a .xlsx or .csv file');
}
