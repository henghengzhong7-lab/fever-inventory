let currentCategoryId = null;
let currentPurchaseId = null;
let currentScanItemId = null;
let html5QrCode = null;

async function init() {
  await openDB();
  await initDefaultCategories();
  await renderHomePage();
}

function showPage(page) {
  document.querySelectorAll('[id^="page-"]').forEach(el => el.style.display = 'none');
  document.getElementById('page-' + page).style.display = 'block';
}

function showToast(message, type) {
  const toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function openModal(id) { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }

function formatDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}

function statusText(status) {
  const map = { 'in_stock': '在库', 'out_stock': '出库', 'pending': '待审批', 'approved': '已审批', 'purchased': '已购买', 'arrived': '已到货', 'scrapped': '已报废' };
  return map[status] || status;
}

function statusClass(status) {
  const map = { 'in_stock': 'status-in-stock', 'out_stock': 'status-out-stock', 'pending': 'status-pending', 'approved': 'status-pending', 'purchased': 'status-arrived', 'arrived': 'status-in-stock', 'scrapped': 'status-out-stock' };
  return map[status] || '';
}

async function renderHomePage() {
  const categories = await dbGetAll('categories');
  const items = await dbGetAll('items');
  const purchases = await dbGetAll('purchaseRequests');
  const transactions = await dbGetAll('transactions');

  const grid = document.getElementById('categories-grid');
  grid.innerHTML = '';

  for (const cat of categories) {
    const catItems = items.filter(i => i.categoryId === cat.id);
    const inStock = catItems.filter(i => i.status === 'in_stock').length;
    const outStock = catItems.filter(i => i.status === 'out_stock').length;
    const catPurchases = purchases.filter(p => p.categoryId === cat.id && p.status === 'pending').length;

    const card = document.createElement('div');
    card.className = 'category-card';
    card.onclick = () => openCategoryPage(cat.id);
    card.innerHTML = `
      <div class="category-icon">${cat.icon}</div>
      <div class="category-name">${cat.name}</div>
      <div class="category-description">${cat.description}</div>
      <div class="category-stats">
        <div class="stat-item">
          <span class="stat-label">在库</span>
          <span class="stat-value">${inStock}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">出库</span>
          <span class="stat-value">${outStock}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">待采购</span>
          <span class="stat-value">${catPurchases}</span>
        </div>
      </div>
    `;
    grid.appendChild(card);
  }

  const recentDiv = document.getElementById('recent-activity');
  const recent = transactions.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 10);
  if (recent.length === 0) {
    recentDiv.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📋</div><div class="empty-state-text">暂无动态</div></div>';
  } else {
    let html = '<table><thead><tr><th>时间</th><th>物品</th><th>类型</th><th>操作人</th></tr></thead><tbody>';
    for (const t of recent) {
      const item = await dbGet('items', t.itemId);
      html += '<tr>';
      html += '<td>' + formatDate(t.createdAt) + '</td>';
      html += '<td>' + (item ? item.name : t.itemId) + '</td>';
      html += '<td><span class="status-badge ' + (t.type === 'in' ? 'status-in-stock' : 'status-out-stock') + '">' + (t.type === 'in' ? '入库' : '出库') + '</span></td>';
      html += '<td>' + (t.operator || '-') + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
    recentDiv.innerHTML = html;
  }
}

async function openCategoryPage(categoryId) {
  currentCategoryId = categoryId;
  const category = await dbGet('categories', categoryId);
  const items = await dbGetByIndex('items', 'categoryId', categoryId);

  document.getElementById('category-info').innerHTML = '<h2>' + category.icon + ' ' + category.name + ' <span style="color:#718096;font-size:14px">共 ' + items.length + ' 件物品</span></h2>';

  renderItemsTable(items, category);
  showPage('category');
}

