const db = require('../config/db');
const authController = require('../controllers/authController');

const pool = db.promise ? db.promise() : db;

const args = process.argv.slice(2);
const input = Object.fromEntries(args.map(arg => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    return [key, rest.join('=')];
}));

async function main() {
    const username = input.username;
    const email = input.email || null;
    const password = input.password;

    if (!username || !password) {
        console.error('Cara pakai: node scripts/create_admin.js --username=admin --email=admin@example.com --password=PasswordKuat123');
        process.exit(1);
    }

    await authController.ensureAuthTables();
    const passwordHash = authController.hashPassword(password);
    await pool.query(
        `INSERT INTO admin_users (username, email, password_hash)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE email = VALUES(email), password_hash = VALUES(password_hash)`,
        [username, email, passwordHash]
    );

    console.log(`Admin "${username}" berhasil dibuat/diperbarui.`);
    process.exit(0);
}

main().catch(error => {
    console.error(error.message);
    process.exit(1);
});
