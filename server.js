require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('cloudinary').v2;
const PDFDocument = require('pdfkit');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// --------------------- Cloudinary ---------------------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'samar-piercing',
    allowed_formats: ['jpg', 'png', 'jpeg', 'gif', 'webp', 'avif'],
    public_id: (req, file) => `product-${Date.now()}-${file.originalname.split('.')[0]}`,
  },
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// --------------------- MongoDB ---------------------
const mongoURI = process.env.MONGODB_URI || process.env.MONGODB_CONNECT_URL;
if (!mongoURI) {
  console.error('❌ MongoDB URI missing');
  process.exit(1);
}
mongoose.connect(mongoURI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// Product schema with images array (compatible with old 'image' field)
const productSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  name: String,
  description: String,
  price: Number,
  mainCategory: String,
  subCategory: String,
  image: String,        // old field – kept for backward compatibility
  images: [String],     // new array field
});
const Product = mongoose.model('Product', productSchema);

// Migrate old products on startup: convert 'image' to 'images' if not already
async function migrateOldProducts() {
  const products = await Product.find({ images: { $exists: false } });
  for (const prod of products) {
    if (prod.image) {
      prod.images = [prod.image];
      await prod.save();
      console.log(`Migrated product: ${prod.name}`);
    } else {
      prod.images = [];
      await prod.save();
    }
  }
  // Also ensure all products have at least an empty images array
  await Product.updateMany({ images: { $exists: false } }, { $set: { images: [] } });
}
migrateOldProducts().catch(console.error);

// Orders directory
const ordersDir = path.join(__dirname, 'orders');
if (!fs.existsSync(ordersDir)) fs.mkdirSync(ordersDir);
app.use('/orders', express.static(ordersDir));

// --------------------- API Routes ---------------------

// GET all products – add a virtual field 'image' for frontend compatibility
app.get('/api/products', async (req, res) => {
  try {
    const products = await Product.find({});
    // attach a virtual 'image' = first image in array for backward compatibility
    const productsWithImage = products.map(p => ({
      ...p.toObject(),
      image: p.images && p.images.length ? p.images[0] : null,
    }));
    res.json(productsWithImage);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UPLOAD multiple images (admin)
app.post('/api/upload-multiple', (req, res) => {
  upload.array('productImages', 4)(req, res, (err) => {
    if (err) {
      console.error('Upload error:', err);
      return res.status(400).json({ error: err.message });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }
    const imageUrls = req.files.map(file => file.path);
    res.json({ imageUrls });
  });
});

// POST add new product (admin) – now accepts 'images' array
app.post('/api/products', async (req, res) => {
  try {
    const { password, name, description, price, mainCategory, subCategory, images } = req.body;
    if (password !== process.env.ADMIN_PASSWORD && password !== 'admin123') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!name || !price || !mainCategory || !images || !images.length) {
      return res.status(400).json({ error: 'Missing required fields: name, price, mainCategory, at least one image' });
    }
    const priceCents = Math.round(parseFloat(price) * 100);
    const newProduct = new Product({
      id: Date.now().toString(),
      name: String(name),
      description: description || '',
      price: priceCents,
      mainCategory: String(mainCategory),
      subCategory: subCategory || '',
      images: images.slice(0, 4),
    });
    await newProduct.save();
    res.json({ success: true, product: newProduct });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE product
app.delete('/api/products/:id', async (req, res) => {
  try {
    const { password } = req.body;
    if (password !== process.env.ADMIN_PASSWORD && password !== 'admin123') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    await Product.findOneAndDelete({ id: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify admin password
app.post('/api/verify-admin', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD || password === 'admin123') {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Invalid password' });
  }
});

// Generate order PDF (uses first image from 'images' array)
app.post('/api/create-order-pdf', async (req, res) => {
  try {
    const { cartItems } = req.body;
    if (!cartItems || cartItems.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    const orderId = Date.now();
    const filename = `order-${orderId}.pdf`;
    const filePath = path.join(ordersDir, filename);

    const doc = new PDFDocument({ margin: 50 });
    const writeStream = fs.createWriteStream(filePath);
    doc.pipe(writeStream);

    doc.fontSize(20).text('Samar Piercing - Order Summary', { align: 'center' });
    doc.moveDown();
    doc.fontSize(10).text(`Order ID: ${orderId}`, { align: 'right' });
    doc.text(`Date: ${new Date().toLocaleString()}`, { align: 'right' });
    doc.moveDown();

    let grandTotal = 0;
    let startY = doc.y;

    for (const item of cartItems) {
      const priceMAD = item.price / 100;
      const total = priceMAD * item.quantity;
      grandTotal += total;

      let imageBuffer = null;
      const primaryImage = item.image; // cart items send 'image' field (first image)
      if (primaryImage && (primaryImage.startsWith('http://') || primaryImage.startsWith('https://'))) {
        try {
          const response = await axios.get(primaryImage, { responseType: 'arraybuffer', timeout: 10000 });
          imageBuffer = Buffer.from(response.data, 'utf-8');
        } catch (err) {
          console.error(`Failed to load image for ${item.name}:`, err.message);
        }
      }

      const imageX = 50;
      const imageY = startY;
      if (imageBuffer) {
        try {
          doc.image(imageBuffer, imageX, imageY, { width: 50, height: 50 });
        } catch (err) { /* ignore */ }
      }

      const textX = imageX + 60;
      doc.font('Helvetica').fontSize(10);
      doc.text(item.name, textX, startY);
      doc.text(`Qty: ${item.quantity}`, textX, startY + 15);
      doc.text(`Price: ${priceMAD.toFixed(2)} MAD`, textX, startY + 30);
      doc.text(`Total: ${total.toFixed(2)} MAD`, textX, startY + 45);

      startY += 70;
      if (startY > 700) {
        doc.addPage();
        startY = 50;
      }
    }

    doc.font('Helvetica-Bold').fontSize(14);
    doc.text(`Grand Total: ${grandTotal.toFixed(2)} MAD`, 50, startY + 20);
    doc.fontSize(10).text('Thank you for shopping at Samar Piercing!', 50, startY + 60);
    doc.text('Payment will be arranged via WhatsApp. Please confirm your order.', 50, startY + 75);

    doc.end();
    await new Promise((resolve) => writeStream.on('finish', resolve));

    const pdfUrl = `${req.protocol}://${req.get('host')}/orders/${filename}`;
    res.json({ success: true, pdfUrl, orderId });
  } catch (error) {
    console.error('PDF generation error:', error);
    res.status(500).json({ error: 'Failed to generate order PDF' });
  }
});

// --------------------- Clean URLs ---------------------
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/cart', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cart.html')));
app.get('/success', (req, res) => res.sendFile(path.join(__dirname, 'public', 'success.html')));
app.get('/cancel', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cancel.html')));
app.get('/admin.html', (req, res) => res.redirect(301, '/admin'));
app.get('/cart.html', (req, res) => res.redirect(301, '/cart'));
app.get('/success.html', (req, res) => res.redirect(301, '/success'));
app.get('/cancel.html', (req, res) => res.redirect(301, '/cancel'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