function renderItemsTable(items, category) {
  const tbody = document.getElementById('items-tbody');
  const empty = document.getElementById('items-empty');

  if (items.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  tbody.innerHTML = '';
  for (const item of items) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td><code>' + item.id + '</code></td>' +
      '<td>' + item.name + '</td>' +
      '<td>' + (item.spec || '-') + '</td>' +
      '<td><span class="status-badge ' + statusClass(item.status) + '">' + statusText(item.status) + '</span></td>' +
      '<td>' + (item.location || '-') + '</td>' +
      '<td>' +
        '<button class="btn btn-sm btn-secondary" onclick="showItemDetail(\'' + item.id + '\')">详情</button> ' +
        '<button class="btn btn-sm btn-primary" onclick="showQRCode(\'' + item.id + '\')">二维码</button>' +
      '</td>';
    tbody.appendChild(tr);
  }
}

async function filterItems() {
  const keyword = document.getElementById('item-search').value.toLowerCase();
  const items = await dbGetByIndex('items', 'categoryId', currentCategoryId);
  const category = await dbGet('categories', currentCategoryId);
  const filtered = items.filter(i =>
    i.name.toLowerCase().includes(keyword) ||
    i.id.toLowerCase().includes(keyword) ||
    (i.spec || '').toLowerCase().includes(keyword)
  );
  renderItemsTable(filtered, category);
}

async function showItemDetail(itemId) {
  const item = await dbGet('items', itemId);
  const category = await dbGet('categories', item.categoryId);
  const transactions = await dbGetByIndex('transactions', 'itemId', itemId);
  const sortedTxns = transactions.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));

  let html = '<div style="margin-bottom:20px">';
  html += '<p><strong>编号：</strong><code>' + item.id + '</code></p>';
  html += '<p><strong>名称：</strong>' + item.name + '</p>';
  html += '<p><strong>分类：</strong>' + category.icon + ' ' + category.name + '</p>';
  html += '<p><strong>规格：</strong>' + (item.spec || '-') + '</p>';
  html += '<p><strong>状态：</strong><span class="status-badge ' + statusClass(item.status) + '">' + statusText(item.status) + '</span></p>';
  html += '<p><strong>存放位置：</strong>' + (item.location || '-') + '</p>';
  html += '<p><strong>入库时间：</strong>' + formatDate(item.createdAt) + '</p>';
  html += '<p><strong>备注：</strong>' + (item.remark || '-') + '</p>';

  if (item.extraData && Object.keys(item.extraData).length > 0) {
    html += '<hr style="margin:15px 0;border:none;border-top:1px solid #e2e8f0">';
    html += '<h4 style="margin-bottom:10px">分类专属属性</h4>';
    for (const field of category.extraFields) {
      const val = item.extraData[field.key];
      if (val) {
        html += '<p><strong>' + field.label + '：</strong>' + val + '</p>';
      }
    }
  }

  if (item.purchaseRequestId) {
    const pr = await dbGet('purchaseRequests', item.purchaseRequestId);
    if (pr) {
      html += '<hr style="margin:15px 0;border:none;border-top:1px solid #e2e8f0">';
      html += '<h4 style="margin-bottom:10px">采购信息</h4>';
      html += '<p><strong>采购申请：</strong>' + pr.name + '</p>';
      html += '<p><strong>申请人：</strong>' + (pr.applicant || '-') + '</p>';
      html += '<p><strong>预算：</strong>¥' + (pr.budget || 0) + '</p>';
      const invoices = await dbGetByIndex('invoices', 'purchaseRequestId', item.purchaseRequestId);
      if (invoices.length > 0) {
        const inv = invoices[0];
        html += '<p><strong>发票号：</strong>' + (inv.invoiceNo || '-') + '</p>';
        html += '<p><strong>发票金额：</strong>¥' + (inv.amount || 0) + '</p>';
        html += '<p><strong>供应商：</strong>' + (inv.supplier || '-') + '</p>';
      }
    }
  }

  html += '</div>';

  if (sortedTxns.length > 0) {
    html += '<h4 style="margin-bottom:10px">出入库记录</h4>';
    html += '<table><thead><tr><th>时间</th><th>类型</th><th>操作人</th><th>备注</th></tr></thead><tbody>';
    for (const t of sortedTxns) {
      html += '<tr>';
      html += '<td>' + formatDate(t.createdAt) + '</td>';
      html += '<td><span class="status-badge ' + (t.type === 'in' ? 'status-in-stock' : 'status-out-stock') + '">' + (t.type === 'in' ? '入库' : '出库') + '</span></td>';
      html += '<td>' + (t.operator || '-') + '</td>';
      html += '<td>' + (t.remark || '-') + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
  }

  document.getElementById('item-detail-body').innerHTML = html;
  openModal('modal-item-detail');
}

