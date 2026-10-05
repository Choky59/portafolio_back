/**
 * FILE: mongodb.ts
 *
 * MongoDB connection bootstrap.
 * Owns the shared `Database` instance so services, scripts and tests
 * can use it without importing server.ts.
 */

import { MongoClient } from "mongodb";
import { MongoDatabase } from "../../constants/database";

export let mongoDB: MongoClient;
export let Database: MongoDatabase;

export async function createConnections(uri: string, dbName: string): Promise<void> {
  try {
    mongoDB = await MongoClient.connect(uri);
  } catch (err: any) {
    console.error("Unable to connect to mongo db:", err?.message ?? err);
    process.exit(1);
  }
  Database = new MongoDatabase(mongoDB, dbName);
  console.info(`Connected to MongoDB (db: ${dbName})`);
}

export async function closeConnections(): Promise<void> {
  await mongoDB?.close();
}

export { createIndexes } from "./mongodb.indexes";
