import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { initializeDatabase } from '../db/migrations.ts';
import { createSupplier, listSuppliers } from '../repositories/supplierRepository.ts';
import { countPendingOps } from '../sync/pendingOps.ts';
import {
  buildSampleXlsx,
  importSupplierFile,
  importSupplierRows,
  parseCsv,
  parseXlsx,
  SAMPLE_SHEET_ROWS
} from './supplierImport.ts';

function makeZip(files: Array<[string, string]>): Buffer {
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

function makeXlsx(): Buffer {
  const shared = ['Name', 'Name CN', 'Mobile', 'Map URL', 'Xlsx Factory', '新工厂', 'https://maps.app.goo.gl/xlsx1'];
  const sharedXml =
    '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    shared.map((s) => `<si><t>${s}</t></si>`).join('') +
    '</sst>';
  const sheetXml =
    '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2" t="s"><v>5</v></c><c r="C2"><v>13800001111</v></c><c r="D2" t="s"><v>6</v></c></row>' +
    '</sheetData></worksheet>';
  return makeZip([
    ['xl/sharedStrings.xml', sharedXml],
    ['xl/worksheets/sheet1.xml', sheetXml]
  ]);
}

test('parseCsv handles quotes, commas, CRLF, BOM, and Chinese text', () => {
  const csv = '﻿Name,"Address, EN",Notes\r\n"Quoted ""Co""",金龙大道1号,"line1\nline2"\r\n';
  assert.deepEqual(parseCsv(csv), [
    ['Name', 'Address, EN', 'Notes'],
    ['Quoted "Co"', '金龙大道1号', 'line1\nline2']
  ]);
});

test('parseXlsx reads shared strings, inline numbers, and cell references', () => {
  assert.deepEqual(parseXlsx(makeXlsx()), [
    ['Name', 'Name CN', 'Mobile', 'Map URL'],
    ['Xlsx Factory', '新工厂', '13800001111', 'https://maps.app.goo.gl/xlsx1']
  ]);
});

test('importSupplierRows maps aliased headers, dedupes, and reports invalid rows', async () => {
  initializeDatabase();
  await createSupplier({ name: 'Already Here Ltd' });
  const before = countPendingOps();

  const result = await importSupplierRows([
    ['Supplier Name', 'Contact Person', 'Phone', 'WeChat', 'Category', 'Google Maps Link', 'Email', 'Region', 'WhatsApp', 'Landline'],
    ['Sheet Factory One', 'Mr. Wu', '138 1111 2222', 'wu_sf1', 'plastics', 'https://maps.app.goo.gl/one', 'wu@sf1.cn', 'Zhejiang', '-', '0579-1234567'],
    ['already here ltd', 'Ms. Dupe', '', '', '', '', '', '', '', ''],
    ['', 'No Name Row', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', ''],
    ['Sheet Factory Two', '', '', '', 'metals', '', '', '', '', '']
  ]);

  assert.equal(result.imported, 2);
  assert.equal(result.skipped_existing, 1);
  assert.equal(result.skipped_invalid, 1);
  assert.equal(result.total_rows, 4);
  assert.match(result.errors[0] ?? '', /missing name/);

  const suppliers = await listSuppliers();
  const one = suppliers.find((s) => s.name === 'Sheet Factory One');
  assert.equal(one?.contact_name, 'Mr. Wu');
  assert.equal(one?.wechat_id, 'wu_sf1');
  assert.equal(one?.map_url, 'https://maps.app.goo.gl/one');
  assert.equal(one?.email, 'wu@sf1.cn');
  assert.equal(one?.region, 'Zhejiang');
  assert.equal(one?.whatsapp, null); // '-' means no data
  assert.equal(one?.notes, 'Landline: 0579-1234567'); // recognized extras fold into notes

  // Imported rows entered the sync queue like normal writes.
  assert.equal(countPendingOps(), before + 2);
});

test('importSupplierFile dispatches by extension and rejects unknown types', async () => {
  initializeDatabase();

  const xlsxResult = await importSupplierFile('suppliers.xlsx', makeXlsx());
  assert.equal(xlsxResult.imported, 1);
  const xlsxSupplier = (await listSuppliers()).find((s) => s.name === 'Xlsx Factory');
  assert.equal(xlsxSupplier?.name_cn, '新工厂');
  assert.equal(xlsxSupplier?.contact_mobile, '13800001111');

  const csvResult = await importSupplierFile('more.csv', Buffer.from('Name\nCsv Factory\n'));
  assert.equal(csvResult.imported, 1);

  // Re-importing the same xlsx is a no-op thanks to name dedupe.
  const again = await importSupplierFile('suppliers.xlsx', makeXlsx());
  assert.deepEqual([again.imported, again.skipped_existing], [0, 1]);

  await assert.rejects(() => importSupplierFile('suppliers.pdf', Buffer.from('x')), /Unsupported file type/);
});

test('generated sample sheet round-trips through the parser and importer', async () => {
  initializeDatabase();
  const sample = buildSampleXlsx();
  assert.equal(sample.readUInt16BE(0), 0x504b); // ZIP magic "PK"

  assert.deepEqual(parseXlsx(sample), SAMPLE_SHEET_ROWS);

  const result = await importSupplierFile('triptrack-suppliers-sample.xlsx', sample);
  assert.equal(result.imported, SAMPLE_SHEET_ROWS.length - 1);
  const imported = (await listSuppliers()).find((s) => s.name === 'Golden Sample Textiles');
  assert.equal(imported?.name_cn, '金样纺织');
  assert.equal(imported?.map_url, 'https://maps.app.goo.gl/example1');
});