function showQRCode(itemId) {
  const container = document.getElementById('qrcode-display');
  container.innerHTML = '';
  const qr = qrcode(0, 'M');
  qr.addData(itemId);
  qr.make();
  container.innerHTML = qr.createImgTag(6, 4);
  document.getElementById('qrcode-info').textContent = '物品编号：' + itemId;
  openModal('modal-qrcode');
}

function printQRCode() {
  const info = document.getElementById('qrcode-info').textContent;
  const qrHtml = document.getElementById('qrcode-display').innerHTML;
  const win = window.open('', '_blank');
  win.document.write('<html><head><title>打印二维码</title><style>body{text-align:center;padding:40px;font-family:sans-serif}img{border:1px solid #ccc;padding:10px}.info{margin-top:15px;font-size:14px;color:#666}</style></head><body>');
  win.document.write(qrHtml);
  win.document.write('<div class="info">' + info + '</div>');
  win.document.write('</body></html>');
  win.document.close();
  win.print();
}

function openAddItemModal() {
  document.getElementById('item-name').value = '';
  document.getElementById('item-spec').value = '';
  document.getElementById('item-quantity').value = '1';
  document.getElementById('item-location').value = '';
  document.getElementById('item-remark').value = '';
  document.getElementById('extra-fields-container').innerHTML = '';

  dbGet('categories', currentCategoryId).then(category => {
    let html = '';
    if (category.extraFields && category.extraFields.length > 0) {
      html += '<hr style="margin:20px 0;border:none;border-top:1px solid #e2e8f0">';
      html += '<h4 style="margin-bottom:15px">' + category.name + '专属属性</h4>';
      for (const field of category.extraFields) {
        html += '<div class="form-group">';
        html += '<label class="form-label">' + field.label + '</label>';
        if (field.type === 'select' && field.options) {
          html += '<select class="form-select" data-extra-key="' + field.key + '">';
          html += '<option value="">请选择</option>';
          for (const opt of field.options) {
            html += '<option value="' + opt + '">' + opt + '</option>';
          }
          html += '</select>';
        } else {
          html += '<input type="' + (field.type || 'text') + '" class="form-input" data-extra-key="' + field.key + '" placeholder="' + (field.placeholder || '') + '">';
        }
        html += '</div>';
      }
    }
    document.getElementById('extra-fields-container').innerHTML = html;
    openModal('modal-add-item');
  });
}

async function submitAddItem() {
  const name = document.getElementById('item-name').value.trim();
  const spec = document.getElementById('item-spec').value.trim();
  const quantity = parseInt(document.getElementById('item-quantity').value) || 1;
  const location = document.getElementById('item-location').value.trim();
  const remark = document.getElementById('item-remark').value.trim();

  if (!name) { showToast('请填写物品名称', 'error'); return; }

  const extraData = {};
  document.querySelectorAll('[data-extra-key]').forEach(el => {
    if (el.value) extraData[el.getAttribute('data-extra-key')] = el.value;
  });

  const category = await dbGet('categories', currentCategoryId);
  for (let i = 0; i < quantity; i++) {
    const itemId = generateItemId(currentCategoryId);
    const item = {
      id: itemId,
      categoryId: currentCategoryId,
      name: name,
      spec: spec,
      location: location,
      remark: remark,
      extraData: extraData,
      status: 'in_stock',
      purchaseRequestId: null,
      createdAt: new Date().toISOString()
    };
    await dbAdd('items', item);
    await dbAdd('transactions', {
      itemId: itemId,
      type: 'in',
      operator: '手动添加',
      remark: '新增物品入库',
      createdAt: new Date().toISOString()
    });
  }

  closeModal('modal-add-item');
  showToast('成功添加 ' + quantity + ' 件物品', 'success');
  await openCategoryPage(currentCategoryId);
}

