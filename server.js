require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// --------------------- MongoDB Connection ---------------------
const mongoURI = process.env.MONGODB_CONNECT_URL || process.env.MONGODB_CONNECT_URL;
if (!mongoURI) {
  console.error('❌ MONGODB_CONNECT_URL or MONGODB_URI is missing in .env');
  process.exit(1);
}
mongoose.connect(mongoURI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// --------------------- Product Schema ---------------------
const productSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  name: String,
  description: String,
  price: Number,
  mainCategory: String,
  subCategory: String,
  image: String,
});
const Product = mongoose.model('Product', productSchema);

// --------------------- Local Image Upload ---------------------
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
app.use('/uploads', express.static(uploadDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, unique + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// --------------------- API Routes ---------------------
app.get('/api/products', async (req, res) => {
  try {
    const products = await Product.find({});
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload', upload.single('productImage'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ imageUrl: `/uploads/${req.file.filename}` });
});

app.post('/api/products', async (req, res) => {
  try {
    const { password, name, description, price, mainCategory, subCategory, image } = req.body;
    if (password !== process.env.ADMIN_PASSWORD && password !== 'admin123') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!name || !price || !mainCategory || !image) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const priceCents = Math.round(parseFloat(price) * 100);
    const newProduct = new Product({
      id: Date.now().toString(),
      name,
      description: description || '',
      price: priceCents,
      mainCategory,
      subCategory: subCategory || '',
      image,
    });
    await newProduct.save();
    res.json({ success: true, product: newProduct });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const cartItems = req.body.items;
    if (!cartItems || cartItems.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }
    const products = await Product.find({});
    const lineItems = cartItems.map(item => {
      const product = products.find(p => p.id === item.id);
      if (!product) throw new Error(`Product ${item.id} not found`);
      return {
        price_data: {
          currency: 'mad',
          product_data: { name: product.name, description: product.description },
          unit_amount: product.price,
        },
        quantity: item.quantity,
      };
    });
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${req.headers.origin}/success.html`,
      cancel_url: `${req.headers.origin}/cancel.html`,
    });
    res.json({ url: session.url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Corrected catch-all route: The wildcard must be named.
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
