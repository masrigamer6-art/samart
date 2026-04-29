require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const mongoose = require('mongoose');
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('cloudinary').v2;
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// --------------------- Cloudinary Configuration ---------------------
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
    allowed_formats: ['jpg', 'png', 'jpeg', 'gif', 'webp'],
    public_id: (req, file) => `product-${Date.now()}-${file.originalname.split('.')[0]}`,
  },
});
const upload = multer({ storage: storage, limits: { fileSize: 5 * 1024 * 1024 } });

// --------------------- MongoDB Connection ---------------------
const mongoURI = process.env.MONGODB_URI || process.env.MONGODB_CONNECT_URL;
if (!mongoURI) {
  console.error('❌ MongoDB URI missing in environment variables');
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
  price: Number,          // in cents (MAD)
  mainCategory: String,   // 'oreille', 'nez', 'nombril', 'micro-dermal'
  subCategory: String,
  image: String,          // Cloudinary URL
});
const Product = mongoose.model('Product', productSchema);

// --------------------- API Routes ---------------------

// GET all products
app.get('/api/products', async (req, res) => {
  try {
    const products = await Product.find({});
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST upload image (to Cloudinary)
app.post('/api/upload', upload.single('productImage'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  // Cloudinary returns the secure URL in req.file.path
  res.json({ imageUrl: req.file.path });
});

// POST add new product (admin only)
app.post('/api/products', async (req, res) => {
  try {
    const { password, name, description, price, mainCategory, subCategory, image } = req.body;
    if (password !== process.env.ADMIN_PASSWORD && password !== 'admin123') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!name || !price || !mainCategory || !image) {
      return res.status(400).json({ error: 'Missing required fields: name, price, mainCategory, image' });
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

// DELETE product (admin only)
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

// Stripe checkout session (currency: MAD)
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
    console.error('Stripe error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Catch-all route to serve index.html for any unmatched route (SPA fallback)


// --------------------- Start Server ---------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
