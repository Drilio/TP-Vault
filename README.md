# Étape 1 : Lancer le conteneur OpenBao manuellement
```bash
cp .env.sample .env
```

```bash
cd app/
npm install
cd ..
```
ensuite : 

```bash
sudo chown -R 100:100 ./openbao
```

```bash
docker run --rm -it \
--name openbao \
-p 8200:8200 \
-v $(pwd)/openbao:/vault \
openbao/openbao:latest server -config=/vault/config.hcl
```

Cela :

Monte la config locale (config.hcl)

Lance Vault sur le port 8200

Pas de persistance


# Étape 2 : Initialiser Vault manuellement

```bash
docker exec -it openbao sh
```

```bash
export VAULT_ADDR=http://127.0.0.1:8200

vault operator init -key-shares=1 -key-threshold=1
```
- Copie le Unseal Key et le Root Token dans le .env au variable correspondantes :
  OPENBAO_KEY=
  OPENBAO_TOKEN=

```bash
vault operator unseal <Unseal_Key>
vault login <Root_Token>
```

# Etape 3: injecter un secret 

```bash
vault secrets enable -path=secret kv-v2

vault kv put secret/mariadb \
  db_host=mariadb \
  db_port=3306 \
  db_user=testvault \
  db_password=vaultpass \
  db_name=testvault
```

# Etape 4 : lance la stack


```bash
docker compose up --build
```

connecte openbao au reseau docker :

```bash
docker network connect tp-vault_default openbao
```
Si un erreur apparait
```bash 
docker compose down
docker compose up
```

ensuite tu peux aller sur : http://localhost:3000/ 

ceci créé :
- 1 livre :
  - titre : 1984
- 4 utilisateurs : 
  -     ['alice', 'alicepass'],
        ['bob', 'bobpass'],
        ['carol', 'carolpass'],
        ['dave', 'davepass'],

Les mdp etant stocké hashé par Bcrypt

# Etape 4 : lance le frontend

```bash
 cd frontend/
 npx serve . -l 5500
```

- va sur : http://localhost:5500/


# OTP :
1. connecte toi avec 
Nom d'utilisateur: alice
Mot de passe: alicepass

2. Scan le QRCode avec une app type FreeOTP
3. tape le code dans Code OTP input
4. Valider OTP 

# Stratégie pour empêcher le rejeu des requêtes : 
regarde ./app/antiReplay.js

Je l'utilise que sur Login dans index.js ligne 125


### TO STORE
Unseal Key 1:

Initial Root Token: 
