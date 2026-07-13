const { getDbErrorMessage, isDbConnectionError } = require('../utils/errorHelpers');

const escapeHtml = (value = '') => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const renderHtmlError = (title, message, statusCode) => `<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <style>
        :root {
            color-scheme: dark;
            --bg: #0a0d14;
            --panel: #111827;
            --border: #243447;
            --text: #f0f6ff;
            --muted: #94a3b8;
            --accent: #60a5fa;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            padding: 24px;
            background: var(--bg);
            color: var(--text);
            font-family: Inter, Arial, sans-serif;
        }
        main {
            width: min(560px, 100%);
            background: var(--panel);
            border: 1px solid var(--border);
            border-radius: 14px;
            padding: 28px;
            box-shadow: 0 24px 70px rgba(0, 0, 0, 0.35);
        }
        .badge {
            display: inline-block;
            padding: 6px 10px;
            border-radius: 999px;
            background: rgba(96, 165, 250, 0.12);
            color: var(--accent);
            font-size: 12px;
            font-weight: 700;
            margin-bottom: 14px;
        }
        h1 { margin: 0 0 10px; font-size: 22px; }
        p {
            margin: 0;
            color: var(--muted);
            line-height: 1.6;
        }
        a {
            color: var(--accent);
            text-decoration: none;
            font-weight: 600;
        }
    </style>
</head>
<body>
    <main>
        <div class="badge">Error ${statusCode}</div>
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(message)}</p>
        <p style="margin-top: 14px;">Jika MySQL baru saja dinyalakan, silakan <a href="/">muat ulang halaman</a> atau buka <a href="/login">halaman login</a>.</p>
    </main>
</body>
</html>`;

module.exports = (error, req, res, next) => {
    const prefersJson = req.originalUrl.startsWith('/api') || req.accepts(['json', 'html']) === 'json';

    if (isDbConnectionError(error)) {
        const message = getDbErrorMessage(error);
        if (prefersJson) {
            return res.status(503).json({ message });
        }
        return res.status(503).send(renderHtmlError('Database belum terhubung', message, 503));
    }

    console.error(error);

    if (prefersJson) {
        return res.status(error.status || 500).json({ message: 'Terjadi kesalahan pada server.' });
    }

    return res
        .status(error.status || 500)
        .send(renderHtmlError('Terjadi kesalahan', 'Server mengalami kendala. Silakan coba lagi beberapa saat lagi.', error.status || 500));
};
