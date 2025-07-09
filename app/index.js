import express from 'express'
import axios from 'axios'
import mysql from 'mysql2/promise'
import bcrypt from 'bcrypt'
import cors from 'cors'
import speakeasy from 'speakeasy'
import { authenticator } from 'otplib'
import qrcodeLib from 'qrcode'
import crypto from 'crypto'
import {antiReplayMiddleware} from "./antiReplay.js";
import cron from 'node-cron'


const VAULT_ADDR = process.env.OPENBAO_URL
const token = process.env.OPENBAO_TOKEN
const app = express()
const port = 3000

app.use(cors({
    origin: '*', // autorise toutes les origines — pour dev uniquement
}))
app.use(express.json())

async function waitForMariaDB(config, retries = 10, delayMs = 2000) {
    for (let i = 0; i < retries; i++) {
        try {
            const conn = await mysql.createConnection(config)
            await conn.ping()
            console.log("✅ Connexion à MariaDB réussie.")
            return conn
        } catch (err) {
            console.warn(`⏳ MariaDB non dispo, tentative ${i + 1}/${retries}...`)
            await new Promise((res) => setTimeout(res, delayMs))
        }
    }
    throw new Error("❌ Impossible de se connecter à MariaDB après plusieurs tentatives.")
}

async function getDbConnection() {
    try {
        const res = await axios.get(`${VAULT_ADDR}/v1/secret/data/mariadb`, {
            headers: { 'X-Vault-Token': token }
        })

        const config = res.data.data.data

        return await waitForMariaDB({
            host: config.db_host,
            port: parseInt(config.db_port),
            user: config.db_user,
            password: config.db_password,
            database: config.db_name
        })
    } catch (err) {
        if (err.response) {
            console.error('💥 Vault error response:', err.response.data)
        } else if (err.request) {
            console.error('📡 Vault no response (network error):', err.message)
        } else {
            console.error('❗ Error setting up request:', err.message)
        }
        throw err
    }
}

async function deleteObsoleteUsers(thresholdDays = 90) {
    const db = await getDbConnection()
    const [result] = await db.execute(
        `DELETE FROM user WHERE last_login_at IS NULL OR last_login_at < (NOW() - INTERVAL ? DAY)`,
        [thresholdDays]
    )
    console.log(`🧹 Utilisateurs supprimés : ${result.affectedRows}`)
    await db.end()
}

cron.schedule('0 0 1 */1 *', async () => {
    console.log('🧹 Tâche CRON : suppression des comptes obsolètes démarrée.')
    try {
        await deleteObsoleteUsers()
        console.log('✅ Tâche CRON terminée avec succès.')
    } catch (err) {
        console.error('❌ Erreur lors de la tâche CRON:', err.message)
    }
})
async function setupDb() {
    const db = await getDbConnection()

    await db.execute(`
        CREATE TABLE IF NOT EXISTS livre (
            id INT AUTO_INCREMENT PRIMARY KEY,
            titre VARCHAR(255) NOT NULL
        )
    `)
    await db.execute(`INSERT IGNORE INTO livre (id, titre) VALUES (1, '1984')`)

    await db.execute(`
        CREATE TABLE IF NOT EXISTS user (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(255) NOT NULL UNIQUE,
            password VARCHAR(255) NOT NULL,
            otp_secret VARCHAR(255),
            last_login_at DATETIME DEFAULT NULL
        )
    `)

    const users = [
        ['alice', 'alicepass'],
        ['bob', 'bobpass'],
        ['carol', 'carolpass'],
        ['dave', 'davepass'],
    ]

    for (const [name, plainPassword] of users) {
        const hashedPassword = await bcrypt.hash(plainPassword, 10)
        const otpSecret = speakeasy.generateSecret({ name: `VaultApp (${name})` })
        await db.execute(
            `INSERT IGNORE INTO user (name, password, otp_secret) VALUES (?, ?, ?)`,
            [name, hashedPassword, otpSecret.base32]
        )
    }

    await db.end()
}

await setupDb()
await deleteObsoleteUsers()

app.get('/', async (req, res) => {
    try {
        const db = await getDbConnection()
        await db.end()
        res.status(200)
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'DB or secret error', details: err.message })
    }
})

app.get('/nonce', (_req, res) => {
    const nonce = crypto.randomUUID()
    res.json({ nonce })
})

app.post('/login', antiReplayMiddleware, express.json(), async (req, res) => {
    const { name, password } = req.body
    if (!name || !password) {
        return res.status(400).json({ error: 'Nom et mot de passe requis.' })
    }

    try {
        const db = await getDbConnection()
        const [rows] = await db.execute('SELECT * FROM user WHERE name = ?', [name])

        if (rows.length === 0) {
            await db.end()
            return res.status(401).json({ error: 'Utilisateur non trouvé.' })
        }

        const user = rows[0]
        const passwordMatch = await bcrypt.compare(password, user.password)

        if (!passwordMatch) {
            await db.end()
            return res.status(401).json({ error: 'Mot de passe incorrect.' })
        }

        let otp_secret = user.otp_secret

        if (!otp_secret) {
            otp_secret = authenticator.generateSecret()
            await db.execute('UPDATE user SET otp_secret = ? WHERE id = ?', [otp_secret, user.id])
        }
        await db.execute('UPDATE user SET last_login_at = NOW() WHERE id = ?', [user.id])

        await db.end()

        const otpauth_url = authenticator.keyuri(user.name, 'VaultApp', otp_secret)
        const qrcode = await qrcodeLib.toDataURL(otpauth_url)

        res.json({
            message: 'Connexion réussie ✅',
            user: { id: user.id, name: user.name },
            otp: {
                otpauth_url,
                qrcode
            }
        })
    } catch (err) {
        console.error('❌ Erreur login:', err.message)
        res.status(500).json({ error: 'Erreur serveur' })
    }
})

app.post('/verify-otp', express.json(), async (req, res) => {
    const { name, token: otp } = req.body

    if (!name || !otp) {
        return res.status(400).json({ error: 'Nom et code OTP requis.' })
    }

    try {
        const db = await getDbConnection()
        const [rows] = await db.execute('SELECT * FROM user WHERE name = ?', [name])
        await db.end()

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Utilisateur non trouvé.' })
        }

        const user = rows[0]

        if (!user.otp_secret) {
            return res.status(400).json({ error: 'OTP non configuré pour cet utilisateur.' })
        }

        authenticator.options = {
            step: 30,
            digits: 6,
            algorithm: 'sha1'
        }

        console.log("otp")
        console.log(otp)
        console.log("user.otp_secret")
        console.log(user.otp_secret)
        const isValid = authenticator.check(otp, user.otp_secret)

        if (!isValid) {
            return res.status(401).json({ error: 'Code OTP invalide.' })
        }

        res.json({ message: '✅ OTP valide.' })
    } catch (err) {
        console.error('❌ Erreur OTP:', err.message)
        res.status(500).json({ error: 'Erreur serveur.' })
    }
})

app.listen(port, () => {
    console.log(`App listening on port ${port}`)
})
