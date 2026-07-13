const unwrapErrors = (error) => {
    if (!error) return [];
    if (Array.isArray(error.errors) && error.errors.length > 0) return error.errors;
    return [error];
};

const isDbConnectionError = (error) => {
    const errors = unwrapErrors(error);
    return errors.some((item) => [
        'ECONNREFUSED',
        'PROTOCOL_CONNECTION_LOST',
        'ER_ACCESS_DENIED_ERROR',
        'ER_BAD_DB_ERROR',
        'ENOTFOUND',
        'ETIMEDOUT'
    ].includes(item?.code));
};

const getDbErrorMessage = (error) => {
    const errors = unwrapErrors(error);
    const primaryError = errors[0] || error;

    switch (primaryError?.code) {
        case 'ER_ACCESS_DENIED_ERROR':
            return 'Koneksi database ditolak. Periksa username dan password MySQL di file .env.';
        case 'ER_BAD_DB_ERROR':
            return 'Database belum ditemukan. Pastikan nama database di file .env sudah benar.';
        case 'ENOTFOUND':
            return 'Host database tidak ditemukan. Periksa nilai DB_HOST di file .env.';
        case 'ECONNREFUSED':
        case 'PROTOCOL_CONNECTION_LOST':
        case 'ETIMEDOUT':
        default:
            return 'Aplikasi belum bisa terhubung ke database. Pastikan layanan MySQL sedang aktif, lalu muat ulang halaman.';
    }
};

module.exports = {
    isDbConnectionError,
    getDbErrorMessage
};