function openPurchaseRequestModal() {
  document.getElementById('pr-name').value = '';
  document.getElementById('pr-spec').value = '';
  document.getElementById('pr-quantity').value = '1';
  document.getElementById('pr-budget').value = '';
  document.getElementById('pr-purpose').value = '';
  document.getElementById('pr-applicant').value = '';

  dbGetAll('categories').then(categories => {
    const sel = document.getElementById('pr-category');
    sel.innerHTML = '';
    for (const cat of categories) {
      const opt = document.createElement('option');
      opt.value = cat.id;
      opt.textContent = cat.icon + ' ' + cat.name;
      sel.appendChild(opt);
    }
    openModal('modal-purchase');
  });
}

async function submitPurchaseRequest() {
  const categoryId = document.getElementById('pr-category').value;
  const name = document.getElementById('pr-name').value.trim();
  const spec = document.getElementById('pr-spec').value.trim();
  const quantity = parseInt(document.getElementById('pr-quantity').value) || 1;
  const budget = parseFloat(document.getElementById('pr-budget').value) || 0;
  const purpose = document.getElementById('pr-purpose').value.trim();
  const applicant = document.getElementById('pr-applicant').value.trim();

  if (!name) { showToast('请填写物品名称', 'error'); return; }

  const pr = {
    categoryId: categoryId,
    name: name,
    spec: spec,
    quantity: quantity,
    budget: budget,
    purpose: purpose,
    applicant: applicant,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  await dbAdd('purchaseRequests', pr);
  closeModal('modal-purchase');
  showToast('采购申请已提交', 'success');
  await renderHomePage();
}

async function openArrivalModal(prId) {
  currentPurchaseId = prId;
  const pr = await dbGet('purchaseRequests', prId);
  const category = await dbGet('categories', pr.categoryId);

  document.getElementById('arrival-info').innerHTML =
    '<p><strong>物品：</strong>' + pr.name + '</p>' +
    '<p><strong>分类：</strong>' + category.icon + ' ' + category.name + '</p>' +
    '<p><strong>规格：</strong>' + (pr.spec || '-') + '</p>' +
    '<p><strong>申请数量：</strong>' + pr.quantity + '</p>';

  document.getElementById('arrival-quantity').value = pr.quantity;
  document.getElementById('arrival-location').value = '';
  document.getElementById('arrival-invoice-no').value = '';
  document.getElementById('arrival-invoice-amount').value = pr.budget || '';
  document.getElementById('arrival-invoice-supplier').value = '';
  document.getElementById('arrival-invoice-date').value = '';

  openModal('modal-arrival');
}

async function confirmArrival() {
  const pr = await dbGet('purchaseRequests', currentPurchaseId);
  const quantity = parseInt(document.getElementById('arrival-quantity').value) || pr.quantity;
  const location = document.getElementById('arrival-location').value.trim();
  const invoiceNo = document.getElementById('arrival-invoice-no').value.trim();
  const invoiceAmount = parseFloat(document.getElementById('arrival-invoice-amount').value) || 0;
  const supplier = document.getElementById('arrival-invoice-supplier').value.trim();
  const invoiceDate = document.getElementById('arrival-invoice-date').value;

  const newItems = [];
  for (let i = 0; i < quantity; i++) {
    const itemId = generateItemId(pr.categoryId);
    const item = {
      id: itemId,
      categoryId: pr.categoryId,
      name: pr.name,
      spec: pr.spec || '',
      location: location,
      remark: '',
      extraData: {},
      status: 'in_stock',
      purchaseRequestId: currentPurchaseId,
      createdAt: new Date().toISOString()
    };
    await dbAdd('items', item);
    await dbAdd('transactions', {
      itemId: itemId,
      type: 'in',
      operator: pr.applicant || '采购到货',
      remark: '采购到货入库',
      createdAt: new Date().toISOString()
    });
    newItems.push(itemId);
  }

  if (invoiceNo || invoiceAmount || supplier) {
    await dbAdd('invoices', {
      purchaseRequestId: currentPurchaseId,
      invoiceNo: invoiceNo,
      amount: invoiceAmount,
      supplier: supplier,
      invoiceDate: invoiceDate,
      createdAt: new Date().toISOString()
    });
  }

  pr.status = 'arrived';
  pr.arrivedAt = new Date().toISOString();
  await dbPut('purchaseRequests', pr);

  closeModal('modal-arrival');
  showToast('已到货入库 ' + quantity + ' 件物品', 'success');
  await renderHomePage();
}

async function approvePurchase(prId) {
  const pr = await dbGet('purchaseRequests', prId);
  pr.status = 'approved';
  await dbPut('purchaseRequests', pr);
  showToast('已审批通过', 'success');
  await renderHomePage();
}

async function markPurchased(prId) {
  const pr = await dbGet('purchaseRequests', prId);
  pr.status = 'purchased';
  await dbPut('purchaseRequests', pr);
  showToast('已标记为已购买', 'success');
  await renderHomePage();
}

async function deletePurchase(prId) {
  if (!confirm('确定删除此采购申请？')) return;
  await dbDelete('purchaseRequests', prId);
  showToast('已删除', 'success');
  await renderHomePage();
}

function openScanModal() {
  document.getElementById('scan-result').style.display = 'none';
  document.getElementById('manual-item-id').value = '';
  currentScanItemId = null;
  openModal('modal-scan');
  startScanner();
}

function closeScanModal() {
  stopScanner();
  closeModal('modal-scan');
}

function startScanner() {
  if (typeof html5Qrcode === 'undefined') {
    const script = document.createElement('script');
    script.src = 'js/lib/html5-qrcode.min.js';
    script.onload = () => initScanner();
    document.head.appendChild(script);
  } else {
    initScanner();
  }
}

function initScanner() {
  if (html5QrCode) { try { html5QrCode.stop(); } catch(e) {} }
  html5QrCode = new Html5Qrcode('qr-reader');
  html5QrCode.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: { width: 250, height: 250 } },
    (decodedText) => {
      handleScannedCode(decodedText);
      stopScanner();
    },
    () => {}
  ).catch(err => {
    document.getElementById('qr-reader').innerHTML = '<p style="color:#a0aec0;text-align:center;padding:40px">无法访问摄像头<br><small>请手动输入物品编号</small></p>';
  });
}

