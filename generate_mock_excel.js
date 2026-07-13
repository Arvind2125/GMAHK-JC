const xlsx = require('xlsx');
const path = require('path');

const data = [
    ["LAPORAN MUTASI KAS JEMAAT GMAHK", "", "", "", ""],
    ["Periode Laporan Keuangan Mei 2026", "", "", "", ""],
    ["", "", "", "", ""],
    ["Tanggal", "Keterangan", "Kategori", "Debit", "Kredit"],
    ["2026-05-02", "Penerimaan Perpuluhan Sabat Kesatu", "Perpuluhan", 12500000, 0],
    ["2026-05-02", "Penerimaan Persembahan Sabat Kesatu", "Dana Jemaat", 4500000, 0],
    ["2026-05-04", "Penerimaan Perpuluhan Transfer Bank", "Perpuluhan", 3000000, 0], // Penerimaan hari Senin (Weekday)
    ["2026-05-09", "Penerimaan Persembahan Sabat Kedua", "Persembahan Terpadu", 5200000, 0],
    ["2026-05-12", "Biaya Konsumsi Rapat Diaken", "Dana Jemaat", 0, 450000],
    ["2026-05-15", "Pengeluaran Kas Siluman tanpa kwitansi", "Lain-lain", 0, 1500000], // Kata kunci mencurigakan & nominal besar
    ["2026-05-16", "Penerimaan Kolekte Sekolah Sabat", "Dana Jemaat", 2800000, 0],
    ["2026-05-18", "Pembelian Sound System Jemaat Baru", "Dana Jemaat", 0, 8500000], // Pengeluaran kas besar > 5 Juta
    ["2026-05-22", "Koreksi salah catat", "Lain-lain", -100000, 0], // Nominal negatif
    ["2026-05-23", "Transaksi Error Double Catat", "Dana Jemaat", 500000, 500000], // Debit & Kredit terisi sekaligus
    ["2026-05-25", "", "Dana Jemaat", 0, 250000], // Keterangan kosong
    ["2026-05-30", "Setoran Perpuluhan ke Daerah Konferens", "Perpuluhan", 0, 15500000] // Transfer Konferens
];

const wb = xlsx.utils.book_new();
const ws = xlsx.utils.aoa_to_sheet(data);

// Atur lebar kolom agar rapi saat dibuka
const wscols = [
    { wch: 15 }, // Tanggal
    { wch: 45 }, // Keterangan
    { wch: 25 }, // Kategori
    { wch: 15 }, // Debit
    { wch: 15 }  // Kredit
];
ws['!cols'] = wscols;

xlsx.utils.book_append_sheet(wb, ws, "Mutasi Jurnal Kas");

const targetPath = path.join(__dirname, 'mock_keuangan_jemaat.xlsx');
xlsx.writeFile(wb, targetPath);

console.log(`Sukses membuat file Excel simulasi di: ${targetPath}`);
console.log(`Anda dapat mengunggah file ini di dashboard untuk melakukan pre-review.`);
