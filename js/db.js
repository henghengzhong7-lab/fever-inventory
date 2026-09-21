const DB_NAME = 'FEverInventory';
const DB_VERSION = 1;
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains('categories')) {
        const cs = database.createObjectStore('categories', { keyPath: 'id' });
        cs.createIndex('name', 'name', { unique: true });
      }
      if (!database.objectStoreNames.contains('items')) {
        const is = database.createObjectStore('items', { keyPath: 'id' });
        is.createIndex('categoryId', 'categoryId', { unique: false });
        is.createIndex('status', 'status', { unique: false });
        is.createIndex('purchaseRequestId', 'purchaseRequestId', { unique: false });
      }
      if (!database.objectStoreNames.contains('purchaseRequests')) {
        const ps = database.createObjectStore('purchaseRequests', { keyPath: 'id', autoIncrement: true });
        ps.createIndex('categoryId', 'categoryId', { unique: false });
        ps.createIndex('status', 'status', { unique: false });
      }
      if (!database.objectStoreNames.contains('invoices')) {
        const ivs = database.createObjectStore('invoices', { keyPath: 'id', autoIncrement: true });
        ivs.createIndex('purchaseRequestId', 'purchaseRequestId', { unique: false });
      }
      if (!database.objectStoreNames.contains('transactions')) {
        const ts = database.createObjectStore('transactions', { keyPath: 'id', autoIncrement: true });
        ts.createIndex('itemId', 'itemId', { unique: false });
        ts.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    request.onsuccess = (event) => { db = event.target.result; resolve(db); };
    request.onerror = (event) => reject(event.target.error);
  });
}

function dbAdd(storeName, data) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).add(data);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(storeName, data) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(data);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGet(storeName, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGetByIndex(storeName, indexName, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).index(indexName).getAll(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbDelete(storeName, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function initDefaultCategories() {
  const categories = await dbGetAll('categories');
  if (categories.length === 0) {
    const defaults = [
      { id: 'mechanical', name: '机械', icon: '⚙️', description: '机械零部件、结构件等',
        extraFields: [
          { key: 'material', label: '材质', type: 'text', placeholder: '如：铝合金6061' },
          { key: 'size', label: '尺寸规格', type: 'text', placeholder: '如：100x50x20mm' },
          { key: 'loadCapacity', label: '承重/载荷', type: 'text', placeholder: '如：5kg' },
          { key: 'lifespan', label: '预计寿命', type: 'text', placeholder: '如：10000次' },
          { key: 'maintenanceCycle', label: '维护周期', type: 'text', placeholder: '如：每500次' }
        ]},
      { id: 'electronic', name: '电控', icon: '🔌', description: '电路板、控制器、传感器等',
        extraFields: [
          { key: 'voltage', label: '工作电压', type: 'text', placeholder: '如：12V/24V' },
          { key: 'current', label: '工作电流', type: 'text', placeholder: '如：2A' },
          { key: 'power', label: '功率', type: 'text', placeholder: '如：50W' },
          { key: 'interfaceType', label: '接口类型', type: 'text', placeholder: '如：CAN/RS485/USB' },
          { key: 'safetyLevel', label: '安全等级', type: 'select', options: ['一般', '注意', '高压危险'] }
        ]},
      { id: 'vision', name: '视觉', icon: '📷', description: '相机、镜头、光源等视觉器件',
        extraFields: [
          { key: 'resolution', label: '分辨率', type: 'text', placeholder: '如：500万像素' },
          { key: 'frameRate', label: '帧率', type: 'text', placeholder: '如：60fps' },
          { key: 'focalLength', label: '焦距/视场角', type: 'text', placeholder: '如：12mm/60°' },
          { key: 'calibrationStatus', label: '标定状态', type: 'select', options: ['未标定', '已标定', '需重新标定'] },
          { key: 'calibrationDate', label: '最近标定日期', type: 'date', options: [] }
        ]},
      { id: 'hardware', name: '硬件', icon: '🔧', description: '框架、底板、连接件等',
        extraFields: [
          { key: 'material', label: '材质', type: 'text', placeholder: '如：45号钢' },
          { key: 'surfaceTreatment', label: '表面处理', type: 'text', placeholder: '如：阳极氧化' },
          { key: 'mountingHoles', label: '安装孔位', type: 'text', placeholder: '如：M4x4孔' },
          { key: 'assemblyPosition', label: '装配位置', type: 'text', placeholder: '如：底盘左侧' },
          { key: 'weight', label: '重量', type: 'text', placeholder: '如：200g' }
        ]}
    ];
    for (const cat of defaults) {
      await dbAdd('categories', { ...cat, createdAt: new Date().toISOString() });
    }
  }
}

function generateItemId(categoryId) {
  const prefixMap = { mechanical: 'MC', electronic: 'EC', vision: 'VS', hardware: 'HW' };
  const prefix = prefixMap[categoryId] || 'IT';
  return prefix + '-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 4).toUpperCase();
}

// 导出函数供测试使用
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    openDB,
    dbAdd,
    dbPut,
    dbGet,
    dbGetAll,
    dbGetByIndex,
    dbDelete,
    initDefaultCategories,
    generateItemId
  };
}
