require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api', publicRoutes);
app.use('/api/admin', adminRoutes);

// Simple admin panel (password entered client-side, sent as a header on each request)
app.use('/admin', express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`League history API running on port ${PORT}`));
