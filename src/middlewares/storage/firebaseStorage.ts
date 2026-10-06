/**
 * FILE: firebaseStorage.ts
 *
 * Firebase Storage (Google Cloud Storage) client, created lazily.
 *
 * Credentials, in order:
 *   1. FIREBASE_SERVICE_ACCOUNT        whole service account JSON (Heroku Config Var)
 *   2. GOOGLE_APPLICATION_CREDENTIALS  path to the JSON
 *   3. ./service_account.json          local development (git-ignored)
 * If none is found the server still boots; file routes answer 503.
 */

import { existsSync } from "fs";
import path from "path";
import { Bucket, Storage } from "@google-cloud/storage";

const DEFAULT_BUCKET = "proyectos-andres.firebasestorage.app";
const LOCAL_KEY_FILE = path.resolve(process.cwd(), "service_account.json");

let bucket: Bucket | null = null;

export class StorageNotConfiguredError extends Error {
  constructor() {
    super("Firebase Storage credentials not found");
    this.name = "StorageNotConfiguredError";
  }
}

export function bucketName(): string {
  return process.env.FIREBASE_STORAGE_BUCKET || DEFAULT_BUCKET;
}

function crearStorage(): Storage | null {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (json) {
    const credentials = JSON.parse(json);
    return new Storage({ projectId: credentials.project_id, credentials });
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return new Storage();
  }
  if (existsSync(LOCAL_KEY_FILE)) {
    return new Storage({ keyFilename: LOCAL_KEY_FILE });
  }
  return null;
}

export function getBucket(): Bucket {
  if (bucket) return bucket;
  const storage = crearStorage();
  if (!storage) throw new StorageNotConfiguredError();
  bucket = storage.bucket(bucketName());
  return bucket;
}

/**
 * Public Firebase download URL. Works through the object's download token,
 * so the bucket stays private and Storage rules don't need to change.
 */
export function urlPublica(objectPath: string, token: string): string {
  return (
    `https://firebasestorage.googleapis.com/v0/b/${bucketName()}/o/` +
    `${encodeURIComponent(objectPath)}?alt=media&token=${token}`
  );
}
