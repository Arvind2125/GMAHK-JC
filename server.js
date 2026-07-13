// 1. WAJIB PALING ATAS! Supaya semua file di bawahnya bisa membaca file .env
require('dotenv').config(); 

const express = require('express');
const path = require('path');
const auditRoutes = require('./routes/auditRoutes');
const authRoutes = require('./routes/authRoutes');
const authController = require('./controllers/authController');
const auditController = require('./controllers/auditController');
const errorMiddleware = require('./middlewares/errorMiddleware');

const app = express();

// 2. Middleware untuk membaca data request (JSON & Form-urlencoded)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 3. Middleware untuk menyajikan file statis publik
app.use('/public', express.static(path.join(__dirname, 'public')));
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'login.html'));
});
app.use('/api/auth', authRoutes);

// Endpoint OnlyOffice dibuat public karena editor dan Document Server perlu akses langsung.
app.get('/api/onlyoffice/report/:id/config', auditController.getOnlyOfficeConfig);
app.post('/api/onlyoffice/report/:id/callback', auditController.handleOnlyOfficeCallback);

// 4. Area aplikasi wajib login admin
app.use(authController.requireAdmin);
app.use(express.static(path.join(__dirname, 'views')));
app.use('/api', auditRoutes);

// 5. Route utama untuk memuat dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

app.use(errorMiddleware);

// 6. Tentukan Port dan Jalankan Server
const PORT = process.env.PORT || 3005;
app.listen(PORT, () => {
    console.log(`Server berjalan lancar di http://localhost:${PORT}`);
});
