import { Collection, Db, MongoClient } from "mongodb";
import { IProfile } from "../@types/collections/users/profile";
import { ISession } from "../@types/collections/users/session";
import { IDevice } from "../@types/collections/devices/device";
import { ITelemetry } from "../@types/collections/devices/telemetry";

export class MongoDatabase {
  private db: Db;
  constructor(_mongoClient: MongoClient, dbName: string) {
    this.db = _mongoClient.db(dbName);
  }

  get Users() {
    const db = this.db;
    return {
      Profiles: (): Collection<IProfile> => {
        return db.collection<IProfile>("profiles");
      },
      Sessions: (): Collection<ISession> => {
        return db.collection<ISession>("sessions");
      },
    };
  }

  get Devices() {
    const db = this.db;
    return {
      Devices: (): Collection<IDevice> => {
        return db.collection<IDevice>("devices");
      },
      Telemetry: (): Collection<ITelemetry> => {
        return db.collection<ITelemetry>("telemetry");
      },
    };
  }
}
