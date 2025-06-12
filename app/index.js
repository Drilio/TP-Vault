import express from 'express'
import axios from 'axios'
import mysql from 'mysql2/promise'

const VAULT_ADDR = process.env.VAULT_ADDR
const VAULT_TOKEN = process.env.VAULT_TOKEN

const app = express()
const port = 3000

async function getDbConnection() {
    const res = await axios.get(`${VAULT_ADDR}/v1/secret/data/mariadb`, {
        headers: { 'X-Vault-Token': VAULT_TOKEN }
    })
    const config = res.data.data.data
        console.log("config",config)
    return await mysql.createConnection({
        host: config.db_host,
        port: parseInt(config.db_port),
        user: config.db_user,
        password: config.db_password,
        database: config.db_name
    })
}

app.get('/', async (req, res) => {
    try {
        const db = await getDbConnection()
        await db.execute(`
            CREATE TABLE IF NOT EXISTS livre (
                                                 id INT AUTO_INCREMENT PRIMARY KEY,
                                                 titre VARCHAR(255) NOT NULL
                )
        `)
        await db.execute(`INSERT IGNORE INTO livre (id, titre) VALUES (1, '1984')`)
        const [rows] = await db.execute('SELECT * FROM livre')
        res.json(rows)
        await db.end()
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'DB or secret error', details: err.message })
    }
})

app.listen(port, () => {
    console.log(`App listening on port ${port}`)
})
