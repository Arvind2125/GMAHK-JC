const xlsx = require('xlsx');
const db = require('../config/db');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const pool = db.promise ? db.promise() : db;
const TEMPLATE_FILE_PATH = path.join(__dirname, '..', 'public', 'templates', 'laporan-keuangan-template.xlsx');

// ======================== HELPER FUNCTIONS ========================

const normalizeJemaatName = (value) => {
    return String(value || '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
};

const titleCaseJemaatName = (value) => {
    return normalizeJemaatName(value)
        .split(' ')
        .filter(Boolean)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
};

const parseExcelNumber = (val) => {
    if (val === undefined || val === null || val === '') return 0;
    if (typeof val === 'number') return val;
    let cleanVal = val.toString().replace(/Rp/g, '').replace(/[\s\-]/g, '');
    cleanVal = cleanVal.replace(/[\/,\.]/g, '');
    const parsed = parseFloat(cleanVal);
    return isNaN(parsed) ? 0 : parsed;
};

const parseExcelDate = (val, defaultYear) => {
    if (!val) return new Date();
    if (val instanceof Date) return val;
    if (typeof val === 'number') {
        const date = new Date((val - 25569) * 86400 * 1000);
        return isNaN(date.getTime()) ? new Date() : date;
    }
    const str = String(val).toLowerCase().trim();
    const months = {
        januari: 0, februari: 1, maret: 2, april: 3, mei: 4, juni: 5,
        juli: 6, agustus: 7, september: 8, oktober: 9, november: 10, desember: 11,
        jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, okt: 9, nov: 10, des: 11
    };
    if (months[str] !== undefined) {
        const targetYear = defaultYear || 2023;
        return new Date(targetYear, months[str], 1);
    }
    const parsedDate = new Date(str);
    return isNaN(parsedDate.getTime()) ? new Date() : parsedDate;
};

const safeFileNamePart = (value, fallback) => {
    const cleaned = String(value || '')
        .trim()
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned || fallback;
};

const getReportFilePath = async (id) => {
    const [reports] = await pool.query(
        'SELECT file_path, nama_file_asli, nama_report FROM audit_reports WHERE id = ?',
        [id]
    );
    if (reports.length === 0) return null;
    const report = reports[0];
    const filePath = report.file_path
        ? path.join(__dirname, '..', 'public', report.file_path)
        : null;
    return { report, filePath };
};

const getFileStatVersion = (filePath) => {
    try {
        const stat = fs.statSync(filePath);
        return `${stat.size}-${Math.floor(stat.mtimeMs)}`;
    } catch (error) {
        return Date.now().toString();
    }
};

const getPublicBaseUrl = (req) => {
    return (process.env.ONLYOFFICE_PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
};

const getOnlyOfficeServerUrl = () => {
    return String(process.env.ONLYOFFICE_DOCUMENT_SERVER_URL || '').replace(/\/+$/, '');
};

const fetchText = (url) => new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, (response) => {
        if ([301, 302, 307, 308].includes(response.statusCode) && response.headers.location) {
            response.resume();
            return fetchText(response.headers.location).then(resolve, reject);
        }

        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
            body += chunk;
            if (body.length > 4096) {
                response.destroy();
            }
        });
        response.on('close', () => {
            resolve({
                statusCode: response.statusCode,
                headers: response.headers,
                body
            });
        });
    });

    request.setTimeout(5000, () => {
        request.destroy(new Error('Timeout saat menghubungi OnlyOffice Document Server.'));
    });
    request.on('error', reject);
});

const probeOnlyOfficeScript = async (documentServerUrl) => {
    const scriptUrl = `${documentServerUrl}/web-apps/apps/api/documents/api.js`;
    try {
        const response = await fetchText(scriptUrl);
        const contentType = String(response.headers['content-type'] || '').toLowerCase();
        const looksLikeHtml = String(response.body || '').trim().startsWith('<');

        if (response.statusCode < 200 || response.statusCode >= 300) {
            return {
                ok: false,
                scriptUrl,
                message: `OnlyOffice Document Server merespons status ${response.statusCode}.`
            };
        }

        if (looksLikeHtml) {
            return {
                ok: false,
                scriptUrl,
                message: 'OnlyOffice Document Server mengembalikan HTML, bukan file JavaScript editor.'
            };
        }

        if (contentType && !contentType.includes('javascript') && !contentType.includes('text/plain') && !contentType.includes('application/octet-stream')) {
            return {
                ok: false,
                scriptUrl,
                message: `Content-Type OnlyOffice tidak sesuai: ${contentType}.`
            };
        }

        return { ok: true, scriptUrl };
    } catch (error) {
        return {
            ok: false,
            scriptUrl,
            message: error.message
        };
    }
};

const buildOnlyOfficeKey = (id, filePath) => {
    return crypto
        .createHash('sha256')
        .update(`${id}:${filePath}:${getFileStatVersion(filePath)}`)
        .digest('hex');
};

const signJwtHs256 = (payload, secret) => {
    const encode = (obj) => Buffer.from(JSON.stringify(obj))
        .toString('base64url');
    const header = encode({ alg: 'HS256', typ: 'JWT' });
    const body = encode(payload);
    const signature = crypto
        .createHmac('sha256', secret)
        .update(`${header}.${body}`)
        .digest('base64url');
    return `${header}.${body}.${signature}`;
};

const downloadToFile = (url, targetPath) => new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, (response) => {
        if ([301, 302, 307, 308].includes(response.statusCode) && response.headers.location) {
            response.resume();
            return downloadToFile(response.headers.location, targetPath).then(resolve, reject);
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
            response.resume();
            return reject(new Error(`OnlyOffice mengirim status ${response.statusCode} saat mengambil file hasil edit.`));
        }
        const tempPath = `${targetPath}.onlyoffice-${Date.now()}.tmp`;
        const file = fs.createWriteStream(tempPath);
        response.pipe(file);
        file.on('finish', () => {
            file.close(() => {
                fs.copyFileSync(tempPath, targetPath);
                fs.unlinkSync(tempPath);
                resolve();
            });
        });
        file.on('error', (error) => {
            fs.rm(tempPath, { force: true }, () => reject(error));
        });
    });
    request.on('error', reject);
});

// ======================== UPLOAD & PROCESS EXCEL ========================

