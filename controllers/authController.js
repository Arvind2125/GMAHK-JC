const crypto = require('crypto');
const db = require('../config/db');
const { getDbErrorMessage, isDbConnectionError } = require('../utils/errorHelpers');

const pool = db.promise ? db.promise() : db;
const COOKIE_NAME = 'gmahk_admin_token';
const SESSION_HOURS = 12;

const parseCookies = (header = '') => {
    return header.split(';').reduce((acc, part) => {
        const idx = part.indexOf('=');
        if (idx === -1) return acc;
        const key = part.slice(0, idx).trim();
        const val = part.slice(idx + 1).trim();
        if (key) acc[key] = decodeURIComponent(val);
        return acc;
    }, {});
};

const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) => {
    const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 64, 'sha512').toString('hex');
    return `${salt}:${hash}`;
};

const verifyPassword = (password, stored) => {
    if (!stored || !stored.includes(':')) return false;
    const [salt, originalHash] = stored.split(':');
    const candidate = hashPassword(password, salt).split(':')[1];
    return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(originalHash, 'hex'));
};

const ensureAuthTables = async () => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS admin_users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(80) UNIQUE NOT NULL,
            email VARCHAR(160) UNIQUE DEFAULT NULL,
            password_hash VARCHAR(255) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS admin_sessions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            admin_id INT NOT NULL,
            token_hash CHAR(64) UNIQUE NOT NULL,
            expires_at DATETIME NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX (admin_id),
            INDEX (expires_at)
        )
    `);
};

const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');

exports.ensureAuthTables = ensureAuthTables;
exports.hashPassword = hashPassword;

exports.requireAdmin = async (req, res, next) => {
    try {
        await ensureAuthTables();
        const cookies = parseCookies(req.headers.cookie || '');
        const token = cookies[COOKIE_NAME];
        if (!token) {
            if (req.path.startsWith('/api')) return res.status(401).json({ message: 'Login admin diperlukan.' });
            return res.redirect('/login');
        }

        const [rows] = await pool.query(`
            SELECT s.id AS session_id, u.id, u.username, u.email
            FROM admin_sessions s
            JOIN admin_users u ON u.id = s.admin_id
            WHERE s.token_hash = ? AND s.expires_at > NOW()
            LIMIT 1
        `, [tokenHash(token)]);

        if (rows.length === 0) {
            res.clearCookie(COOKIE_NAME);
            if (req.path.startsWith('/api')) return res.status(401).json({ message: 'Sesi admin sudah habis. Silakan login ulang.' });
            return res.redirect('/login');
        }

        req.admin = rows[0];
        next();
    } catch (error) {
        next(error);
    }
};

exports.login = async (req, res) => {
    try {
        await ensureAuthTables();
        const { login, password } = req.body;
        if (!login || !password) return res.status(400).json({ message: 'Username/email dan password wajib diisi.' });

        const [users] = await pool.query(
            'SELECT * FROM admin_users WHERE username = ? OR email = ? LIMIT 1',
            [login, login]
        );
        if (users.length === 0 || !verifyPassword(password, users[0].password_hash)) {
            return res.status(401).json({ message: 'Username/email atau password salah.' });
        }

        const token = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000);
        await pool.query(
            'INSERT INTO admin_sessions (admin_id, token_hash, expires_at) VALUES (?, ?, ?)',
            [users[0].id, tokenHash(token), expires]
        );

        res.cookie(COOKIE_NAME, token, {
            httpOnly: true,
            sameSite: 'lax',
            maxAge: SESSION_HOURS * 60 * 60 * 1000
        });
        res.json({ message: 'Login berhasil.', username: users[0].username });
    } catch (error) {
        if (isDbConnectionError(error)) {
            return res.status(503).json({ message: getDbErrorMessage(error) });
        }
        res.status(500).json({ message: error.message });
    }
};

exports.logout = async (req, res) => {
    try {
        const cookies = parseCookies(req.headers.cookie || '');
        const token = cookies[COOKIE_NAME];
        if (token) await pool.query('DELETE FROM admin_sessions WHERE token_hash = ?', [tokenHash(token)]);
        res.clearCookie(COOKIE_NAME);
        res.json({ message: 'Logout berhasil.' });
    } catch (error) {
        if (isDbConnectionError(error)) {
            return res.status(503).json({ message: getDbErrorMessage(error) });
        }
        res.status(500).json({ message: error.message });
    }
};

exports.me = async (req, res) => {
    res.json({ username: req.admin?.username, email: req.admin?.email });
};
