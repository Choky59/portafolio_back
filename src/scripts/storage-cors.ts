/**
 * Sets the bucket CORS so the admin panel can upload straight from the browser
 * (PUT to a signed URL) and the site can play/download the files.
 * Run once, and again whenever the site domains change:
 *
 *   npm run storage:cors
 *
 * Reads: CORS_ORIGIN (comma separated), FIREBASE_STORAGE_BUCKET, and the service account
 * (FIREBASE_SERVICE_ACCOUNT, GOOGLE_APPLICATION_CREDENTIALS or ./service_account.json).
 */
import "dotenv/config";
import { bucketName, getBucket } from "../middlewares/storage/firebaseStorage";

async function main() {
  const origenes = (process.env.CORS_ORIGIN ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);

  if (!origenes.length) {
    console.error("CORS_ORIGIN is empty: add the site origins (e.g. http://localhost:5173,https://proyectos-andres.web.app)");
    process.exit(1);
  }

  await getBucket().setCorsConfiguration([
    {
      origin: origenes,
      method: ["GET", "HEAD", "PUT"],
      responseHeader: ["Content-Type", "x-goog-content-length-range"],
      maxAgeSeconds: 3600,
    },
  ]);

  const [meta] = await getBucket().getMetadata();
  console.info(`CORS updated on ${bucketName()}:`);
  console.info(JSON.stringify(meta.cors, null, 2));
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