exports.uploadAndProcessExcel = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: 'Mohon upload file Excel terlebih dahulu.' });

        // Ambil nama jemaat & tahun dari form (case-insensitive untuk nama jemaat)
        const namaJemaat = normalizeJemaatName(req.body.nama_jemaat);
        const tahunLaporan = parseInt(req.body.tahun_laporan) || new Date().getFullYear();
        const namaFileAsli = req.file.originalname;

        console.log(`\n======================================================`);
        console.log(`[Upload] File: ${namaFileAsli}`);
        console.log(`[Upload] Jemaat: "${namaJemaat}" | Tahun: ${tahunLaporan}`);
        console.log(`======================================================`);

        // Buat folder klasifikasi: public/uploads/jemaat/{nama_jemaat}/{tahun}/
        const folderJemaat = path.join(__dirname, '..', 'public', 'uploads', 'jemaat',
            namaJemaat || 'tanpa-nama', String(tahunLaporan));
        fs.mkdirSync(folderJemaat, { recursive: true });

        // Simpan file fisik dengan nama asli (jika sudah ada, tambah timestamp)
        let targetFileName = namaFileAsli;
        let targetPath = path.join(folderJemaat, targetFileName);
        if (fs.existsSync(targetPath)) {
            const ext = path.extname(namaFileAsli);
            const base = path.basename(namaFileAsli, ext);
            targetFileName = `${base}_${Date.now()}${ext}`;
            targetPath = path.join(folderJemaat, targetFileName);
        }
        fs.copyFileSync(req.file.path, targetPath);
        fs.unlinkSync(req.file.path);
        console.log(`[Upload] File disimpan ke: ${targetPath}`);

        // Hitung path relatif untuk disimpan di DB
        const relativePath = path.relative(
            path.join(__dirname, '..', 'public'),
            targetPath
        ).replace(/\\/g, '/');

        // Baca workbook dari file yang sudah disimpan
        const workbook = xlsx.readFile(targetPath);

        // Inisialisasi laporan di DB
        const [reportResult] = await pool.query(
            `INSERT INTO audit_reports 
             (nama_report, total_debit, total_kredit, selisih, status_audit, nama_jemaat, tahun_laporan, nama_file_asli, file_path)
             VALUES (?, 0, 0, 0, ?, ?, ?, ?, ?)`,
            [
                namaFileAsli.replace(/\.[^/.]+$/, ''), // nama tanpa ekstensi
                'Proses',
                namaJemaat || null,
                tahunLaporan,
                namaFileAsli,
                relativePath
            ]
        );
        const reportId = reportResult.insertId;

        // Simpan/update nama jemaat ke tabel jemaat_list
        if (namaJemaat) {
            await pool.query(
                'INSERT IGNORE INTO jemaat_list (nama_jemaat) VALUES (?)',
                [namaJemaat]
            );
        }

        let totalDebit = 0;
        let totalKredit = 0;
        let totalRowsProcessed = 0;

        for (let sheetName of workbook.SheetNames) {
            const nameLower = sheetName.toLowerCase().trim();
            if (nameLower === 'ringkasan' || nameLower === 'anjuran' || nameLower === 'grafik') {
                console.log(`[Excel] Skip sheet non-data: ${sheetName}`);
                continue;
            }

            const sheet = workbook.Sheets[sheetName];
            const rawRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: "" });

            if (rawRows.length === 0) continue;
            console.log(`[Excel] Sheet: "${sheetName}" (${rawRows.length} baris)`);

            let headerRowIdx = -1;
            let maxMatches = 0;
            let columns = [];

            for (let i = 0; i < Math.min(rawRows.length, 30); i++) {
                const row = rawRows[i];
                if (!row || !Array.isArray(row)) continue;
                let currentColumns = [];
                let matches = 0;
                for (let j = 0; j < row.length; j++) {
                    const cellStr = String(row[j]).toLowerCase().trim();
                    if (!cellStr) continue;
                    let type = null;
                    if (cellStr.includes('tanggal') || cellStr.includes('tgl') || cellStr.includes('bulan') || cellStr === 'x / t') {
                        type = 'tanggal'; matches++;
                    } else if (cellStr.includes('keterangan') || cellStr.includes('uraian') || cellStr.includes('items') || cellStr.includes('kwitansi') || cellStr.includes('rincian')) {
                        type = 'keterangan'; matches++;
                    } else if (cellStr.includes('kategori') || cellStr.includes('dana') || cellStr.includes('pos ')) {
                        type = 'kategori'; matches++;
                    } else if (cellStr.includes('debit') || cellStr.includes('debet') || cellStr.includes('masuk') || cellStr.includes('penerimaan') || cellStr.includes('perpul') || cellStr.includes('terpadu') || cellStr === 'in') {
                        type = 'debit'; matches++;
                    } else if (cellStr.includes('kredit') || cellStr.includes('keluar') || cellStr.includes('pengeluaran') || cellStr.includes('expense') || cellStr === 'out') {
                        type = 'kredit'; matches++;
                    }
                    if (type) currentColumns.push({ index: j, type, label: cellStr });
                }
                if (matches > maxMatches) {
                    maxMatches = matches; headerRowIdx = i; columns = currentColumns;
                }
            }

            if (headerRowIdx === -1) {
                columns = [
                    { index: 0, type: 'tanggal', label: 'default_tgl' },
                    { index: 1, type: 'keterangan', label: 'default_ket' },
                    { index: 2, type: 'debit', label: 'default_debit' },
                    { index: 3, type: 'kredit', label: 'default_kredit' }
                ];
            }

            const startRow = headerRowIdx === -1 ? 0 : headerRowIdx + 1;
            let sheetRowsProcessed = 0;

            for (let i = startRow; i < rawRows.length; i++) {
                const row = rawRows[i];
                if (!row || row.length === 0) continue;
                let isSummaryRow = false;
                for (let cell of row) {
                    const valStr = String(cell).toLowerCase().trim();
                    if (valStr === 'total' || valStr === 'jumlah' || valStr.includes('grand total') || valStr.includes('saldo akhir')) {
                        isSummaryRow = true; break;
                    }
                }
                if (isSummaryRow) continue;

                let debitVal = 0, kreditVal = 0;
                let tanggalVal = null, keteranganVal = "", kategoriVal = "Dana Jemaat";
                let hasValidData = false;
                let ketParts = [];

                for (let col of columns) {
                    if (col.index >= row.length) continue;
                    const cellValue = row[col.index];
                    if (cellValue === undefined || cellValue === null || cellValue === '') continue;
                    if (col.type === 'tanggal' && !tanggalVal) tanggalVal = parseExcelDate(cellValue, tahunLaporan);
                    else if (col.type === 'keterangan') ketParts.push(String(cellValue));
                    else if (col.type === 'kategori') kategoriVal = String(cellValue);
                }
                if (ketParts.length > 0) keteranganVal = ketParts.join(' - ');
                if (!tanggalVal) tanggalVal = new Date(tahunLaporan, 0, 1);

                let hasTotalDebit = false, hasTotalKredit = false;
                for (let col of columns) {
                    if (col.index >= row.length) continue;
                    const amt = parseExcelNumber(row[col.index]);
                    if (amt <= 0) continue;
                    const lbl = col.label;
                    if (col.type === 'debit' && (lbl.includes('total') || lbl.includes('penerimaan'))) {
                        debitVal = amt; hasTotalDebit = true; hasValidData = true;
                    }
                    if (col.type === 'kredit' && (lbl.includes('total') || lbl.includes('pengeluaran'))) {
                        kreditVal = amt; hasTotalKredit = true; hasValidData = true;
                    }
                }
                for (let col of columns) {
                    if (col.index >= row.length) continue;
                    const amt = parseExcelNumber(row[col.index]);
                    if (amt <= 0) continue;
                    const lbl = col.label;
                    if (col.type === 'debit' && !hasTotalDebit && !lbl.includes('total')) {
                        debitVal += amt; hasValidData = true;
                    }
                    if (col.type === 'kredit' && !hasTotalKredit && !lbl.includes('total')) {
                        kreditVal += amt; hasValidData = true;
                    }
                }

                if (hasValidData) {
                    totalDebit += debitVal;
                    totalKredit += kreditVal;
                    totalRowsProcessed++;
                    sheetRowsProcessed++;
                    await pool.query(
                        'INSERT INTO audit_raw_data (report_id, tanggal, keterangan, debit, kredit, kategori) VALUES (?, ?, ?, ?, ?, ?)',
                        [reportId, tanggalVal, keteranganVal, debitVal, kreditVal, kategoriVal]
                    );
                }
            }
            console.log(`[Excel] Sheet "${sheetName}": ${sheetRowsProcessed} transaksi disimpan`);
        }

        const selisih = totalDebit - totalKredit;
        const statusAudit = selisih === 0 ? 'Balance' : 'Selisih / Perlu Cek';
        const namaReportFinal = namaFileAsli.replace(/\.[^/.]+$/, '');

        await pool.query(
            `UPDATE audit_reports SET nama_report = ?, total_debit = ?, total_kredit = ?, selisih = ?, status_audit = ? WHERE id = ?`,
            [namaReportFinal, totalDebit, totalKredit, selisih, statusAudit, reportId]
        );

        console.log(`\n=== UPLOAD SELESAI: ${totalRowsProcessed} record, ID #${reportId} ===\n`);
        res.status(200).json({
            message: `Berhasil menyimpan "${namaFileAsli}" untuk jemaat "${namaJemaat || 'Umum'}" tahun ${tahunLaporan}. (${totalRowsProcessed} transaksi diproses)`,
            reportId
        });
    } catch (error) {
        console.error("Error uploadAndProcessExcel:", error);
        res.status(500).json({ message: 'Terjadi kesalahan: ' + error.message });
    }
};

