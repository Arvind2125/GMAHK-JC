const mysql = require('mysql2');
require('dotenv').config();

const cleanEnv = (value, fallback = undefined) => {
    if (value === undefined || value === null || value === '') return fallback;
    return String(value).trim();
};

const pool = mysql.createPool({
    host: cleanEnv(process.env.DB_HOST, '127.0.0.1'),
    port: Number(cleanEnv(process.env.DB_PORT, 3306)),
    user: cleanEnv(process.env.DB_USER),
    password: cleanEnv(process.env.DB_PASSWORD, ''),
    database: cleanEnv(process.env.DB_NAME),
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = pool.promise();
