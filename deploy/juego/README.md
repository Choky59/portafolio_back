# Servidor del juego en Google Cloud (Querétaro)

Solo el servidor del juego (Socket.IO en `/juego`) corre en una VM cerca de los jugadores. La API y MongoDB se quedan en Heroku.

Cada push a `master` que toque el juego lo despliega solo: `.github/workflows/deploy-juego-gcp.yml`. Si un front no tiene `VITE_JUEGO_URL`, sigue usando el juego de Heroku, así que no se rompe nada mientras configuras.

```
jugadores ──wss──> Caddy (HTTPS, :443) ──> servidor del juego (:3000)    [VM en northamerica-south1]
fronts ──https──> API en Heroku                                           [sin cambios]
```

## Configuración (una sola vez)

Los comandos son para Cloud Shell, la terminal que se abre desde el ícono `>_` arriba a la derecha en console.cloud.google.com. Cambia `MI_PROYECTO` por el id de tu proyecto.

### 1. Proyecto, APIs y repositorio de imágenes

```bash
gcloud config set project MI_PROYECTO
gcloud services enable compute.googleapis.com artifactregistry.googleapis.com

gcloud artifacts repositories create juego \
  --repository-format=docker --location=northamerica-south1
```

### 2. La VM

e2-small con Debian 12 y una IP fija. La VM usa su cuenta de servicio por defecto y solo necesita leer imágenes.

```bash
gcloud compute addresses create ip-juego --region=northamerica-south1

gcloud compute instances create servidor-juego \
  --zone=northamerica-south1-a \
  --machine-type=e2-small \
  --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-size=10GB \
  --address=ip-juego \
  --tags=juego-web \
  --scopes=cloud-platform

gcloud compute firewall-rules create juego-web \
  --allow=tcp:80,tcp:443 --target-tags=juego-web
```

Dale a la VM permiso de leer el repositorio de imágenes:

```bash
NUMERO=$(gcloud projects describe MI_PROYECTO --format='value(projectNumber)')
gcloud artifacts repositories add-iam-policy-binding juego --location=northamerica-south1 \
  --member="serviceAccount:${NUMERO}-compute@developer.gserviceaccount.com" \
  --role=roles/artifactregistry.reader
```

### 3. Preparar la VM

Entra por SSH (botón **SSH** en Compute Engine → VM instances) y corre:

```bash
curl -fsSL https://raw.githubusercontent.com/Choky59/portafolio_back/master/deploy/juego/preparar-vm.sh | bash -s -- northamerica-south1
```

Si el repo es privado, copia el contenido de `preparar-vm.sh` a la VM y corre `bash preparar-vm.sh northamerica-south1`.

### 4. El dominio (HTTPS)

Caddy saca el certificado solo, pero necesita un nombre que apunte a la IP:

- **Con dominio propio:** crea un registro `A`, por ejemplo `juego.tudominio.com`, que apunte a la IP. La ves con `gcloud compute addresses describe ip-juego --region=northamerica-south1 --format='value(address)'`.
- **Sin dominio:** usa sslip.io, la IP con guiones. Por ejemplo, si la IP es `34.1.2.3`, el dominio es `34-1-2-3.sslip.io`.

### 5. La cuenta de servicio para GitHub

```bash
gcloud iam service-accounts create deploy-juego --display-name="Deploy del juego (GitHub)"
SA=deploy-juego@MI_PROYECTO.iam.gserviceaccount.com

for rol in roles/artifactregistry.writer roles/compute.instanceAdmin.v1 roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding MI_PROYECTO --member="serviceAccount:$SA" --role=$rol
done

gcloud iam service-accounts keys create llave-deploy.json --iam-account=$SA
cat llave-deploy.json   # cópiala completa para el paso 6 y luego bórrala: rm llave-deploy.json
```

### 6. GitHub

En el repo `portafolio_back` → **Settings → Secrets and variables → Actions**:

| Tipo | Nombre | Valor |
|---|---|---|
| Secret | `GCP_SA_KEY` | el contenido completo de `llave-deploy.json` |
| Variable | `GCP_PROJECT` | `MI_PROYECTO` |
| Variable | `GCP_REGION` | `northamerica-south1` |
| Variable | `GCP_ZONE` | `northamerica-south1-a` |
| Variable | `GCP_VM` | `servidor-juego` |
| Variable | `GCP_REPO` | `juego` |
| Variable | `JUEGO_DOMINIO` | el del paso 4, sin `https://` |
| Variable | `CORS_ORIGIN` | los sitios que juegan, separados por coma. Por ejemplo: `https://tu-portafolio.web.app,https://tu-juego.web.app,capacitor://localhost,https://localhost` |

Luego ve a **Actions → Deploy game server (Google Cloud) → Run workflow**. Al terminar, `https://JUEGO_DOMINIO/salud` responde `ok`.

### 7. Los fronts

En el `.env` de `crash_game` y de `portafolio_front`:

```
VITE_JUEGO_URL=https://JUEGO_DOMINIO
```

Si el sitio tiene Content-Security-Policy (`firebase.json`), agrega `https://JUEGO_DOMINIO wss://JUEGO_DOMINIO` a `connect-src`.

## Revisar el servidor

Por SSH en la VM:

```bash
cd /opt/juego
sudo docker compose ps          # ¿corren juego y caddy?
sudo docker compose logs -f     # registros en vivo
```

## Costo aproximado

Una e2-small más la IP, el disco y el tráfico salen en unos US$20–25 al mes. Confírmalo en la [calculadora de Google Cloud](https://cloud.google.com/products/calculator) con la región `northamerica-south1`.