// ======================== BUAT LAPORAN BARU DARI TEMPLATE ========================

exports.createReportFromTemplate = async (req, res) => {
    try {
        const namaJemaat = normalizeJemaatName(req.body.nama_jemaat);
        const tahunLaporan = parseInt(req.body.tahun_laporan) || new Date().getFullYear();
        const namaLaporan = safeFileNamePart(req.body.nama_laporan, `${titleCaseJemaatName(namaJemaat) || 'Laporan'} ${tahunLaporan}`);

        if (!namaJemaat) {
            return res.status(400).json({ message: 'Nama jemaat wajib diisi.' });
        }
        if (!fs.existsSync(TEMPLATE_FILE_PATH)) {
            return res.status(500).json({ message: 'Template Excel belum tersedia di server.' });
        }

        const folderJemaat = path.join(
            __dirname,
            '..',
            'public',
            'uploads',
            'jemaat',
            namaJemaat || 'tanpa-nama',
            String(tahunLaporan)
        );
        fs.mkdirSync(folderJemaat, { recursive: true });

        const ext = '.xlsx';
        const baseName = `${safeFileNamePart(namaLaporan, 'Laporan Keuangan')} - ${tahunLaporan}`;
        let targetFileName = `${baseName}${ext}`;
        let targetPath = path.join(folderJemaat, targetFileName);
        if (fs.existsSync(targetPath)) {
            targetFileName = `${baseName}_${Date.now()}${ext}`;
            targetPath = path.join(folderJemaat, targetFileName);
        }

        fs.copyFileSync(TEMPLATE_FILE_PATH, targetPath);

        const relativePath = path.relative(
            path.join(__dirname, '..', 'public'),
            targetPath
        ).replace(/\\/g, '/');

        const [reportResult] = await pool.query(
            `INSERT INTO audit_reports
             (nama_report, total_debit, total_kredit, selisih, status_audit, nama_jemaat, tahun_laporan, nama_file_asli, file_path)
             VALUES (?, 0, 0, 0, ?, ?, ?, ?, ?)`,
            [
                path.basename(targetFileName, ext),
                'Proses',
                namaJemaat,
                tahunLaporan,
                targetFileName,
                relativePath
            ]
        );

        await pool.query(
            'INSERT IGNORE INTO jemaat_list (nama_jemaat) VALUES (?)',
            [namaJemaat]
        );

        res.status(201).json({
            message: `Laporan baru berhasil dibuat dari template untuk ${titleCaseJemaatName(namaJemaat)} tahun ${tahunLaporan}.`,
            reportId: reportResult.insertId
        });
    } catch (error) {
        console.error("Error createReportFromTemplate:", error);
        res.status(500).json({ message: 'Gagal membuat laporan dari template: ' + error.message });
    }
};

// ======================== STATISTIK KEUANGAN ========================

