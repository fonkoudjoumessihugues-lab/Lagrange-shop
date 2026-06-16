const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ========== BASE DE DONNÉES MÉMOIRE ==========
let users = [];
let shops = [];
let products = [];
let sales = [];
let invoices = [];
let alerts = [];
let transferHistory = [];
let expenses = [];

let invoiceConfig = {
    companyName: "",
    companyAddress: "",
    companyPhone: "",
    companyEmail: "",
    taxRate: 0
};

const ROLES = { USER: 'user', VENDOR: 'vendor', ADMIN: 'admin', SUPER_ADMIN: 'super_admin' };

const auth = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token manquant' });
    try {
        const decoded = jwt.verify(token, 'secretkey123');
        req.userId = decoded.id;
        req.userRole = decoded.role;
        next();
    } catch {
        res.status(401).json({ error: 'Token invalide' });
    }
};

const authorize = (...roles) => (req, res, next) => {
    if (!roles.includes(req.userRole)) return res.status(403).json({ error: 'Permission refusee' });
    next();
};

// ========== AUTHENTIFICATION ==========
app.post('/api/auth/register', async (req, res) => {
    try {
        const { fullName, email, password, promoCode } = req.body;
        if (!fullName || !email || !password) return res.status(400).json({ error: 'Tous les champs sont requis' });
        if (users.find(u => u.email === email)) return res.status(400).json({ error: 'Email deja utilise' });
        const bonus = promoCode === 'LAGRANGE100' ? 100 : 0;
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = {
            id: users.length + 1,
            fullName,
            email,
            password: hashedPassword,
            bonus,
            role: ROLES.USER,
            shopId: null,
            phone: null,
            cni: null,
            address: null,
            hireDate: null,
            commission: 0,
            createdAt: new Date()
        };
        users.push(newUser);
        const token = jwt.sign({ id: newUser.id, role: newUser.role }, 'secretkey123', { expiresIn: '7d' });
        res.status(201).json({ token, user: { id: newUser.id, fullName, email, role: newUser.role, bonus } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = users.find(u => u.email === email);
        if (!user) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
        const token = jwt.sign({ id: user.id, role: user.role }, 'secretkey123', { expiresIn: '7d' });
        res.json({ token, user: { id: user.id, fullName: user.fullName, email, role: user.role, bonus: user.bonus, shopId: user.shopId } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== BOUTIQUES ==========
app.post('/api/shops', auth, authorize(ROLES.USER, ROLES.ADMIN, ROLES.SUPER_ADMIN), (req, res) => {
    const { name, address, phone } = req.body;
    if (!name) return res.status(400).json({ error: 'Nom requis' });
    const shop = { id: shops.length + 1, name, address: address || '', phone: phone || '', ownerId: req.userId, createdAt: new Date() };
    shops.push(shop);
    res.status(201).json(shop);
});

app.get('/api/shops', auth, (req, res) => {
    const user = users.find(u => u.id === req.userId);
    let userShops = [];
    if (user.role === ROLES.VENDOR && user.shopId) {
        const shop = shops.find(s => s.id === user.shopId);
        if (shop) userShops = [shop];
    } else {
        userShops = shops.filter(s => s.ownerId === req.userId);
    }
    res.json(userShops);
});

app.delete('/api/shops/:id', auth, authorize(ROLES.USER, ROLES.ADMIN, ROLES.SUPER_ADMIN), (req, res) => {
    const index = shops.findIndex(s => s.id === parseInt(req.params.id) && s.ownerId === req.userId);
    if (index === -1) return res.status(404).json({ error: 'Boutique non trouvee' });
    shops.splice(index, 1);
    products = products.filter(p => p.shopId !== parseInt(req.params.id));
    res.status(204).send();
});

// ========== PRODUITS ==========
app.post('/api/products', auth, authorize(ROLES.USER, ROLES.ADMIN, ROLES.SUPER_ADMIN), (req, res) => {
    const { name, sellingPrice, quantity, alertThreshold, shopId, barcode } = req.body;
    if (!name || !shopId) return res.status(400).json({ error: 'Nom et boutique requis' });
    const product = { id: products.length + 1, name, sellingPrice: sellingPrice || 0, quantity: quantity || 0, alertThreshold: alertThreshold || 5, shopId: parseInt(shopId), barcode: barcode || null, createdAt: new Date() };
    products.push(product);
    if (product.quantity <= product.alertThreshold) {
        alerts.push({ id: alerts.length + 1, type: 'low_stock', message: `Stock faible : ${product.name} (${product.quantity} restants)`, level: 'warning', shopId: product.shopId, read: false, createdAt: new Date() });
    }
    res.status(201).json(product);
});

app.get('/api/products', auth, (req, res) => {
    const { shopId, barcode } = req.query;
    if (!shopId) return res.status(400).json({ error: 'shopId requis' });
    let filtered = products.filter(p => p.shopId === parseInt(shopId));
    if (barcode) filtered = filtered.filter(p => p.barcode === barcode);
    res.json(filtered);
});

app.delete('/api/products/:id', auth, authorize(ROLES.USER, ROLES.ADMIN, ROLES.SUPER_ADMIN), (req, res) => {
    const index = products.findIndex(p => p.id === parseInt(req.params.id));
    if (index === -1) return res.status(404).json({ error: 'Produit non trouve' });
    products.splice(index, 1);
    res.status(204).send();
});

// ========== ARRIVAGE STOCK ==========
app.post('/api/products/:id/restock', auth, authorize(ROLES.USER, ROLES.ADMIN, ROLES.SUPER_ADMIN), (req, res) => {
    const { quantity } = req.body;
    const id = parseInt(req.params.id);
    const product = products.find(p => p.id === id);
    if (!product) return res.status(404).json({ error: 'Produit non trouvé' });
    if (!quantity || quantity <= 0) return res.status(400).json({ error: 'Quantité invalide' });
    product.quantity += quantity;
    res.json({ message: 'Stock mis à jour', product });
});

// ========== VENTES ==========
app.post('/api/sales', auth, (req, res) => {
    try {
        const { productId, quantity, shopId, customPrice, customerName } = req.body;
        const currentUser = users.find(u => u.id === req.userId);
        if (currentUser.role === ROLES.VENDOR && currentUser.shopId !== shopId) {
            return res.status(403).json({ error: 'Vous ne pouvez vendre que dans votre boutique' });
        }
        const productIndex = products.findIndex(p => p.id === productId && p.shopId === shopId);
        if (productIndex === -1) return res.status(404).json({ error: 'Produit non trouve' });
        if (products[productIndex].quantity < quantity) return res.status(400).json({ error: 'Stock insuffisant' });
        const unitPrice = customPrice || products[productIndex].sellingPrice;
        const subtotal = unitPrice * quantity;
        const tax = subtotal * (invoiceConfig.taxRate / 100);
        const total = subtotal + tax;
        const sale = {
            id: sales.length + 1,
            productId,
            productName: products[productIndex].name,
            quantity,
            unitPrice,
            subtotal,
            tax,
            total,
            sellerId: req.userId,
            sellerName: currentUser.fullName,
            shopId: parseInt(shopId),
            recommendedPrice: products[productIndex].sellingPrice,
            customerName: customerName || 'Client',
            date: new Date(),
            cancelled: false,
            cancelledAt: null,
            cancelledBy: null
        };
        sales.push(sale);
        products[productIndex].quantity -= quantity;
        const invoice = { id: invoices.length + 1, saleId: sale.id, invoiceNumber: `INV-${String(sale.id).padStart(6, '0')}`, total, createdAt: new Date() };
        invoices.push(invoice);
        if (products[productIndex].quantity <= products[productIndex].alertThreshold) {
            alerts.push({ id: alerts.length + 1, type: 'low_stock', message: `${products[productIndex].name} : stock faible (${products[productIndex].quantity})`, level: 'warning', shopId: parseInt(shopId), read: false, createdAt: new Date() });
        }
        let performanceMessage = '';
        if (unitPrice > products[productIndex].sellingPrice) {
            performanceMessage = `Excellent ! Vous avez vendu ${unitPrice - products[productIndex].sellingPrice} FCFA au-dessus du prix recommande. Bravo !`;
        } else if (unitPrice < products[productIndex].sellingPrice) {
            performanceMessage = `Attention : Vous avez vendu ${products[productIndex].sellingPrice - unitPrice} FCFA en dessous du prix recommande.`;
        } else {
            performanceMessage = `Prix respecte. Bon travail !`;
        }
        res.status(201).json({ sale, invoice, performanceMessage });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Annulation de vente (15 min max sauf admin)
app.post('/api/sales/:id/cancel', auth, (req, res) => {
    const saleId = parseInt(req.params.id);
    const sale = sales.find(s => s.id === saleId);
    if (!sale) return res.status(404).json({ error: 'Vente non trouvee' });
    if (sale.cancelled) return res.status(400).json({ error: 'Vente deja annulee' });
    const currentUser = users.find(u => u.id === req.userId);
    const now = new Date();
    const saleDate = new Date(sale.date);
    const diffMinutes = (now - saleDate) / (1000 * 60);
    if (currentUser.role !== ROLES.ADMIN && currentUser.role !== ROLES.SUPER_ADMIN && diffMinutes > 15) {
        return res.status(403).json({ error: 'Delai de 15 minutes depasse. Seul un administrateur peut annuler cette vente.' });
    }
    const product = products.find(p => p.id === sale.productId);
    if (product) product.quantity += sale.quantity;
    sale.cancelled = true;
    sale.cancelledAt = now;
    sale.cancelledBy = currentUser.fullName;
    res.json({ message: 'Vente annulee avec succes', sale });
});

app.get('/api/sales', auth, (req, res) => {
    const { shopId } = req.query;
    const currentUser = users.find(u => u.id === req.userId);
    let filteredSales = sales.filter(s => s.shopId === parseInt(shopId) && !s.cancelled);
    if (currentUser.role === ROLES.VENDOR) filteredSales = filteredSales.filter(s => s.sellerId === req.userId);
    res.json(filteredSales.sort((a, b) => new Date(b.date) - new Date(a.date)));
});

// ========== FACTURES ==========
app.get('/api/invoices', auth, (req, res) => {
    const { shopId } = req.query;
    let filteredInvoices = invoices;
    if (shopId) {
        const saleIds = sales.filter(s => s.shopId === parseInt(shopId)).map(s => s.id);
        filteredInvoices = invoices.filter(inv => saleIds.includes(inv.saleId));
    }
    const result = filteredInvoices.map(inv => {
        const sale = sales.find(s => s.id === inv.saleId);
        return { ...inv, sale };
    });
    res.json(result);
});

// ========== FACTURES PDF ==========
app.get('/api/invoices/:saleId/pdf', auth, (req, res) => {
    const sale = sales.find(s => s.id === parseInt(req.params.saleId));
    if (!sale) return res.status(404).json({ error: 'Vente non trouvee' });
    const product = products.find(p => p.id === sale.productId);
    const shop = shops.find(s => s.id === sale.shopId);
    const seller = users.find(u => u.id === sale.sellerId);
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=facture_${sale.id}.pdf`);
    doc.pipe(res);
    doc.fontSize(22).font('Helvetica-Bold').text(invoiceConfig.companyName || 'Lagrange Shop Manager', { align: 'center' });
    doc.fontSize(10).font('Helvetica').text(invoiceConfig.companyAddress || '', { align: 'center' });
    doc.text(`Tel: ${invoiceConfig.companyPhone || ''} | Email: ${invoiceConfig.companyEmail || ''}`, { align: 'center' });
    doc.moveDown();
    doc.strokeColor('#cccccc').lineWidth(1).moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown();
    doc.fontSize(14).font('Helvetica-Bold').text(sale.cancelled ? 'FACTURE ANNULEE' : 'FACTURE', { align: 'center' });
    if (sale.cancelled) {
        doc.fontSize(10).font('Helvetica').text(`Annulee le ${new Date(sale.cancelledAt).toLocaleString()} par ${sale.cancelledBy}`, { align: 'center' });
    }
    doc.moveDown(0.5);
    doc.fontSize(10).font('Helvetica');
    doc.text(`N° Facture: ${String(sale.id).padStart(6, '0')}`, { align: 'right' });
    doc.text(`Date: ${new Date(sale.date).toLocaleDateString('fr-FR')}`, { align: 'right' });
    doc.moveDown();
    doc.fontSize(10).font('Helvetica-Bold').text('Vendeur:', { continued: true });
    doc.font('Helvetica').text(` ${seller?.fullName || 'N/A'}`);
    doc.text(`Boutique: ${shop?.name || 'N/A'}`);
    doc.text(`Adresse: ${shop?.address || 'N/A'}`);
    doc.moveDown();
    doc.font('Helvetica-Bold').text('Client:');
    doc.font('Helvetica').text(`${sale.customerName || 'Client'}`);
    doc.moveDown();
    doc.strokeColor('#cccccc').lineWidth(1).moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown();
    const col1 = 50, col3 = 300, col4 = 400, col5 = 500;
    doc.font('Helvetica-Bold').fontSize(10);
    doc.text('Designation', col1, doc.y);
    doc.text('Quantite', col3, doc.y);
    doc.text('Prix unit.', col4, doc.y);
    doc.text('Total', col5, doc.y);
    doc.moveDown();
    doc.strokeColor('#cccccc').lineWidth(0.5).moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.font('Helvetica').fontSize(10);
    doc.text(sale.productName, col1, doc.y);
    doc.text(sale.quantity.toString(), col3, doc.y);
    doc.text(`${sale.unitPrice.toLocaleString()} FCFA`, col4, doc.y);
    doc.text(`${sale.subtotal.toLocaleString()} FCFA`, col5, doc.y);
    doc.moveDown(2);
    doc.font('Helvetica-Bold');
    doc.text('Sous-total:', col4, doc.y);
    doc.font('Helvetica');
    doc.text(`${sale.subtotal.toLocaleString()} FCFA`, col5, doc.y);
    if (sale.tax > 0) {
        doc.font('Helvetica-Bold');
        doc.text(`TVA (${invoiceConfig.taxRate}%):`, col4, doc.y);
        doc.font('Helvetica');
        doc.text(`${sale.tax.toLocaleString()} FCFA`, col5, doc.y);
    }
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(12);
    doc.text('TOTAL:', col4, doc.y);
    doc.text(`${sale.total.toLocaleString()} FCFA`, col5, doc.y);
    doc.end();
});

// ========== DEPENSES ==========
app.post('/api/expenses', auth, authorize(ROLES.USER, ROLES.ADMIN, ROLES.SUPER_ADMIN), (req, res) => {
    const { category, amount, date, description, shopId } = req.body;
    if (!category || !amount || !shopId) return res.status(400).json({ error: 'Categorie, montant et boutique requis' });
    const expense = { id: expenses.length + 1, category, amount, date: date || new Date(), description: description || '', shopId: parseInt(shopId), addedBy: req.userId, addedByName: users.find(u => u.id === req.userId)?.fullName, createdAt: new Date() };
    expenses.push(expense);
    res.status(201).json(expense);
});

app.get('/api/expenses', auth, (req, res) => {
    const { shopId, startDate, endDate, category } = req.query;
    let filtered = expenses.filter(e => e.shopId === parseInt(shopId));
    if (startDate) filtered = filtered.filter(e => new Date(e.date) >= new Date(startDate));
    if (endDate) filtered = filtered.filter(e => new Date(e.date) <= new Date(endDate));
    if (category) filtered = filtered.filter(e => e.category === category);
    res.json(filtered.sort((a, b) => new Date(b.date) - new Date(a.date)));
});

app.delete('/api/expenses/:id', auth, authorize(ROLES.USER, ROLES.ADMIN, ROLES.SUPER_ADMIN), (req, res) => {
    const index = expenses.findIndex(e => e.id === parseInt(req.params.id));
    if (index === -1) return res.status(404).json({ error: 'Depense non trouvee' });
    expenses.splice(index, 1);
    res.status(204).send();
});

// ========== VENDEURS ==========
app.post('/api/vendors', auth, authorize(ROLES.USER, ROLES.ADMIN, ROLES.SUPER_ADMIN), async (req, res) => {
    const { email, fullName, phone, cni, address, shopId, commission } = req.body;
    if (!email || !fullName) return res.status(400).json({ error: 'Email et nom requis' });
    if (users.find(u => u.email === email)) return res.status(400).json({ error: 'Email deja utilise' });
    const tempPassword = Math.random().toString(36).slice(-8);
    const hashedPassword = await bcrypt.hash(tempPassword, 10);
    const vendor = { id: users.length + 1, fullName, email, password: hashedPassword, role: ROLES.VENDOR, shopId: parseInt(shopId), phone: phone || null, cni: cni || null, address: address || null, hireDate: new Date(), commission: commission || 0, bonus: 0, createdAt: new Date() };
    users.push(vendor);
    res.status(201).json({ message: `Vendeur invite. Mot de passe : ${tempPassword}`, vendor: { id: vendor.id, fullName, email, phone, cni, address, commission: vendor.commission } });
});

app.get('/api/vendors', auth, (req, res) => {
    const { shopId } = req.query;
    let vendors = users.filter(u => u.role === ROLES.VENDOR);
    if (shopId) vendors = vendors.filter(v => v.shopId === parseInt(shopId));
    res.json(vendors.map(({ password, ...v }) => v));
});

app.put('/api/vendors/:id', auth, authorize(ROLES.USER, ROLES.ADMIN, ROLES.SUPER_ADMIN), (req, res) => {
    const index = users.findIndex(u => u.id === parseInt(req.params.id) && u.role === ROLES.VENDOR);
    if (index === -1) return res.status(404).json({ error: 'Vendeur non trouve' });
    users[index] = { ...users[index], ...req.body };
    res.json({ success: true, vendor: users[index] });
});

app.delete('/api/vendors/:id', auth, authorize(ROLES.USER, ROLES.ADMIN, ROLES.SUPER_ADMIN), (req, res) => {
    const index = users.findIndex(u => u.id === parseInt(req.params.id) && u.role === ROLES.VENDOR);
    if (index === -1) return res.status(404).json({ error: 'Vendeur non trouve' });
    users.splice(index, 1);
    res.status(204).send();
});

// ========== TRANSFERT STOCK ==========
app.post('/api/transfer-stock', auth, authorize(ROLES.USER, ROLES.ADMIN, ROLES.SUPER_ADMIN), (req, res) => {
    const { fromShopId, toShopId, productId, quantity } = req.body;
    const fromProductIndex = products.findIndex(p => p.id === productId && p.shopId === fromShopId);
    if (fromProductIndex === -1) return res.status(404).json({ error: 'Produit source non trouve' });
    if (products[fromProductIndex].quantity < quantity) return res.status(400).json({ error: 'Stock insuffisant' });
    let toProductIndex = products.findIndex(p => p.name === products[fromProductIndex].name && p.shopId === toShopId);
    if (toProductIndex === -1) {
        products.push({ ...products[fromProductIndex], id: products.length + 1, shopId: toShopId, quantity: 0 });
        toProductIndex = products.length - 1;
    }
    products[fromProductIndex].quantity -= quantity;
    products[toProductIndex].quantity += quantity;
    transferHistory.push({ id: transferHistory.length + 1, fromShopId, toShopId, productName: products[fromProductIndex].name, quantity, date: new Date() });
    res.json({ message: 'Transfert effectue' });
});
app.get('/api/transfer-history', auth, (req, res) => { res.json(transferHistory); });

// ========== DASHBOARD ==========
app.get('/api/dashboard/stats', auth, (req, res) => {
    const { shopId } = req.query;
    const shopSales = sales.filter(s => s.shopId === parseInt(shopId) && !s.cancelled);
    const shopProducts = products.filter(p => p.shopId === parseInt(shopId));
    const shopExpenses = expenses.filter(e => e.shopId === parseInt(shopId));
    const now = new Date();
    const today = new Date(now.setHours(0, 0, 0, 0));
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    const startOfWeek = new Date(); startOfWeek.setDate(now.getDate() - 7);
    const salesToday = shopSales.filter(s => new Date(s.date) >= today).length;
    const salesYesterday = shopSales.filter(s => new Date(s.date) >= yesterday && new Date(s.date) < today).length;
    const weeklySales = shopSales.filter(s => new Date(s.date) >= startOfWeek).length;
    const monthlySales = shopSales.length;
    const revenue = shopSales.reduce((sum, s) => sum + s.total, 0);
    const lowStockCount = shopProducts.filter(p => p.quantity > 0 && p.quantity <= p.alertThreshold).length;
    const outOfStockCount = shopProducts.filter(p => p.quantity === 0).length;
    let salesEvolution = 0;
    if (salesYesterday > 0) salesEvolution = ((salesToday - salesYesterday) / salesYesterday) * 100;
    else if (salesToday > 0) salesEvolution = 100;
    const totalExpenses = shopExpenses.reduce((sum, e) => sum + e.amount, 0);
    const netProfit = revenue - totalExpenses;
    const totalSold = shopSales.reduce((sum, s) => sum + s.quantity, 0);
    const avgStock = shopProducts.reduce((sum, p) => sum + p.quantity, 0) / (shopProducts.length || 1);
    const turnoverRate = avgStock > 0 ? totalSold / avgStock : 0;
    const dailyChart = [];
    for (let i = 6; i >= 0; i--) {
        const day = new Date();
        day.setDate(day.getDate() - i);
        day.setHours(0, 0, 0, 0);
        const count = shopSales.filter(s => new Date(s.date) >= day && new Date(s.date) < new Date(day.getTime() + 86400000)).length;
        dailyChart.push({ date: day.toLocaleDateString('fr-FR', { weekday: 'short' }), count });
    }
    const productSales = {};
    shopSales.forEach(s => { productSales[s.productId] = (productSales[s.productId] || 0) + s.quantity; });
    const topProducts = Object.entries(productSales).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, qty]) => ({ name: shopProducts.find(p => p.id === parseInt(id))?.name || 'Inconnu', quantitySold: qty }));
    const sellerSales = {};
    shopSales.forEach(s => { sellerSales[s.sellerId] = (sellerSales[s.sellerId] || 0) + s.total; });
    const topSellers = Object.entries(sellerSales).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, total]) => ({ name: users.find(u => u.id === parseInt(id))?.fullName || 'Inconnu', revenue: total }));
    const expensesByCategory = {};
    shopExpenses.forEach(e => { expensesByCategory[e.category] = (expensesByCategory[e.category] || 0) + e.amount; });
    res.json({ dailySales: salesToday, yesterdaySales: salesYesterday, weeklySales, monthlySales, revenue, salesEvolution, totalExpenses, netProfit, lowStockCount, outOfStockCount, turnoverRate, dailyChart, topProducts, topSellers, expensesByCategory });
});

// ========== IA AVANCEE ==========
app.post('/api/ai/ask', auth, async (req, res) => {
    const { question, shopId } = req.body;
    const lower = question.toLowerCase();
    const shopSales = sales.filter(s => s.shopId === shopId && !s.cancelled);
    const shopProducts = products.filter(p => p.shopId === shopId);
    const shopExpenses = expenses.filter(e => e.shopId === shopId);
    await new Promise(resolve => setTimeout(resolve, 500));
    let answer = "";
    if ((lower.includes('aujourd\'hui') || lower.includes('jour')) && (lower.includes('vente') || lower.includes('vendu'))) {
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
        const todayCount = shopSales.filter(s => new Date(s.date) >= today).length;
        const yesterdayCount = shopSales.filter(s => new Date(s.date) >= yesterday && new Date(s.date) < today).length;
        let evolution = "";
        if (yesterdayCount > 0) {
            const percent = ((todayCount - yesterdayCount) / yesterdayCount) * 100;
            evolution = percent > 0 ? ` (+${percent.toFixed(1)}% par rapport a hier)` : ` (${percent.toFixed(1)}% par rapport a hier)`;
        }
        answer = `📊 Aujourd'hui : ${todayCount} vente(s)${evolution}.`;
        if (yesterdayCount > 0) answer += ` Hier : ${yesterdayCount} vente(s).`;
    }
    else if (lower.includes('hier') && (lower.includes('vente') || lower.includes('vendu'))) {
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
        const count = shopSales.filter(s => new Date(s.date) >= yesterday && new Date(s.date) < today).length;
        answer = `📅 Hier : ${count} vente(s).`;
    }
    else if (lower.includes('produit') && lower.includes('plus vendu')) {
        const productQty = {};
        shopSales.forEach(s => productQty[s.productId] = (productQty[s.productId] || 0) + s.quantity);
        if (Object.keys(productQty).length === 0) answer = "Aucune vente enregistree pour le moment.";
        else {
            const topId = Object.keys(productQty).reduce((a, b) => productQty[a] > productQty[b] ? a : b);
            const product = shopProducts.find(p => p.id === parseInt(topId));
            answer = `🏆 Le produit le plus vendu est "${product?.name || 'Inconnu'}" avec ${productQty[topId]} unites vendues.`;
        }
    }
    else if (lower.includes('meilleur vendeur') || lower.includes('top vendeur')) {
        const sellerSalesMap = {};
        shopSales.forEach(s => sellerSalesMap[s.sellerId] = (sellerSalesMap[s.sellerId] || 0) + s.total);
        if (Object.keys(sellerSalesMap).length === 0) answer = "Aucune vente enregistree pour le moment.";
        else {
            const topId = Object.keys(sellerSalesMap).reduce((a, b) => sellerSalesMap[a] > sellerSalesMap[b] ? a : b);
            const seller = users.find(u => u.id === parseInt(topId));
            answer = `🥇 Le meilleur vendeur est ${seller?.fullName || 'Inconnu'} avec ${sellerSalesMap[topId].toLocaleString()} FCFA de ventes.`;
        }
    }
    else if (lower.includes('commander') || lower.includes('stock') || lower.includes('reapprovisionner')) {
        const low = shopProducts.filter(p => p.quantity <= p.alertThreshold);
        if (low.length === 0) answer = "✅ Votre stock est suffisant pour tous les produits.";
        else answer = `⚠️ Produits a reapprovisionner : ${low.map(p => `${p.name} (${p.quantity} restants)`).join(', ')}.`;
    }
    else if (lower.includes('depense') || lower.includes('depenses')) {
        const totalExpenses = shopExpenses.reduce((sum, e) => sum + e.amount, 0);
        answer = `💰 Total des depenses : ${totalExpenses.toLocaleString()} FCFA.`;
        if (shopExpenses.length > 0) {
            const categories = [...new Set(shopExpenses.map(e => e.category))];
            answer += ` Categories : ${categories.join(', ')}.`;
        }
    }
    else if (lower.includes('benefice') || lower.includes('profit')) {
        const revenue = shopSales.reduce((sum, s) => sum + s.total, 0);
        const totalExpenses = shopExpenses.reduce((sum, e) => sum + e.amount, 0);
        const profit = revenue - totalExpenses;
        answer = `📈 Votre benefice net est de ${profit.toLocaleString()} FCFA. (CA: ${revenue.toLocaleString()} FCFA - Depenses: ${totalExpenses.toLocaleString()} FCFA)`;
    }
    else if (lower.includes('prediction') || lower.includes('demain')) {
        if (shopSales.length < 7) answer = "Pas assez de donnees pour une prediction (minimum 7 jours).";
        else {
            const dailyTotals = {};
            shopSales.forEach(sale => { const date = new Date(sale.date).toISOString().split('T')[0]; dailyTotals[date] = (dailyTotals[date] || 0) + sale.total; });
            const values = Object.values(dailyTotals);
            const last7Avg = values.slice(-7).reduce((a, b) => a + b, 0) / 7;
            const prediction = Math.round(last7Avg * 1.05);
            answer = `🔮 Prediction pour demain : environ ${prediction.toLocaleString()} FCFA de chiffre d'affaires.`;
        }
    }
    else {
        answer = "🤖 Je peux repondre aux questions sur :\n- Ventes (aujourd'hui, hier)\n- Produit le plus vendu\n- Meilleur vendeur\n- Stock / Reapprovisionnement\n- Depenses\n- Benefice net\n- Prediction CA\n\nExemple : 'Combien de ventes aujourd'hui ?'";
    }
    res.json({ answer });
});

// ========== CONFIGURATION FACTURE ==========
app.get('/api/invoice-config', auth, (req, res) => { res.json(invoiceConfig); });
app.post('/api/invoice-config', auth, (req, res) => { invoiceConfig = { ...invoiceConfig, ...req.body }; res.json({ success: true }); });

// ========== ALERTES ==========
app.get('/api/alerts', auth, (req, res) => {
    const { shopId } = req.query;
    res.json(alerts.filter(a => a.shopId === parseInt(shopId)).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});
app.put('/api/alerts/:id/read', auth, (req, res) => {
    const index = alerts.findIndex(a => a.id === parseInt(req.params.id));
    if (index !== -1) alerts[index].read = true;
    res.json({ success: true });
});

// ========== EXPORT ==========
app.get('/api/export/sales', auth, async (req, res) => {
    const { shopId, format = 'csv' } = req.query;
    const shopSales = sales.filter(s => s.shopId === parseInt(shopId) && !s.cancelled);
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Ventes');
    worksheet.columns = [{ header: 'Date', key: 'date', width: 20 }, { header: 'Produit', key: 'product', width: 20 }, { header: 'Client', key: 'customer', width: 20 }, { header: 'Vendeur', key: 'seller', width: 20 }, { header: 'Quantite', key: 'quantity', width: 10 }, { header: 'Prix unitaire', key: 'unitPrice', width: 15 }, { header: 'Total', key: 'total', width: 15 }];
    shopSales.forEach(s => worksheet.addRow({ date: new Date(s.date).toLocaleDateString(), product: s.productName, customer: s.customerName, seller: s.sellerName, quantity: s.quantity, unitPrice: s.unitPrice, total: s.total }));
    if (format === 'csv') { res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', 'attachment; filename=ventes.csv'); await workbook.csv.write(res); }
    else { res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition', 'attachment; filename=ventes.xlsx'); await workbook.xlsx.write(res); }
    res.end();
});
app.get('/api/export/products', auth, async (req, res) => {
    const { shopId, format = 'csv' } = req.query;
    const shopProducts = products.filter(p => p.shopId === parseInt(shopId));
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Produits');
    worksheet.columns = [{ header: 'Nom', key: 'name', width: 20 }, { header: 'Stock', key: 'quantity', width: 10 }, { header: 'Prix vente', key: 'sellingPrice', width: 15 }, { header: 'Seuil alerte', key: 'alertThreshold', width: 12 }];
    shopProducts.forEach(p => worksheet.addRow({ name: p.name, quantity: p.quantity, sellingPrice: p.sellingPrice, alertThreshold: p.alertThreshold }));
    if (format === 'csv') { res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', 'attachment; filename=produits.csv'); await workbook.csv.write(res); }
    else { res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition', 'attachment; filename=produits.xlsx'); await workbook.xlsx.write(res); }
    res.end();
});
app.get('/api/export/expenses', auth, async (req, res) => {
    const { shopId, format = 'csv' } = req.query;
    const shopExpenses = expenses.filter(e => e.shopId === parseInt(shopId));
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Depenses');
    worksheet.columns = [{ header: 'Date', key: 'date', width: 20 }, { header: 'Categorie', key: 'category', width: 20 }, { header: 'Montant', key: 'amount', width: 15 }, { header: 'Description', key: 'description', width: 30 }];
    shopExpenses.forEach(e => worksheet.addRow({ date: new Date(e.date).toLocaleDateString(), category: e.category, amount: e.amount, description: e.description }));
    if (format === 'csv') { res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', 'attachment; filename=depenses.csv'); await workbook.csv.write(res); }
    else { res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition', 'attachment; filename=depenses.xlsx'); await workbook.xlsx.write(res); }
    res.end();
});

// ========== LOGS ==========
app.get('/api/logs', auth, authorize(ROLES.ADMIN, ROLES.SUPER_ADMIN), (req, res) => { res.json(users.map(u => ({ id: u.id, fullName: u.fullName, email: u.email, role: u.role, phone: u.phone, cni: u.cni, address: u.address }))); });

// ========== SANTE ==========
app.get('/api/health', (req, res) => { res.json({ status: 'OK', users: users.length, shops: shops.length, products: products.length, sales: sales.length, expenses: expenses.length }); });

const PORT = 5000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🛒 Lagrange Shop Manager - Serveur demarre`);
    console.log(`📍 http://localhost:${PORT}`);
    console.log(`🔐 Connexion : http://localhost:${PORT}/auth.html`);
});
