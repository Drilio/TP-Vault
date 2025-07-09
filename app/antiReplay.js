const usedNonces = new Set();

export function antiReplayMiddleware(req, res, next) {
    const nonce = req.headers['x-nonce'];

    if (!nonce) {
        return res.status(400).json({ error: 'Nonce manquant.' });
    }

    if (usedNonces.has(nonce)) {
        return res.status(403).json({ error: 'Nonce déjà utilisé (rejeu détecté).' });
    }

    usedNonces.add(nonce);
    setTimeout(() => usedNonces.delete(nonce), 60 * 1000);

    next();
}
