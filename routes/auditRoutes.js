const express = require('express');
const router = express.Router();
const multer = require('multer');
const auditController = require('../controllers/auditController');

// Multer: simpan sementara sebelum dipindah controller
const upload = multer({ dest: 'public/uploads/tmp/' });

// ===== UPLOAD =====
router.post('/upload', upload.single('excelFile'), auditController.uploadAndProcessExcel);
router.post('/report/create-from-template', auditController.createReportFromTemplate);

// ===== DAFTAR & STATISTIK BERKAS =====
router.get('/reports', auditController.getReports);
router.delete('/report/:id', auditController.deleteReport);
router.get('/report/:id/download', auditController.downloadReportFile);
router.get('/report/:id/onlyoffice/config', auditController.getOnlyOfficeConfig);
router.get('/getKeuanganStats', auditController.getKeuanganStats);
router.get('/getRecentTransactions', auditController.getRecentTransactions);

// ===== KLASIFIKASI: JEMAAT & TAHUN =====
router.get('/jemaat-list', auditController.getJemaatList);
router.get('/years', auditController.getAvailableYears);

// ===== SPREADSHEET MULTI-SHEET (FILE EXCEL FISIK) =====
// Daftar sheet dari file Excel
router.get('/report/:id/sheets', auditController.getReportSheets);
// Data satu sheet (grid 2D)
router.get('/report/:id/sheet/:sheetName', auditController.getSheetData);
// Simpan edit satu sheet ke file Excel fisik
router.post('/report/:id/sheet/:sheetName/save', auditController.saveSheetData);

// ===== EDITOR DATA DB (FALLBACK / VIRTUAL SHEET) =====
router.get('/report/:id/details', auditController.getReportDetails);
router.post('/report/:id/save', auditController.saveReportDetails);

// ===== AUDIT TERPERINCI =====
router.get('/report/:id/audit-deep', auditController.runDeepAudit);

// ===== KOMPARASI =====
router.get('/compare', auditController.compareReports);
router.get('/compare-year', auditController.compareReportsByYear);

module.exports = router;