function stopScanner() {
  if (html5QrCode) {
    try { html5QrCode.stop(); } catch(e) {}
  }
}

async function handleScannedCode(code) {
  const item = await dbGet('items', code);
  if (!item) {
    showToast('未找到物品：' + code, 'error');
    return;
  }
  currentScanItemId = code;
  const category = await dbGet('categories', item.categoryId);
  document.getElementById('scan-item-info').innerHTML =
    '<p><strong>编号：</strong><code>' + item.id + '</code></p>' +
    '<p><strong>名称：</strong>' + item.name + '</p>' +
    '<p><strong>分类：</strong>' + category.icon + ' ' + category.name + '</p>' +
    '<p><strong>当前状态：</strong><span class="status-badge ' + statusClass(item.status) + '">' + statusText(item.status) + '</span></p>';
  document.getElementById('scan-result').style.display = 'block';
}

document.getElementById('manual-item-id').addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    const code = e.target.value.trim();
    if (code) await handleScannedCode(code);
  }
});

async function doTransaction(type) {
  if (!currentScanItemId) return;
  const item = await dbGet('items', currentScanItemId);
  if (!item) { showToast('物品不存在', 'error'); return; }

  const operator = document.getElementById('txn-operator').value.trim();
  const remark = document.getElementById('txn-remark').value.trim();

  if (type === 'out' && item.status === 'out_stock') {
    showToast('该物品已在库外', 'error');
    return;
  }
  if (type === 'in' && item.status === 'in_stock') {
    showToast('该物品已在库内', 'error');
    return;
  }

  item.status = type === 'in' ? 'in_stock' : 'out_stock';
  await dbPut('items', item);

  await dbAdd('transactions', {
    itemId: currentScanItemId,
    type: type,
    operator: operator || '-',
    remark: remark || (type === 'in' ? '扫码入库' : '扫码出库'),
    createdAt: new Date().toISOString()
  });

  showToast((type === 'in' ? '入库' : '出库') + '成功', 'success');
  closeScanModal();
  await renderHomePage();
}

init();
