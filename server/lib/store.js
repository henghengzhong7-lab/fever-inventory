'use strict';

/**
 * 业务数据 ↔ 多维表格 的映射层。
 *
 * 设计取舍：每张表的字段不做「业务字段逐列展开」，而是
 *   主键（文本）+ 摘要（文本）+ 数据（整条记录的 JSON）+ 更新时间 + 操作人。
 *
 * 理由有三条：
 *   1. 现有业务模型里有 extra / extraFields / reminders 这类嵌套结构，
 *      展开成列既要定义几十个字段，又会在业务升级时必须改表结构。
 *   2. 多维表格写入是「字段名必须完全匹配」，少一个字段就报 1254045，
 *      把整条记录塞进一个 JSON 列，只有 5 个字段要对齐，出错面小得多。
 *   3. 多出来的「摘要」列是给人看的——队员在飞书里直接打开这张表，
 *      不解析 JSON 也能看出每行是什么东西。
 *
 * 读的时候只认「数据」列，其余列纯粹是给人看的，改坏了也不影响系统。
 */

/** 与前端 v1/js/db.js 的 DB.STORES 严格一致，顺序也一致 */
const STORES = ['categories', 'items', 'purchaseRequests', 'invoices', 'transactions', 'settings'];

const FIELD = {
  KEY: '主键',
  LABEL: '摘要',
  DATA: '数据',
  UPDATED_AT: '更新时间',
  UPDATED_BY: '操作人'
};

/**
 * 每张表的元信息。
 *   autoId —— 这张表的主键是不是「自增数字」（对应 IndexedDB 的 autoIncrement）。
 *             自增表的新记录由服务端分配编号，保证多人在线时不会撞号。
 *   keyOf  —— 从一条业务记录里取出主键值。
 *   labelOf—— 给人看的摘要。
 */
const SPECS = {
  categories: {
    name: '大类',
    autoId: false,
    keyOf: function (row) { return row.id; },
    labelOf: function (row) { return (row.name || '(未命名大类)') + ' · ' + row.id; }
  },
  items: {
    name: '物品',
    autoId: false,
    keyOf: function (row) { return row.code; },
    labelOf: function (row) { return (row.code || '') + ' ' + (row.name || ''); }
  },
  purchaseRequests: {
    name: '采购申请',
    autoId: true,
    keyOf: function (row) { return toId(row.id); },
    labelOf: function (row) { return '#' + toId(row.id) + ' ' + (row.name || '') + ' · ' + (row.applicant || ''); }
  },
  invoices: {
    name: '发票',
    autoId: true,
    keyOf: function (row) { return toId(row.id); },
    labelOf: function (row) { return (row.invoiceNo || '(无号)') + ' · ' + (row.supplier || ''); }
  },
  transactions: {
    name: '出入库流水',
    autoId: true,
    keyOf: function (row) { return toId(row.id); },
    labelOf: function (row) {
      return (row.createdAt || '') + ' ' + (row.itemCode || '') + ' ' + (row.type || '') + ' ×' + (row.qty || 0);
    }
  },
  settings: {
    name: '设置',
    autoId: false,
    keyOf: function (row) { return row.key; },
    labelOf: function (row) { return row.key; }
  }
};

/** 自增表的编号统一按字符串存进表格（多维表格没有数字主键这一说） */
function toId(value) {
  return String(value);
}

function isStore(name) {
  return Object.prototype.hasOwnProperty.call(SPECS, name);
}

function specOf(name) {
  const spec = SPECS[name];
  if (!spec) throw new Error('未知的数据表：' + name);
  return spec;
}

/** 取一条业务记录的主键（字符串形式） */
function keyOf(store, row) {
  const value = specOf(store).keyOf(row);
  if (value === undefined || value === null || value === '') {
    throw new Error('记录缺少主键：' + store);
  }
  return String(value);
}

/**
 * 多维表格的多行文本字段读出来是 [{ text, type }] 这种富文本数组，
 * 写进去时又可以给纯字符串。这里统一成字符串。
 */
function readText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map(function (part) {
      if (part === null || part === undefined) return '';
      if (typeof part === 'string') return part;
      return part.text || part.name || part.link || '';
    }).join('');
  }
  if (value.text) return value.text;
  return String(value);
}

/** 业务记录 → 写入多维表格的 fields */
function rowToFields(store, row, operator, nowIso) {
  const spec = specOf(store);
  return {
    [FIELD.KEY]: keyOf(store, row),
    [FIELD.LABEL]: spec.labelOf(row) || '',
    [FIELD.DATA]: JSON.stringify(row),
    [FIELD.UPDATED_AT]: nowIso,
    [FIELD.UPDATED_BY]: operator || ''
  };
}

/** 多维表格记录 → 业务记录；解析不出来就返回 null（由调用方决定怎么处理） */
function fieldsToRow(record) {
  const fields = (record && record.fields) || {};
  const raw = readText(fields[FIELD.DATA]);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch (err) {
    return null;
  }
}

/** 建表时用的字段定义（5 个字段都是多行文本，type = 1） */
function tableFields() {
  return [
    { field_name: FIELD.KEY, type: 1 },
    { field_name: FIELD.LABEL, type: 1 },
    { field_name: FIELD.DATA, type: 1 },
    { field_name: FIELD.UPDATED_AT, type: 1 },
    { field_name: FIELD.UPDATED_BY, type: 1 }
  ];
}

/** 数据表在飞书里的显示名 */
function tableName(store) {
  return 'FEver·' + specOf(store).name;
}

/** 前端拿到的空数据集 */
function emptyData() {
  const data = {};
  STORES.forEach(function (store) { data[store] = []; });
  return data;
}

/** 把从多维表格读到的记录按 store 归集 */
function assignRows(data, store, records) {
  const spec = specOf(store);
  const rows = [];
  records.forEach(function (record) {
    const row = fieldsToRow(record);
    if (!row) return;
    // 主键以「主键」列为准：万一 JSON 里的主键和列上的不一致，说明有人手改过表格
    const key = readText((record.fields || {})[FIELD.KEY]);
    if (key && spec.autoId) {
      const numeric = Number(key);
      if (!isNaN(numeric)) row.id = numeric;
    }
    rows.push(row);
  });
  data[store] = rows;
  return rows;
}

module.exports = {
  STORES: STORES,
  FIELD: FIELD,
  SPECS: SPECS,
  isStore: isStore,
  specOf: specOf,
  keyOf: keyOf,
  readText: readText,
  rowToFields: rowToFields,
  fieldsToRow: fieldsToRow,
  tableFields: tableFields,
  tableName: tableName,
  emptyData: emptyData,
  assignRows: assignRows
};
