# Setup OnlyOffice untuk Editor Excel Penuh

Integrasi aplikasinya sudah tersedia. Yang masih perlu dijalankan di mesin adalah OnlyOffice Document Server.

## 1. Install Docker Desktop

Install Docker Desktop untuk Windows, lalu pastikan command ini tersedia di terminal:

```powershell
docker --version
```

## 2. Jalankan OnlyOffice Document Server

Dari folder project:

```powershell
npm run onlyoffice:up
```

Ini akan menjalankan container `onlyoffice/documentserver` di:

```text
http://localhost:8080
```

Compose project ini sudah disetel agar:

- `JWT` dimatikan (`JWT_ENABLED=false`)
- akses dari container ke `host.docker.internal` diizinkan (`ALLOW_PRIVATE_IP_ADDRESS=true` dan `ALLOW_META_IP_ADDRESS=true`)

Konfigurasi ini dipasang lewat environment container, jadi tidak perlu me-mount `local.json` langsung dari Windows. Ini menghindari error `EBUSY` yang bisa membuat layanan editor restart sendiri.

## 3. Pastikan `.env` berisi ini

```env
ONLYOFFICE_DOCUMENT_SERVER_URL=http://localhost:8080
ONLYOFFICE_PUBLIC_BASE_URL=http://host.docker.internal:3006
ONLYOFFICE_JWT_SECRET=
```

`ONLYOFFICE_PUBLIC_BASE_URL` memakai `host.docker.internal` supaya container OnlyOffice bisa mengambil file dari aplikasi Node di host Windows.

## 4. Restart aplikasi Node

```powershell
npm start
```

## 5. Cara pakai

1. Login admin.
2. Buka modul keuangan.
3. Pada daftar laporan, klik tombol hijau Excel/OnlyOffice.
4. File `.xlsx` akan dibuka oleh OnlyOffice di browser.
5. Saat disimpan, OnlyOffice mengirim callback ke aplikasi dan aplikasi menimpa file laporan fisik yang sama.

## Troubleshooting

Jika editor menampilkan "Gagal memuat script OnlyOffice":

- Pastikan Docker Desktop berjalan.
- Pastikan `http://localhost:8080/web-apps/apps/api/documents/api.js` bisa dibuka.
- Restart aplikasi Node setelah mengubah `.env`.

Jika file tidak tersimpan:

- Pastikan callback URL di config memakai `host.docker.internal:3006`.
- Pastikan aplikasi Node masih berjalan di port `3006`.
- Cek log `server-runtime.log`.

Jika editor menampilkan popup seperti "Unduhan gagal" atau console browser menunjukkan `Editor.bin 403`:

- Jalankan ulang container OnlyOffice agar config environment terbaru dipakai:

```powershell
npm run onlyoffice:down
npm run onlyoffice:up
```

- Pastikan file `docker-compose.onlyoffice.yml` tidak lagi me-mount `local.json` ke `/etc/onlyoffice/documentserver/local.json`, karena pada Docker Desktop Windows hal ini bisa memicu error `EBUSY` dan restart service editor.
