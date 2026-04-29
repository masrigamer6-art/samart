require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ensure uploads folder exists
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
app.use('/uploads', express.static(uploadDir));

// multer disk storage (local)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, unique + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// products.json file
const PRODUCTS_FILE = path.join(__dirname, 'products.json');

function loadProducts() {
  if (!fs.existsSync(PRODUCTS_FILE)) {
    const defaultProducts = [
      { id: '1', name: 'Lobe Or', description: 'Créole dorée', price: 2499, mainCategory: 'oreille', subCategory: 'lobe', image: '/uploads/default-lobe.jpg' },
      { id: '2', name: 'Helix Étoile', description: 'Acier chirurgical', price: 1899, mainCategory: 'oreille', subCategory: 'helix', image: '/uploads/default-helix.jpg' },
      { id: '3', name: 'Tragus Opale', description: 'Bioflex', price: 1599, mainCategory: 'oreille', subCategory: 'tragus', image: '/uploads/default-tragus.jpg' },
      { id: '4', name: 'Nostril Or Rose', description: 'Stud discret', price: 999, mainCategory: 'nez', subCategory: 'nostril', image: '/uploads/default-nostril.jpg' },
      { id: '5', name: 'Septum Anneau', description: 'Titane noir', price: 2799, mainCategory: 'nez', subCategory: 'septum', image: '/uploads/default-septum.jpg' },
      { id: '6', name: 'Nombril Dangle', description: 'Or 14k', price: 4500, mainCategory: 'nombril', subCategory: '', image: '/uploads/default-belly.jpg' },
      { id: '7', name: 'Micro dermal Étoile', description: 'Surface piercing', price: 3200, mainCategory: 'micro-dermal', subCategory: '', image: '/uploads/default-dermal.jpg' }
    ];
    fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(defaultProducts, null, 2));
    return defaultProducts;
  }
  return JSON.parse(fs.readFileSync(PRODUCTS_FILE));
}

function saveProducts(products) {
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2));
}

let products = loadProducts();

// API routes
app.get('/api/products', (req, res) => res.json(products));

app.post('/api/upload', upload.single('productImage'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ imageUrl: `/uploads/${req.file.filename}` });
});

app.post('/api/products', (req, res) => {
  const { password, name, description, price, mainCategory, subCategory, image } = req.body;
  // Simple password check
  if (password !== process.env.ADMIN_PASSWORD && password !== 'admin123')
    return res.status(401).json({ error: 'Unauthorized' });
  
  // Validate required fields (mainCategory instead of category)
  if (!name || !price || !mainCategory || !image) {
    return res.status(400).json({ error: 'Missing fields: name, price, mainCategory, image are required' });
  }
  
  const priceCents = Math.round(parseFloat(price) * 100);
  const newProduct = {
    id: Date.now().toString(),
    name,
    description: description || '',
    price: priceCents,
    mainCategory,
    subCategory: subCategory || '',
    image
  };
  products.push(newProduct);
  saveProducts(products);
  res.json({ success: true, product: newProduct });
});

app.delete('/api/products/:id', (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD && password !== 'admin123')
    return res.status(401).json({ error: 'Unauthorized' });
  const id = req.params.id;
  products = products.filter(p => p.id !== id);
  saveProducts(products);
  res.json({ success: true });
});

app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const cartItems = req.body.items;
    if (!cartItems || cartItems.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));