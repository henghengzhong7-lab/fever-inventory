/**
 * 发票附件与打包下载（第十三轮）。
 *
 * 确认到货不再要发票号和供应商，改传发票 PDF。这里验证的是**数据层的真规则**：
 *   · 发票号/供应商可以空 —— 不填也得能把货入进来；
 *   · 附件必须是 PDF —— 绕过表单（导入、脚本调用）也塞不进别的东西；
 *   · 附件跟着发票行走 —— 离线版直接存 base64，备份导出导入天然带着它；
 *   · loadInvoiceFile 是"没有附件就 null"，不抛错 —— 老数据没有这些键，不能炸。
 * 另有一组钉住 ZIP 打包器本身的用例：格式错一个字节，队员拿到的就是个打不开的压缩包。
 */
'use strict';

const Zip = require('../../js/zip.js');

module.exports.register = function (H, DB, Rules, Ops) {
  const { test, assert, assertEqual, assertRejects } = H;

  async function fresh() {
    await Rules.clearAll();
    await Rules.initCategories();
  }

  /** 造一条已同意、已下单的申请，返回 id */
  async function addOrdered(over) {
    const now = DB.nowIso();
    const row = Object.assign({
      categoryId: 'hardware', troop: '其他', name: '扎带', spec: '', quantity: 10,
      budget: '50', purpose: '', applicant: '王五', status: 'ordered',
      approval: 'approved', createdAt: now, updatedAt: now
    }, over);
    return DB.add('purchaseRequests', row);
  }

  /** 一段以 %PDF 开头的最小 PDF 字节（base64） */
  function pdfBase64(text) {
    return Buffer.from('%PDF-1.4\n' + (text || 'invoice') + '\n%%EOF', 'utf8').toString('base64');
  }

  test('确认到货不填发票号、供应商，也能正常入库', async () => {
    await fresh();
    const id = await addOrdered();
    const res = await Ops.arrive({
      requestId: id, quantity: 10, amount: 45, operator: '李四', identityMode: 'shared'
    });
    assertEqual(res.codes.length, 1, '应生成 1 个身份');
    const inv = await DB.get('invoices', res.invoiceId);
    assert(inv, '发票行应照常登记');
    assertEqual(inv.invoiceNo, '', '发票号应为空字符串（不再必填）');
    assertEqual(inv.supplier, '', '供应商应为空字符串');
    assertEqual(inv.amount, 45, '金额照记');
    assert(!inv.fileData && !inv.fileRef, '没传 PDF 就不该有附件键');
  });

  test('带 PDF 的到货：附件存进发票行，base64 还原后就是原始字节', async () => {
    await fresh();
    const id = await addOrdered();
    const b64 = pdfBase64('FEver-invoice-no-001');
    const res = await Ops.arrive({
      requestId: id, quantity: 10, amount: 45, operator: '李四', identityMode: 'shared',
      invoiceFile: { name: '测试发票.pdf', mime: 'application/pdf', size: 100, base64: b64 }
    });
    const inv = await DB.get('invoices', res.invoiceId);
    assertEqual(inv.fileName, '测试发票.pdf');
    assertEqual(inv.fileMime, 'application/pdf');
    assertEqual(inv.fileData, b64, '离线版应把 PDF 本体（base64）存进行数据里');
    assert(inv.fileSize > 0, '文件大小应记下来');

    const loaded = await DB.loadInvoiceFile(inv);
    assert(loaded, 'loadInvoiceFile 应取到附件');
    assertEqual(loaded.fileName, '测试发票.pdf');
    assertEqual(Buffer.from(loaded.base64, 'base64').toString('utf8').indexOf('%PDF'), 0,
      '取回来的必须是 PDF 原始字节');
  });

  test('附件必须是 PDF：绕过表单塞 .txt 会被数据层拒收', async () => {
    await fresh();
    const id = await addOrdered();
    await assertRejects(() => Ops.arrive({
      requestId: id, quantity: 10, amount: 45, operator: '李四', identityMode: 'shared',
      invoiceFile: { name: '发票.txt', mime: 'text/plain', size: 3, base64: Buffer.from('abc').toString('base64') }
    }), '非 PDF 附件必须被拒收 —— 不然下载出来打不开，队员只会怪应用坏了');
    const invs = await DB.getAll('invoices');
    assertEqual(invs.length, 0, '被拒后不应留下发票行');
  });

  test('附件残缺（缺内容）也会被拒收，且不留下半套数据', async () => {
    await fresh();
    const id = await addOrdered();
    await assertRejects(() => Ops.arrive({
      requestId: id, quantity: 10, amount: 45, operator: '李四', identityMode: 'shared',
      invoiceFile: { name: '发票.pdf', mime: 'application/pdf', base64: '' }
    }), '缺 base64 应被拒收');
    const invs = await DB.getAll('invoices');
    assertEqual(invs.length, 0, '不应留下发票行');
    const items = await DB.getAll('items');
    assertEqual(items.length, 0, '不应生成物品');
  });

  test('老发票（没有附件键）loadInvoiceFile 返回 null 而不是报错', async () => {
    await fresh();
    const id = await addOrdered();
    const res = await Ops.arrive({
      requestId: id, quantity: 10, amount: 45, operator: '李四', identityMode: 'shared'
    });
    const inv = await DB.get('invoices', res.invoiceId);
    assertEqual(await DB.loadInvoiceFile(inv), null, '没附件就该是 null');
    assertEqual(await DB.loadInvoiceFile(null), null, '传 null 也不该炸');
  });

  test('带附件的发票备份导出导入后，PDF 还在（离线版附件跟着行走）', async () => {
    await fresh();
    const id = await addOrdered();
    const b64 = pdfBase64('backup-check');
    await Ops.arrive({
      requestId: id, quantity: 10, amount: 45, operator: '李四', identityMode: 'shared',
      invoiceFile: { name: '发票.pdf', mime: 'application/pdf', size: 100, base64: b64 }
    });
    const payload = await Rules.exportAll();
    assertEqual(Rules.validateBackup(payload).ok, true, '含附件的备份应合法');
    await Rules.importAll(payload);
    const invs = await DB.getAll('invoices');
    assertEqual(invs.length, 1);
    assertEqual(invs[0].fileData, b64, '导入备份后 PDF 必须还在');
  });

  test('invoiceLabel：空发票号回退到文件名，再回退到序号', async () => {
    assertEqual(Rules.invoiceLabel({ id: 7, invoiceNo: 'FP-1', fileName: 'a.pdf' }), 'FP-1');
    assertEqual(Rules.invoiceLabel({ id: 7, invoiceNo: '', fileName: '测试发票.pdf' }), '测试发票.pdf');
    assertEqual(Rules.invoiceLabel({ id: 7 }), '发票 #7', '连文件名都没有也不能显示成空白');
  });

  /* ================= ZIP 打包器 ================= */

  function ascii(bytes, from, to) {
    let s = '';
    for (let i = from; i < to; i += 1) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function findBytes(bytes, needle, from) {
    outer: for (let i = from || 0; i <= bytes.length - needle.length; i += 1) {
      for (let j = 0; j < needle.length; j += 1) {
        if (bytes[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  test('ZIP 头尾都是合法签名，条目数与文件数一致', async () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = new Uint8Array([9, 8, 7]);
    const zip = Zip.build([
      { name: '发票/FP-1.pdf', bytes: a },
      { name: '发票/FP-2.pdf', bytes: b }
    ]);
    assertEqual(ascii(zip, 0, 4), 'PK\x03\x04', '应以本地文件头开始');
    assertEqual(ascii(zip, zip.length - 22, zip.length - 18), 'PK\x05\x06', '应以 EOCD 结束');
    // EOCD 里第 10、12 字节是条目总数（u16 ×2）
    const eocd = zip.length - 22;
    const count = zip[eocd + 10] | (zip[eocd + 11] << 8);
    assertEqual(count, 2, 'EOCD 里记录的条目数应为 2');
    let hits = 0;
    for (let i = 0; i < zip.length - 4; i += 1) {
      if (zip[i] === 0x50 && zip[i + 1] === 0x4B && zip[i + 2] === 0x03 && zip[i + 3] === 0x04) hits += 1;
    }
    assertEqual(hits, 2, '本地文件头应出现 2 次（每个条目一次）');
  });

  test('ZIP 里的文件内容原样可解（store 不压缩，数据就是原始字节）', async () => {
    const content = new Uint8Array(Buffer.from('%PDF-1.4 zip payload check\n', 'utf8'));
    const zip = Zip.build([{ name: 'a.pdf', bytes: content }]);
    // 本地文件头固定 30 字节 + 文件名，数据紧跟其后
    const nameLen = zip[26] | (zip[27] << 8);
    const dataStart = 30 + nameLen;
    assertEqual(Buffer.from(zip.slice(dataStart, dataStart + content.length)).toString('utf8'),
      Buffer.from(content).toString('utf8'), '存进去的字节应原样读回来');
    assertEqual(findBytes(zip, [0x25, 0x50, 0x44, 0x46]) >= 0, true, '整包里应能找到 %PDF 头');
  });

  test('中文名文件也能打包（文件名按 UTF-8 存，带语言标志）', async () => {
    const zip = Zip.build([{ name: '测试发票/FP-001.pdf', bytes: new Uint8Array([1]) }]);
    assertEqual(ascii(zip, 0, 4), 'PK\x03\x04');
    // 0x0800 = UTF-8 文件名标志
    assertEqual(zip[7], 0x08, '本地头的标志位应带 0x0800（UTF-8）');
  });

  test('空文件也能打包（长度为 0 的条目是合法的）', async () => {
    const zip = Zip.build([{ name: 'empty.pdf', bytes: new Uint8Array(0) }]);
    assertEqual(ascii(zip, 0, 4), 'PK\x03\x04');
    assertEqual(ascii(zip, zip.length - 22, zip.length - 18), 'PK\x05\x06');
  });
};
