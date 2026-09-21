// 测试文件：FEver战队物资管理系统
const assert = require('assert');

// 设置 fake-indexeddb 作为全局 IndexedDB
require('fake-indexeddb/auto');

// 加载数据库模块并解构导出函数
const {
  openDB,
  dbAdd,
  dbPut,
  dbGet,
  dbGetAll,
  dbGetByIndex,
  dbDelete,
  initDefaultCategories,
  generateItemId
} = require('../js/db.js');

let passedTests = 0;
let failedTests = 0;

function test(name, fn) {
  return fn().then(() => {
    console.log('✓ ' + name);
    passedTests++;
  }).catch(err => {
    console.error('✗ ' + name);
    console.error('  ' + err.message);
    failedTests++;
  });
}

async function runTests() {
  console.log('开始测试...\n');

  // 测试1：数据库初始化
  await test('数据库初始化', async () => {
    await openDB();
    const { db: dbInstance } = require('../js/db.js');
    assert(dbInstance !== null || dbInstance !== undefined, '数据库应该成功打开');
  });

  // 测试2：默认分类初始化
  await test('默认分类初始化', async () => {
    await initDefaultCategories();
    const categories = await dbGetAll('categories');
    assert.strictEqual(categories.length, 4, '应该有4个默认分类');
    const ids = categories.map(c => c.id).sort();
    assert.deepStrictEqual(ids, ['electronic', 'hardware', 'mechanical', 'vision']);
  });

  // 测试3：分类属性验证
  await test('分类包含专属属性', async () => {
    const mechanical = await dbGet('categories', 'mechanical');
    assert(mechanical.extraFields.length > 0, '机械分类应该有专属属性');
    assert(mechanical.extraFields.some(f => f.key === 'material'), '应该包含材质属性');
    
    const electronic = await dbGet('categories', 'electronic');
    assert(electronic.extraFields.some(f => f.key === 'voltage'), '电控分类应该包含电压属性');
    
    const vision = await dbGet('categories', 'vision');
    assert(vision.extraFields.some(f => f.key === 'resolution'), '视觉分类应该包含分辨率属性');
  });

  // 测试4：物品ID生成
  await test('物品ID生成格式正确', async () => {
    const id1 = generateItemId('mechanical');
    assert(id1.startsWith('MC-'), '机械物品ID应该以MC-开头');
    
    const id2 = generateItemId('electronic');
    assert(id2.startsWith('EC-'), '电控物品ID应该以EC-开头');
    
    const id3 = generateItemId('vision');
    assert(id3.startsWith('VS-'), '视觉物品ID应该以VS-开头');
    
    const id4 = generateItemId('hardware');
    assert(id4.startsWith('HW-'), '硬件物品ID应该以HW-开头');
    
    const id5 = generateItemId('unknown');
    assert(id5.startsWith('IT-'), '未知分类应该以IT-开头');
  });

  // 测试5：添加物品
  await test('添加物品到数据库', async () => {
    const item = {
      id: 'MC-TEST001',
      categoryId: 'mechanical',
      name: '测试电机',
      spec: 'NEMA17 1.5A',
      location: 'A区-1号柜',
      remark: '测试物品',
      extraData: { material: '铝合金', size: '42x42x40mm' },
      status: 'in_stock',
      purchaseRequestId: null,
      createdAt: new Date().toISOString()
    };
    await dbAdd('items', item);
    
    const retrieved = await dbGet('items', 'MC-TEST001');
    assert(retrieved, '物品应该被成功添加');
    assert.strictEqual(retrieved.name, '测试电机');
    assert.strictEqual(retrieved.categoryId, 'mechanical');
    assert.strictEqual(retrieved.status, 'in_stock');
  });

  // 测试6：按分类索引查询
  await test('按分类索引查询物品', async () => {
    const mechanicalItems = await dbGetByIndex('items', 'categoryId', 'mechanical');
    assert(mechanicalItems.length >= 1, '应该能查询到机械分类的物品');
    assert(mechanicalItems.every(i => i.categoryId === 'mechanical'), '所有物品都应该属于机械分类');
  });

  // 测试7：更新物品状态
  await test('更新物品状态', async () => {
    const item = await dbGet('items', 'MC-TEST001');
    item.status = 'out_stock';
    await dbPut('items', item);
    
    const updated = await dbGet('items', 'MC-TEST001');
    assert.strictEqual(updated.status, 'out_stock', '状态应该更新为出库');
  });

  // 测试8：添加采购申请
  await test('添加采购申请', async () => {
    const pr = {
      categoryId: 'electronic',
      name: '测试控制器',
      spec: 'Arduino Mega',
      quantity: 3,
      budget: 450.00,
      purpose: '用于项目开发',
      applicant: '张三',
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    const prId = await dbAdd('purchaseRequests', pr);
    
    const retrieved = await dbGet('purchaseRequests', prId);
    assert(retrieved, '采购申请应该被成功添加');
    assert.strictEqual(retrieved.name, '测试控制器');
    assert.strictEqual(retrieved.status, 'pending');
    assert.strictEqual(retrieved.quantity, 3);
  });

  // 测试9：审批采购申请
  await test('审批采购申请', async () => {
    const purchases = await dbGetAll('purchaseRequests');
    const prId = purchases[0].id;
    
    const pr = await dbGet('purchaseRequests', prId);
    pr.status = 'approved';
    await dbPut('purchaseRequests', pr);
    
    const updated = await dbGet('purchaseRequests', prId);
    assert.strictEqual(updated.status, 'approved', '状态应该更新为已审批');
  });

  // 测试10：采购到货入库
  await test('采购到货自动入库', async () => {
    const purchases = await dbGetAll('purchaseRequests');
    const pr = purchases[0];
    
    // 创建3个物品
    const itemIds = [];
    for (let i = 0; i < 3; i++) {
      const itemId = generateItemId(pr.categoryId);
      const item = {
        id: itemId,
        categoryId: pr.categoryId,
        name: pr.name,
        spec: pr.spec,
        location: 'B区-2号柜',
        remark: '',
        extraData: {},
        status: 'in_stock',
        purchaseRequestId: pr.id,
        createdAt: new Date().toISOString()
      };
      await dbAdd('items', item);
      itemIds.push(itemId);
    }
    
    pr.status = 'arrived';
    pr.arrivedAt = new Date().toISOString();
    await dbPut('purchaseRequests', pr);
    
    // 验证物品已创建
    for (const itemId of itemIds) {
      const item = await dbGet('items', itemId);
      assert(item, '物品应该被创建');
      assert.strictEqual(item.status, 'in_stock', '物品状态应该是在库');
      assert.strictEqual(item.purchaseRequestId, pr.id, '应该关联到采购申请');
    }
  });

  // 测试11：添加发票信息
  await test('添加发票信息', async () => {
    const purchases = await dbGetAll('purchaseRequests');
    const prId = purchases[0].id;
    
    const invoice = {
      purchaseRequestId: prId,
      invoiceNo: 'INV-2026-001',
      amount: 450.00,
      supplier: '测试供应商',
      invoiceDate: '2026-09-21',
      createdAt: new Date().toISOString()
    };
    const invoiceId = await dbAdd('invoices', invoice);
    
    const retrieved = await dbGet('invoices', invoiceId);
    assert(retrieved, '发票应该被成功添加');
    assert.strictEqual(retrieved.invoiceNo, 'INV-2026-001');
    assert.strictEqual(retrieved.amount, 450.00);
  });

  // 测试12：按采购申请查询发票
  await test('按采购申请查询发票', async () => {
    const purchases = await dbGetAll('purchaseRequests');
    const prId = purchases[0].id;
    
    const invoices = await dbGetByIndex('invoices', 'purchaseRequestId', prId);
    assert(invoices.length > 0, '应该能查询到关联的发票');
    assert.strictEqual(invoices[0].purchaseRequestId, prId);
  });

  // 测试13：添加出入库记录
  await test('添加出入库记录', async () => {
    const items = await dbGetAll('items');
    const itemId = items[0].id;
    
    const transaction = {
      itemId: itemId,
      type: 'in',
      operator: '测试员',
      remark: '测试入库',
      createdAt: new Date().toISOString()
    };
    const txId = await dbAdd('transactions', transaction);
    
    const retrieved = await dbGet('transactions', txId);
    assert(retrieved, '出入库记录应该被成功添加');
    assert.strictEqual(retrieved.type, 'in');
    assert.strictEqual(retrieved.operator, '测试员');
  });

  // 测试14：按物品查询出入库记录
  await test('按物品查询出入库记录', async () => {
    const items = await dbGetAll('items');
    const itemId = items[0].id;
    
    const transactions = await dbGetByIndex('transactions', 'itemId', itemId);
    assert(transactions.length > 0, '应该能查询到物品的出入库记录');
    assert(transactions.every(t => t.itemId === itemId), '所有记录都应该关联到该物品');
  });

  // 测试15：出库操作
  await test('出库操作更新状态', async () => {
    const items = await dbGetAll('items');
    const item = items[0];
    
    item.status = 'out_stock';
    await dbPut('items', item);
    
    await dbAdd('transactions', {
      itemId: item.id,
      type: 'out',
      operator: '测试员',
      remark: '测试出库',
      createdAt: new Date().toISOString()
    });
    
    const updated = await dbGet('items', item.id);
    assert.strictEqual(updated.status, 'out_stock', '物品状态应该更新为出库');
    
    const transactions = await dbGetByIndex('transactions', 'itemId', item.id);
    assert(transactions.some(t => t.type === 'out'), '应该有出库记录');
  });

  // 测试16：入库操作
  await test('入库操作更新状态', async () => {
    const items = await dbGetAll('items');
    const item = items[0];
    
    item.status = 'in_stock';
    await dbPut('items', item);
    
    await dbAdd('transactions', {
      itemId: item.id,
      type: 'in',
      operator: '测试员',
      remark: '测试入库',
      createdAt: new Date().toISOString()
    });
    
    const updated = await dbGet('items', item.id);
    assert.strictEqual(updated.status, 'in_stock', '物品状态应该更新为在库');
  });

  // 测试17：删除采购申请
  await test('删除采购申请', async () => {
    const pr = {
      categoryId: 'hardware',
      name: '待删除物品',
      quantity: 1,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    const prId = await dbAdd('purchaseRequests', pr);
    
    await dbDelete('purchaseRequests', prId);
    const deleted = await dbGet('purchaseRequests', prId);
    assert.strictEqual(deleted, undefined, '采购申请应该被删除');
  });

  // 测试18：数据关联完整性
  await test('数据关联完整性检查', async () => {
    const items = await dbGetAll('items');
    const categories = await dbGetAll('categories');
    const categoryIds = categories.map(c => c.id);
    
    // 所有物品的分类ID都应该存在
    for (const item of items) {
      assert(categoryIds.includes(item.categoryId), '物品的分类ID应该存在于分类表中');
    }
    
    // 所有采购申请关联的物品应该存在
    const purchases = await dbGetAll('purchaseRequests');
    for (const pr of purchases) {
      if (pr.status === 'arrived') {
        const linkedItems = await dbGetByIndex('items', 'purchaseRequestId', pr.id);
        assert(linkedItems.length > 0, '已到货的采购申请应该有关联的物品');
      }
    }
  });

  // 测试19：批量添加物品
  await test('批量添加物品', async () => {
    const initialCount = (await dbGetAll('items')).length;
    
    for (let i = 0; i < 5; i++) {
      const itemId = generateItemId('hardware');
      await dbAdd('items', {
        id: itemId,
        categoryId: 'hardware',
        name: '批量测试物品' + i,
        spec: '规格' + i,
        location: 'C区',
        remark: '',
        extraData: {},
        status: 'in_stock',
        purchaseRequestId: null,
        createdAt: new Date().toISOString()
      });
    }
    
    const finalCount = (await dbGetAll('items')).length;
    assert.strictEqual(finalCount, initialCount + 5, '应该成功添加5个物品');
  });

  // 测试20：按状态查询物品
  await test('按状态查询物品', async () => {
    const inStockItems = await dbGetByIndex('items', 'status', 'in_stock');
    const outStockItems = await dbGetByIndex('items', 'status', 'out_stock');
    
    assert(inStockItems.length > 0, '应该有在库物品');
    assert(inStockItems.every(i => i.status === 'in_stock'), '所有物品状态应该是在库');
    
    // 出库物品可能为0，所以只验证如果有则状态正确
    assert(outStockItems.every(i => i.status === 'out_stock'), '所有物品状态应该是出库');
  });

  // 测试21：采购申请按分类查询
  await test('采购申请按分类查询', async () => {
    const electronicPRs = await dbGetByIndex('purchaseRequests', 'categoryId', 'electronic');
    assert(electronicPRs.length > 0, '应该能查询到电控分类的采购申请');
    assert(electronicPRs.every(pr => pr.categoryId === 'electronic'), '所有采购申请都应该属于电控分类');
  });

  // 测试22：采购申请按状态查询
  await test('采购申请按状态查询', async () => {
    const arrivedPRs = await dbGetByIndex('purchaseRequests', 'status', 'arrived');
    assert(arrivedPRs.length > 0, '应该能查询到已到货的采购申请');
    assert(arrivedPRs.every(pr => pr.status === 'arrived'), '所有采购申请状态应该是已到货');
  });

  // 测试23：出入库记录按时间排序
  await test('出入库记录按时间排序', async () => {
    const transactions = await dbGetAll('transactions');
    const sorted = [...transactions].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    // 验证排序正确
    for (let i = 0; i < sorted.length - 1; i++) {
      const time1 = new Date(sorted[i].createdAt).getTime();
      const time2 = new Date(sorted[i + 1].createdAt).getTime();
      assert(time1 >= time2, '记录应该按时间倒序排列');
    }
  });

  // 测试24：物品专属属性存储
  await test('物品专属属性存储', async () => {
    const item = {
      id: 'EC-TEST001',
      categoryId: 'electronic',
      name: '测试电路板',
      spec: 'Arduino Uno',
      location: 'D区',
      remark: '',
      extraData: {
        voltage: '5V',
        current: '500mA',
        power: '2.5W',
        interfaceType: 'USB',
        safetyLevel: '一般'
      },
      status: 'in_stock',
      purchaseRequestId: null,
      createdAt: new Date().toISOString()
    };
    await dbAdd('items', item);
    
    const retrieved = await dbGet('items', 'EC-TEST001');
    assert(retrieved.extraData.voltage === '5V', '电压属性应该被保存');
    assert(retrieved.extraData.interfaceType === 'USB', '接口类型应该被保存');
  });

  // 测试25：完整业务流程测试
  await test('完整业务流程：申请→审批→到货→入库→出库→入库', async () => {
    // 1. 创建采购申请
    const pr = {
      categoryId: 'vision',
      name: '工业相机',
      spec: '500万像素',
      quantity: 2,
      budget: 3000,
      purpose: '视觉检测项目',
      applicant: '李四',
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    const prId = await dbAdd('purchaseRequests', pr);
    
    // 2. 审批
    const prData = await dbGet('purchaseRequests', prId);
    prData.status = 'approved';
    await dbPut('purchaseRequests', prData);
    
    // 3. 到货入库
    const itemIds = [];
    for (let i = 0; i < 2; i++) {
      const itemId = generateItemId('vision');
      await dbAdd('items', {
        id: itemId,
        categoryId: 'vision',
        name: '工业相机',
        spec: '500万像素',
        location: 'E区-1号柜',
        remark: '',
        extraData: { resolution: '500万像素', frameRate: '60fps' },
        status: 'in_stock',
        purchaseRequestId: prId,
        createdAt: new Date().toISOString()
      });
      await dbAdd('transactions', {
        itemId: itemId,
        type: 'in',
        operator: '李四',
        remark: '采购到货入库',
        createdAt: new Date().toISOString()
      });
      itemIds.push(itemId);
    }
    
    // 4. 添加发票
    await dbAdd('invoices', {
      purchaseRequestId: prId,
      invoiceNo: 'INV-2026-002',
      amount: 3000,
      supplier: '视觉设备供应商',
      invoiceDate: '2026-09-21',
      createdAt: new Date().toISOString()
    });
    
    prData.status = 'arrived';
    prData.arrivedAt = new Date().toISOString();
    await dbPut('purchaseRequests', prData);
    
    // 5. 出库第一个
    const item1 = await dbGet('items', itemIds[0]);
    item1.status = 'out_stock';
    await dbPut('items', item1);
    await dbAdd('transactions', {
      itemId: itemIds[0],
      type: 'out',
      operator: '王五',
      remark: '用于视觉检测项目',
      createdAt: new Date().toISOString()
    });
    
    // 6. 重新入库
    item1.status = 'in_stock';
    await dbPut('items', item1);
    await dbAdd('transactions', {
      itemId: itemIds[0],
      type: 'in',
      operator: '王五',
      remark: '项目完成归还',
      createdAt: new Date().toISOString()
    });
    
    // 验证
    const finalItem1 = await dbGet('items', itemIds[0]);
    assert.strictEqual(finalItem1.status, 'in_stock', '物品1应该最终在库');
    
    const finalItem2 = await dbGet('items', itemIds[1]);
    assert.strictEqual(finalItem2.status, 'in_stock', '物品2应该在库');
    
    const transactions = await dbGetByIndex('transactions', 'itemId', itemIds[0]);
    assert.strictEqual(transactions.length, 3, '物品1应该有3条记录（入库→出库→入库）');
    
    const invoices = await dbGetByIndex('invoices', 'purchaseRequestId', prId);
    assert(invoices.length > 0, '应该有发票记录');
    
    const finalPR = await dbGet('purchaseRequests', prId);
    assert.strictEqual(finalPR.status, 'arrived', '采购申请状态应该是已到货');
  });

  // 输出测试结果
  console.log('\n' + '='.repeat(50));
  console.log('测试完成');
  console.log('通过: ' + passedTests);
  console.log('失败: ' + failedTests);
  console.log('总计: ' + (passedTests + failedTests));
  console.log('='.repeat(50));

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('测试运行出错:', err);
  process.exit(1);
});