exports.getKeuanganStats = async (req, res) => {
    try {
        let { reportId } = req.query;
        if (!reportId || reportId === "undefined") {
            const [latestReport] = await pool.query("SELECT id FROM audit_reports ORDER BY id DESC LIMIT 1");
            if (latestReport && latestReport.length > 0) reportId = latestReport[0].id;
            else return res.json({ totalPemasukan: 0, totalPengeluaran: 0, namaFileActive: "Belum ada file" });
        }
        const [resPemasukan] = await pool.query("SELECT SUM(debit) AS total FROM audit_raw_data WHERE report_id = ?", [reportId]);
        const [resPengeluaran] = await pool.query("SELECT SUM(kredit) AS total FROM audit_raw_data WHERE report_id = ?", [reportId]);
        const [resNamaReport] = await pool.query("SELECT nama_report FROM audit_reports WHERE id = ?", [reportId]);
        res.json({
            totalPemasukan: resPemasukan[0]?.total || 0,
            totalPengeluaran: resPengeluaran[0]?.total || 0,
            namaFileActive: resNamaReport[0]?.nama_report || "File Tidak Diketahui"
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// ======================== 5 TRANSAKSI TERAKHIR ========================

exports.getRecentTransactions = async (req, res) => {
    try {
        let { reportId } = req.query;
        if (!reportId || reportId === "undefined") {
            const [latestReport] = await pool.query("SELECT id FROM audit_reports ORDER BY id DESC LIMIT 1");
            if (latestReport && latestReport.length > 0) reportId = latestReport[0].id;
            else return res.json([]);
        }
        const [rows] = await pool.query(`
            SELECT tanggal AS transaksi_tanggal,
                   IF(debit > 0, 'Pemasukan', 'Pengeluaran') AS transaksi_jenis,
                   IF(debit > 0, debit, kredit) AS transaksi_nominal,
                   keterangan AS transaksi_keterangan, kategori
            FROM audit_raw_data WHERE report_id = ?
            ORDER BY tanggal DESC LIMIT 5
        `, [reportId]);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// ======================== DAFTAR JEMAAT ========================

exports.getJemaatList = async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT DISTINCT nama_jemaat FROM audit_reports WHERE nama_jemaat IS NOT NULL AND nama_jemaat != "" ORDER BY LOWER(nama_jemaat) ASC'
        );
        res.json(rows.map(r => r.nama_jemaat));
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// ======================== DAFTAR TAHUN TERSEDIA ========================

exports.getAvailableYears = async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT DISTINCT tahun_laporan FROM audit_reports WHERE tahun_laporan IS NOT NULL ORDER BY tahun_laporan DESC'
        );
        res.json(rows.map(r => r.tahun_laporan));
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// ======================== DAFTAR LAPORAN (DENGAN FILTER) ========================

exports.getReports = async (req, res) => {
    try {
        const { jemaat, tahun, search } = req.query;
        let sql = `SELECT id, nama_report, nama_jemaat, tahun_laporan, nama_file_asli, file_path,
                          total_debit, total_kredit, selisih, status_audit 
                   FROM audit_reports WHERE 1=1`;
        const params = [];

        if (jemaat) {
            sql += ' AND LOWER(nama_jemaat) = ?';
            params.push(normalizeJemaatName(jemaat));
        }
        if (tahun) {
            sql += ' AND tahun_laporan = ?';
            params.push(parseInt(tahun));
        }
        if (search) {
            sql += ' AND (LOWER(nama_jemaat) LIKE ? OR LOWER(nama_file_asli) LIKE ? OR LOWER(nama_report) LIKE ? OR CAST(tahun_laporan AS CHAR) LIKE ?)';
            const q = `%${search.toLowerCase()}%`;
            params.push(q, q, q, q);
        }
        sql += ' ORDER BY id DESC';
        const [rows] = await pool.query(sql, params);
        res.json(rows.map(row => ({
            ...row,
            nama_jemaat_display: titleCaseJemaatName(row.nama_jemaat) || 'Tanpa Jemaat',
            file_url: row.file_path ? `/public/${String(row.file_path).replace(/\\/g, '/')}` : null,
            folder_key: normalizeJemaatName(row.nama_jemaat) || 'tanpa-nama'
        })));
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.getAllReportsList = exports.getReports;

// ======================== HAPUS LAPORAN ========================

exports.deleteReport = async (req, res) => {
    const { id } = req.params;
    try {
        // Ambil path file fisik sebelum hapus dari DB
        const [reports] = await pool.query('SELECT file_path FROM audit_reports WHERE id = ?', [id]);
        
        await pool.query("DELETE FROM audit_raw_data WHERE report_id = ?", [id]);
        const [result] = await pool.query("DELETE FROM audit_reports WHERE id = ?", [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "Laporan tidak ditemukan." });
        }

        // Hapus file fisik jika ada
        if (reports.length > 0 && reports[0].file_path) {
            const filePath = path.join(__dirname, '..', 'public', reports[0].file_path);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`[Delete] File fisik dihapus: ${filePath}`);
            }
        }

        res.json({ message: "Laporan dan seluruh data transaksi berhasil dihapus!" });
    } catch (error) {
        console.error("Error deleteReport:", error);
        res.status(500).json({ message: "Gagal menghapus: " + error.message });
    }
};

// ======================== DOWNLOAD FILE EXCEL FISIK ========================

exports.downloadReportFile = async (req, res) => {
    try {
        const result = await getReportFilePath(req.params.id);
        if (!result) return res.status(404).json({ message: 'Laporan tidak ditemukan.' });
        const { report, filePath } = result;

        if (!filePath || !fs.existsSync(filePath)) {
            return res.status(404).json({ message: 'File Excel fisik tidak ditemukan.' });
        }

        res.download(filePath, report.nama_file_asli || path.basename(filePath));
    } catch (error) {
        console.error("Error downloadReportFile:", error);
        res.status(500).json({ message: error.message });
    }
};

// ======================== ONLYOFFICE CONFIG & CALLBACK ========================

exports.getOnlyOfficeConfig = async (req, res) => {
    try {
        const result = await getReportFilePath(req.params.id);
        if (!result) return res.status(404).json({ message: 'Laporan tidak ditemukan.' });
        const { report, filePath } = result;

        if (!filePath || !fs.existsSync(filePath)) {
            return res.status(404).json({ message: 'File Excel fisik tidak ditemukan.' });
        }

        const documentServerUrl = getOnlyOfficeServerUrl();
        if (!documentServerUrl) {
            return res.status(503).json({
                message: 'OnlyOffice Document Server belum dikonfigurasi.',
                setup: {
                    env: 'ONLYOFFICE_DOCUMENT_SERVER_URL',
                    example: 'http://localhost:8080',
                    dockerPublicBaseUrl: 'Jika Document Server berjalan di Docker, set ONLYOFFICE_PUBLIC_BASE_URL=http://host.docker.internal:3006'
                }
            });
        }

        const probe = await probeOnlyOfficeScript(documentServerUrl);
        if (!probe.ok) {
            return res.status(503).json({
                message: 'OnlyOffice Document Server belum bisa diakses dari aplikasi.',
                details: probe.message,
                setup: {
                    env: 'ONLYOFFICE_DOCUMENT_SERVER_URL',
                    example: 'http://localhost:8080',
                    dockerPublicBaseUrl: 'Jalankan Docker Desktop lalu jalankan npm run onlyoffice:up agar api.js tersedia.'
                }
            });
        }

        const publicBaseUrl = getPublicBaseUrl(req);
        const publicFilePath = String(report.file_path || '').replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
        const version = getFileStatVersion(filePath);
        const title = report.nama_file_asli || `${report.nama_report || 'laporan'}.xlsx`;
        const callbackUrl = `${publicBaseUrl}/api/onlyoffice/report/${req.params.id}/callback`;
        const config = {
            documentServerUrl,
            scriptUrl: probe.scriptUrl,
            document: {
                fileType: 'xlsx',
                key: buildOnlyOfficeKey(req.params.id, filePath),
                title,
                url: `${publicBaseUrl}/public/${publicFilePath}?v=${encodeURIComponent(version)}`,
                permissions: {
                    comment: true,
                    download: true,
                    edit: true,
                    fillForms: true,
                    print: true,
                    review: true
                }
            },
            documentType: 'cell',
            editorConfig: {
                callbackUrl,
                lang: 'id',
                mode: 'edit',
                user: {
                    id: 'gmahk-admin',
                    name: 'Admin GMAHK'
                },
                customization: {
                    autosave: true,
                    compactToolbar: false,
                    forcesave: true
                },
                plugins: {
                    disable: [
                        'asc.{9DC93CDB-B576-4F0C-B55E-FCC9C48DD007}'
                    ]
                }
            },
            width: '100%',
            height: '100%'
        };

        const jwtSecret = process.env.ONLYOFFICE_JWT_SECRET;
        if (jwtSecret) {
            config.token = signJwtHs256(config, jwtSecret);
        }

        res.json(config);
    } catch (error) {
        console.error("Error getOnlyOfficeConfig:", error);
        res.status(500).json({ message: error.message });
    }
};

exports.handleOnlyOfficeCallback = async (req, res) => {
    try {
        const body = req.body || {};
        const status = Number(body.status);

        if (![2, 6].includes(status)) {
            return res.json({ error: 0 });
        }

        if (!body.url) {
            return res.json({ error: 1, message: 'OnlyOffice tidak mengirim URL file hasil edit.' });
        }

        const result = await getReportFilePath(req.params.id);
        if (!result || !result.filePath || !fs.existsSync(result.filePath)) {
            return res.json({ error: 1, message: 'File laporan tidak ditemukan.' });
        }

        await downloadToFile(body.url, result.filePath);
        console.log(`[OnlyOffice] File laporan #${req.params.id} disimpan dari callback status ${status}.`);
        res.json({ error: 0 });
    } catch (error) {
        console.error("Error handleOnlyOfficeCallback:", error);
        res.json({ error: 1, message: error.message });
    }
};

// ======================== SPREADSHEET: DAFTAR SHEET ========================

exports.getReportSheets = async (req, res) => {
    const { id } = req.params;
    try {
        const [reports] = await pool.query('SELECT file_path, nama_report FROM audit_reports WHERE id = ?', [id]);
        if (reports.length === 0) return res.status(404).json({ message: 'Laporan tidak ditemukan.' });

        const filePath = reports[0].file_path
            ? path.join(__dirname, '..', 'public', reports[0].file_path)
            : null;

        if (!filePath || !fs.existsSync(filePath)) {
            // File fisik tidak ada — kembalikan sheet virtual dari DB
            return res.json({ sheets: ['Data Transaksi'], hasExcelFile: false });
        }

        const workbook = xlsx.readFile(filePath, { bookSheets: true });
        res.json({ sheets: workbook.SheetNames, hasExcelFile: true });
    } catch (error) {
        console.error("Error getReportSheets:", error);
        res.status(500).json({ message: error.message });
    }
};

// ======================== SPREADSHEET: DATA SATU SHEET ========================

exports.getSheetData = async (req, res) => {
    const { id, sheetName } = req.params;
    try {
        const [reports] = await pool.query('SELECT file_path, nama_report FROM audit_reports WHERE id = ?', [id]);
        if (reports.length === 0) return res.status(404).json({ message: 'Laporan tidak ditemukan.' });

        const filePath = reports[0].file_path
            ? path.join(__dirname, '..', 'public', reports[0].file_path)
            : null;

        if (!filePath || !fs.existsSync(filePath)) {
            // Fallback: ambil data dari DB sebagai grid sederhana
            const [rows] = await pool.query(
                'SELECT tanggal, keterangan, kategori, debit, kredit FROM audit_raw_data WHERE report_id = ? ORDER BY tanggal ASC, id ASC',
                [id]
            );
            const header = ['Tanggal', 'Keterangan', 'Kategori', 'Debit', 'Kredit'];
            const data = rows.map(r => [
                r.tanggal ? new Date(r.tanggal).toLocaleDateString('id-ID') : '',
                r.keterangan || '',
                r.kategori || '',
                r.debit || 0,
                r.kredit || 0
            ]);
            return res.json({ header, data, fromDb: true });
        }

        const workbook = xlsx.readFile(filePath, { cellFormula: true, cellStyles: true });
        const decodedSheetName = decodeURIComponent(sheetName);
        const sheet = workbook.Sheets[decodedSheetName];

        if (!sheet) {
            return res.status(404).json({ message: `Sheet "${decodedSheetName}" tidak ditemukan.` });
        }

        // Ambil data sebagai array 2D — persis seperti Excel
        const rawData = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
        const rangeForFormula = xlsx.utils.decode_range(sheet['!ref'] || 'A1');
        for (let r = rangeForFormula.s.r; r <= rangeForFormula.e.r; r++) {
            if (!rawData[r]) rawData[r] = [];
            for (let c = rangeForFormula.s.c; c <= rangeForFormula.e.c; c++) {
                const addr = xlsx.utils.encode_cell({ r, c });
                if (sheet[addr]?.f) rawData[r][c] = `=${sheet[addr].f}`;
            }
        }

        // Konversi tanggal serial Excel ke string yang bisa dibaca
        const processedData = rawData.map(row => 
            row.map(cell => {
                if (typeof cell === 'number' && cell > 40000 && cell < 60000) {
                    // Kemungkinan serial date Excel
                    try {
                        const d = new Date((cell - 25569) * 86400 * 1000);
                        if (!isNaN(d.getTime())) {
                            return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
                        }
                    } catch (e) {}
                }
                return cell;
            })
        );

        // Tentukan lebar kolom berdasarkan range
        const range = xlsx.utils.decode_range(sheet['!ref'] || 'A1');
        const colCount = range.e.c - range.s.c + 1;
        const colWidths = [];
        for (let c = 0; c <= range.e.c; c++) {
            const colObj = sheet['!cols'] && sheet['!cols'][c];
            colWidths.push(colObj ? (colObj.wch || colObj.wpx || 12) : 12);
        }

        // Ambil merge info
        const merges = sheet['!merges'] ? sheet['!merges'].map(m => ({
            s: { r: m.s.r, c: m.s.c },
            e: { r: m.e.r, c: m.e.c }
        })) : [];

        res.json({
            data: processedData,
            colWidths,
            merges,
            hasExcelFile: true
        });
    } catch (error) {
        console.error("Error getSheetData:", error);
        res.status(500).json({ message: error.message });
    }
};

// ======================== SPREADSHEET: SIMPAN SHEET KE FILE EXCEL ========================

exports.saveSheetData = async (req, res) => {
    const { id, sheetName } = req.params;
    const { data } = req.body;

    if (!Array.isArray(data)) {
        return res.status(400).json({ message: "Format data tidak valid." });
    }

    try {
        const [reports] = await pool.query('SELECT file_path FROM audit_reports WHERE id = ?', [id]);
        if (reports.length === 0) return res.status(404).json({ message: 'Laporan tidak ditemukan.' });

        const filePath = reports[0].file_path
            ? path.join(__dirname, '..', 'public', reports[0].file_path)
            : null;

        if (!filePath || !fs.existsSync(filePath)) {
            return res.status(400).json({ message: 'File Excel fisik tidak ditemukan. Tidak dapat menyimpan.' });
        }

        const decodedSheetName = decodeURIComponent(sheetName);
        const workbook = xlsx.readFile(filePath, { cellFormula: true, cellStyles: true });

        if (!workbook.Sheets[decodedSheetName]) {
            return res.status(404).json({ message: `Sheet "${decodedSheetName}" tidak ditemukan.` });
        }

        const sheet = workbook.Sheets[decodedSheetName];
        const range = xlsx.utils.decode_range(sheet['!ref'] || 'A1');
        const maxRow = Math.max(range.e.r, data.length - 1, 0);
        const maxCol = Math.max(
            range.e.c,
            ...data.map(row => Array.isArray(row) ? row.length - 1 : -1),
            0
        );

        for (let r = 0; r <= maxRow; r++) {
            for (let c = 0; c <= maxCol; c++) {
                const cellAddress = xlsx.utils.encode_cell({ r, c });
                const nextValue = Array.isArray(data[r]) && data[r][c] !== undefined ? data[r][c] : '';

                if (nextValue === '' || nextValue === null) {
                    if (sheet[cellAddress]) {
                        if (sheet[cellAddress].s) {
                            sheet[cellAddress] = { t: 's', v: '', s: sheet[cellAddress].s };
                        } else {
                            sheet[cellAddress] = { t: 's', v: '' };
                        }
                    }
                    continue;
                }

                const existingStyle = sheet[cellAddress]?.s;
                const nextText = String(nextValue);

                if (nextText.startsWith('=')) {
                    sheet[cellAddress] = { t: 'n', f: nextText.slice(1) };
                    if (existingStyle) sheet[cellAddress].s = existingStyle;
                    continue;
                }

                const numericValue = typeof nextValue === 'number'
                    ? nextValue
                    : (typeof nextValue === 'string' && nextValue.trim() !== '' && !isNaN(Number(nextValue.toString().replace(/,/g, ''))) ? Number(nextValue.toString().replace(/,/g, '')) : null);

                sheet[cellAddress] = numericValue !== null
                    ? { t: 'n', v: numericValue }
                    : { t: 's', v: String(nextValue) };

                if (existingStyle) {
                    sheet[cellAddress].s = existingStyle;
                }
            }
        }

        sheet['!ref'] = xlsx.utils.encode_range({
            s: { r: 0, c: 0 },
            e: { r: maxRow, c: maxCol }
        });

        // Simpan kembali ke file fisik (buat backup dulu)
        const backupPath = filePath + '.bak';
        fs.copyFileSync(filePath, backupPath);
        try {
            xlsx.writeFile(workbook, filePath);
            fs.unlinkSync(backupPath); // hapus backup jika sukses
            console.log(`[Save] Sheet "${decodedSheetName}" berhasil disimpan ke ${filePath}`);
        } catch (writeErr) {
            // Restore dari backup jika gagal
            fs.copyFileSync(backupPath, filePath);
            fs.unlinkSync(backupPath);
            throw writeErr;
        }

        res.json({ message: `Sheet "${decodedSheetName}" berhasil disimpan ke file Excel!` });
    } catch (error) {
        console.error("Error saveSheetData:", error);
        res.status(500).json({ message: error.message });
    }
};

// ======================== DETAIL TRANSAKSI DB (FALLBACK EDITOR) ========================

exports.getReportDetails = async (req, res) => {
    const { id } = req.params;
    try {
        const [rows] = await pool.query(
            "SELECT id, report_id, tanggal, keterangan, debit, kredit, kategori FROM audit_raw_data WHERE report_id = ? ORDER BY tanggal ASC, id ASC",
            [id]
        );
        res.json(rows);
    } catch (error) {
        console.error("Error getReportDetails:", error);
        res.status(500).json({ message: error.message });
    }
};

// ======================== SIMPAN EDIT DB (UNTUK SHEET VIRTUAL/DB MODE) ========================

exports.saveReportDetails = async (req, res) => {
    const { id } = req.params;
    const { rows } = req.body;
    if (!Array.isArray(rows)) return res.status(400).json({ message: "Format data tidak valid." });

    try {
        const connection = await pool.getConnection();
        await connection.beginTransaction();
        try {
            await connection.query("DELETE FROM audit_raw_data WHERE report_id = ?", [id]);
            let totalDebit = 0, totalKredit = 0;
            for (let r of rows) {
                const debit = parseExcelNumber(r.debit);
                const kredit = parseExcelNumber(r.kredit);
                totalDebit += debit;
                totalKredit += kredit;
                let tgl = r.tanggal ? new Date(r.tanggal) : new Date();
                if (isNaN(tgl.getTime())) tgl = new Date();
                await connection.query(
                    "INSERT INTO audit_raw_data (report_id, tanggal, keterangan, debit, kredit, kategori) VALUES (?, ?, ?, ?, ?, ?)",
                    [id, tgl, r.keterangan || "", debit, kredit, r.kategori || "Dana Jemaat"]
                );
            }
            const selisih = totalDebit - totalKredit;
            const statusAudit = selisih === 0 ? "Balance" : "Selisih / Perlu Cek";
            await connection.query(
                "UPDATE audit_reports SET total_debit = ?, total_kredit = ?, selisih = ?, status_audit = ? WHERE id = ?",
                [totalDebit, totalKredit, selisih, statusAudit, id]
            );
            await connection.commit();
            res.json({ message: "Data berhasil disimpan dan neraca diperbarui!" });
        } catch (dbErr) {
            await connection.rollback();
            throw dbErr;
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error("Error saveReportDetails:", error);
        res.status(500).json({ message: error.message });
    }
};

// ======================== KOMPARASI LAPORAN ========================

exports.compareReports = async (req, res) => {
    try {
        const { reportIdA, reportIdB } = req.query;
        if (!reportIdA || !reportIdB) return res.status(400).json({ message: "Pilih dua laporan." });
        const [dataA] = await pool.query("SELECT SUM(debit) as debit, SUM(kredit) as kredit FROM audit_raw_data WHERE report_id = ?", [reportIdA]);
        const [dataB] = await pool.query("SELECT SUM(debit) as debit, SUM(kredit) as kredit FROM audit_raw_data WHERE report_id = ?", [reportIdB]);
        const [infoA] = await pool.query("SELECT nama_report FROM audit_reports WHERE id = ?", [reportIdA]);
        const [infoB] = await pool.query("SELECT nama_report FROM audit_reports WHERE id = ?", [reportIdB]);
        const debitA = dataA[0]?.debit || 0;
        const debitB = dataB[0]?.debit || 0;
        const selisihPemasukan = debitB - debitA;
        const persentase = debitA > 0 ? ((selisihPemasukan / debitA) * 100).toFixed(2) + "%" : "0%";
        res.json({
            fileA: { nama: infoA[0]?.nama_report, totalPemasukan: debitA, totalPengeluaran: dataA[0]?.kredit || 0 },
            fileB: { nama: infoB[0]?.nama_report, totalPemasukan: debitB, totalPengeluaran: dataB[0]?.kredit || 0 },
            analisis: { perubahanNominal: selisihPemasukan, trenPersentase: persentase }
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.compareReportsByYear = async (req, res) => {
    try {
        const jemaat = normalizeJemaatName(req.query.jemaat);
        const yearA = parseInt(req.query.yearA);
        const yearB = parseInt(req.query.yearB);

        if (!jemaat || !yearA || !yearB) {
            return res.status(400).json({ message: 'Pilih nama jemaat dan dua tahun laporan.' });
        }
        if (yearA === yearB) {
            return res.status(400).json({ message: 'Tahun pembanding harus berbeda.' });
        }

        const getYearSummary = async (year) => {
            const [rows] = await pool.query(`
                SELECT
                    COUNT(*) AS file_count,
                    COALESCE(SUM(total_debit), 0) AS pemasukan,
                    COALESCE(SUM(total_kredit), 0) AS pengeluaran
                FROM audit_reports
                WHERE LOWER(nama_jemaat) = ? AND tahun_laporan = ?
            `, [jemaat, year]);
            const row = rows[0] || {};
            const pemasukan = Number(row.pemasukan) || 0;
            const pengeluaran = Number(row.pengeluaran) || 0;
            return {
                year,
                fileCount: Number(row.file_count) || 0,
                pemasukan,
                pengeluaran,
                net: pemasukan - pengeluaran
            };
        };

        const a = await getYearSummary(yearA);
        const b = await getYearSummary(yearB);

        if (a.fileCount === 0 || b.fileCount === 0) {
            return res.status(404).json({
                message: `Data ${titleCaseJemaatName(jemaat)} untuk tahun ${a.fileCount === 0 ? yearA : yearB} belum tersedia.`
            });
        }

        const diff = {
            pemasukan: b.pemasukan - a.pemasukan,
            pengeluaran: b.pengeluaran - a.pengeluaran,
            net: b.net - a.net,
            pemasukanPct: a.pemasukan ? ((b.pemasukan - a.pemasukan) / a.pemasukan) * 100 : null,
            pengeluaranPct: a.pengeluaran ? ((b.pengeluaran - a.pengeluaran) / a.pengeluaran) * 100 : null,
            netPct: a.net ? ((b.net - a.net) / Math.abs(a.net)) * 100 : null
        };

        let verdict;
        if (diff.net > 0) {
            verdict = `${yearB} lebih baik dari ${yearA} karena surplus/net naik.`;
        } else if (diff.net < 0) {
            verdict = `${yearA} lebih baik dari ${yearB} karena surplus/net ${yearB} turun.`;
        } else {
            verdict = `${yearA} dan ${yearB} setara dari sisi surplus/net.`;
        }

        res.json({
            jemaat,
            jemaatDisplay: titleCaseJemaatName(jemaat),
            base: a,
            compared: b,
            diff,
            status: diff.net >= 0 ? 'increase' : 'decrease',
            verdict
        });
    } catch (error) {
        console.error("Error compareReportsByYear:", error);
        res.status(500).json({ message: error.message });
    }
};

// ======================== AUDIT TERPERINCI ========================

exports.runDeepAudit = async (req, res) => {
    const { id } = req.params;
    try {
        const [reports] = await pool.query("SELECT * FROM audit_reports WHERE id = ?", [id]);
        if (reports.length === 0) return res.status(404).json({ message: "Laporan tidak ditemukan." });
        const report = reports[0];
        const [transactions] = await pool.query("SELECT * FROM audit_raw_data WHERE report_id = ? ORDER BY tanggal ASC, id ASC", [id]);

        let totalDebit = 0, totalKredit = 0;
        let findings = [], score = 100;
        let doubleEntriesCount = 0, negativeCount = 0, emptyDescCount = 0, suspiciousCount = 0, outlierCount = 0, weekdayOfferingCount = 0;
        const namaHariIndo = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];

        const selisih = parseFloat(report.total_debit) - parseFloat(report.total_kredit);
        if (selisih !== 0) {
            score -= 25;
            findings.push({
                severity: "danger",
                title: "Neraca Kas Tidak Seimbang",
                message: `Selisih kas Rp ${Math.abs(selisih).toLocaleString("id-ID")} antara Debit Rp ${parseFloat(report.total_debit).toLocaleString("id-ID")} dan Kredit Rp ${parseFloat(report.total_kredit).toLocaleString("id-ID")}.`,
                recommendation: "Telusuri mutasi kas masuk/keluar untuk menemukan pos yang terlewat."
            });
        }

        transactions.forEach((tx, idx) => {
            const rowNum = idx + 1;
            const debit = parseFloat(tx.debit) || 0;
            const kredit = parseFloat(tx.kredit) || 0;
            const keterangan = tx.keterangan ? tx.keterangan.trim() : "";
            const kategori = tx.kategori || "";
            const tgl = new Date(tx.tanggal);
            const dateStr = tgl.toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
            const dayOfWeek = tgl.getDay();
            totalDebit += debit; totalKredit += kredit;

            if (debit > 0 && kredit > 0) {
                doubleEntriesCount++;
                if (doubleEntriesCount <= 3) { score -= 5; findings.push({ severity: "danger", title: `Transaksi Ganda Baris #${rowNum}`, message: `Tanggal ${dateStr}: "${keterangan}" mencatat Debit Rp ${debit.toLocaleString("id-ID")} dan Kredit Rp ${kredit.toLocaleString("id-ID")} bersamaan.`, recommendation: "Pecah menjadi dua baris terpisah." }); }
            }
            if (debit < 0 || kredit < 0) {
                negativeCount++;
                if (negativeCount <= 3) { score -= 5; findings.push({ severity: "warning", title: `Nilai Negatif Baris #${rowNum}`, message: `Tanggal ${dateStr}: "${keterangan}" mengandung nilai negatif.`, recommendation: "Ganti dengan nilai positif dan pakai entri penyesuaian." }); }
            }
            if (!keterangan) {
                emptyDescCount++;
                if (emptyDescCount <= 4) { score -= 3; findings.push({ severity: "warning", title: `Keterangan Kosong Baris #${rowNum}`, message: `Transaksi ${dateStr} Rp ${(debit || kredit).toLocaleString("id-ID")} tanpa keterangan.`, recommendation: "Lengkapi deskripsi transaksi dengan rincian spesifik." }); }
            }
            const ketLower = keterangan.toLowerCase();
            const suspiciousKeywords = ["siluman", "gelap", "tanpa kuitansi", "tanpa bukti", "fiktif", "kas bon", "pinjam", "lain-lain", "lain - lain", "penyesuaian"];
            if (suspiciousKeywords.some(kw => ketLower.includes(kw)) && (debit || kredit) > 300000) {
                suspiciousCount++;
                if (suspiciousCount <= 4) { score -= 5; findings.push({ severity: "warning", title: `Uraian Kurang Rinci Baris #${rowNum}`, message: `"${keterangan}" Rp ${(debit || kredit).toLocaleString("id-ID")} pada ${dateStr} menggunakan istilah umum/tidak spesifik.`, recommendation: "Gunakan deskripsi yang rinci, sertakan nomor kuitansi dan bukti." }); }
            }
            if (kredit > 5000000) {
                outlierCount++;
                if (outlierCount <= 3) { score -= 2; findings.push({ severity: "warning", title: `Pengeluaran Besar Baris #${rowNum}`, message: `Pengeluaran Rp ${kredit.toLocaleString("id-ID")} pada ${dateStr}: "${keterangan}".`, recommendation: "Pastikan ada persetujuan rapat komite dan notulen rapat." }); }
            }
            const isOffering = (kategori + ketLower).includes("perpuluhan") || ketLower.includes("persembahan") || ketLower.includes("kolekte");
            if (isOffering && debit > 0 && dayOfWeek >= 1 && dayOfWeek <= 5) {
                weekdayOfferingCount++;
                if (weekdayOfferingCount <= 3) { findings.push({ severity: "info", title: `Setoran Hari Kerja Baris #${rowNum}`, message: `Persembahan pada hari ${namaHariIndo[dayOfWeek]}, ${dateStr}: "${keterangan}" Rp ${debit.toLocaleString("id-ID")}.`, recommendation: "Verifikasi apakah ini transfer bank atau setoran kas tertunda dari Sabat." }); }
            }
        });

        score = Math.max(10, score);
        let verdict = "Sangat Baik (Kepatuhan Tinggi)";
        let verdictColor = "text-emerald-400";
        if (score < 90 && score >= 75) { verdict = "Baik (Kepatuhan Cukup)"; verdictColor = "text-teal-400"; }
        else if (score < 75 && score >= 60) { verdict = "Cukup (Butuh Perbaikan)"; verdictColor = "text-yellow-400"; }
        else if (score < 60 && score >= 45) { verdict = "Kurang (Temuan Serius)"; verdictColor = "text-orange-400"; }
        else if (score < 45) { verdict = "Kritis (Risiko Tinggi)"; verdictColor = "text-rose-400"; }

        let summaryText = `Audit laporan **"${report.nama_report}"** untuk jemaat **${report.nama_jemaat || 'Umum'}** tahun **${report.tahun_laporan || '-'}** menghasilkan skor **${score}/100** — **${verdict}**.\n\n`;
        if (selisih !== 0) summaryText += `* **Peringatan**: Laporan **TIDAK SEIMBANG** selisih Rp ${Math.abs(selisih).toLocaleString("id-ID")}. Harus segera diperbaiki.\n`;
        else summaryText += `* **Keseimbangan**: Neraca **SEIMBANG** — total Debit & Kredit Rp ${totalDebit.toLocaleString("id-ID")}.\n`;
        let parts = [];
        if (doubleEntriesCount > 0) parts.push(`${doubleEntriesCount} transaksi ganda`);
        if (emptyDescCount > 0) parts.push(`${emptyDescCount} keterangan kosong`);
        if (suspiciousCount > 0) parts.push(`${suspiciousCount} uraian tidak rinci`);
        if (outlierCount > 0) parts.push(`${outlierCount} pengeluaran besar`);
        if (parts.length > 0) summaryText += `* **Temuan**: ${parts.join(", ")}.\n`;
        else summaryText += `* **Temuan**: Tidak ada kesalahan pencatatan yang ditemukan.\n`;
        summaryText += `\n**Rekomendasi:**\n`;
        if (selisih !== 0) summaryText += `1. Selaraskan saldo kas dan temukan selisih Rp ${Math.abs(selisih).toLocaleString("id-ID")}.\n`;
        if (doubleEntriesCount > 0) summaryText += `2. Pecah transaksi ganda menjadi baris terpisah.\n`;
        if (emptyDescCount > 0) summaryText += `3. Lengkapi keterangan pada transaksi yang masih kosong.\n`;
        if (outlierCount > 0) summaryText += `4. Sertakan notulen rapat untuk pengeluaran di atas Rp 5 juta.\n`;
        summaryText += `5. Arsipkan bukti fisik pengeluaran secara kronologis.`;

        res.json({
            reportId: id, namaReport: report.nama_report, namaJemaat: report.nama_jemaat,
            tahunLaporan: report.tahun_laporan, score, verdict, verdictColor, summary: summaryText,
            stats: { totalTransactions: transactions.length, totalDebit: report.total_debit, totalKredit: report.total_kredit, selisih: report.selisih },
            findings
        });
    } catch (error) {
        console.error("Error runDeepAudit:", error);
        res.status(500).json({ message: error.message });
    }
};
