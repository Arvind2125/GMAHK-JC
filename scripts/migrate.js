const db = require('../config/db');
const fs = require('fs');
const path = require('path');
const pool = db.promise ? db.promise() : db;

async function migrate() {
  try {
    // Tambah kolom ke audit_reports (MySQL 8+ pakai ADD COLUMN IF NOT EXISTS)
    const alterQueries = [
      'ALTER TABLE audit_reports ADD COLUMN nama_jemaat VARCHAR(150) DEFAULT NULL',
      'ALTER TABLE audit_reports ADD COLUMN tahun_laporan INT DEFAULT NULL',
      'ALTER TABLE audit_reports ADD COLUMN nama_file_asli VARCHAR(255) DEFAULT NULL',
      'ALTER TABLE audit_reports ADD COLUMN file_path VARCHAR(500) DEFAULT NULL'
    ];
    
    for (const q of alterQueries) {
      try { 
        await pool.query(q); 
        console.log('OK: ' + q.substring(0, 70)); 
      } catch(e) { 
        if (e.code === 'ER_DUP_FIELDNAME') {
          console.log('SKIP (kolom sudah ada): ' + q.substring(30, 80));
        } else {
          console.error('ERROR:', e.message);
        }
      }
    }
    
    // Buat tabel jemaat_list
    await pool.query(`
      CREATE TABLE IF NOT EXISTS jemaat_list (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nama_jemaat VARCHAR(150) UNIQUE NOT NULL
      )
    `);
    console.log('OK: CREATE TABLE jemaat_list');
    
    // Buat folder uploads/jemaat jika belum ada
    const uploadsDir = path.join(__dirname, '..', 'public', 'uploads', 'jemaat');
    fs.mkdirSync(uploadsDir, { recursive: true });
    console.log('OK: Folder uploads/jemaat dibuat di ' + uploadsDir);
    
    console.log('\n=== MIGRASI DATABASE BERHASIL ===');
    process.exit(0);
  } catch(err) {
    console.error('FATAL ERROR MIGRASI:', err);
    process.exit(1);
  }
}

migrate();
