import { Collection, Db, MongoClient } from "mongodb";
import { IProfile } from "../@types/collections/users/profile";
import { ISession } from "../@types/collections/users/session";
import { IDevice } from "../@types/collections/devices/device";
import { ITelemetry } from "../@types/collections/devices/telemetry";
import { IVideoAsignacion } from "../@types/collections/contenido/videoAsignacion";
import { ICaptura, IFuentePulso } from "../@types/collections/pulso/captura";
import { IActorCatalogo, IConsumo, IEtiqueta, IEvento, INota } from "../@types/collections/pulso/nota";
import { ITrabajo } from "../@types/collections/pulso/trabajo";
import { ICalle, IColonia, IGeocache, ILugarConocido } from "../@types/collections/pulso/mapa";

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

  /** El pulso de Hermosillo (pulsoCapturas/pulsoFuentes are written by the news scrapper) */
  get Pulso() {
    const db = this.db;
    return {
      Fuentes: (): Collection<IFuentePulso> => db.collection<IFuentePulso>("pulsoFuentes"),
      Capturas: (): Collection<ICaptura> => db.collection<ICaptura>("pulsoCapturas"),
      Notas: (): Collection<INota> => db.collection<INota>("pulsoNotas"),
      Consumo: (): Collection<IConsumo> => db.collection<IConsumo>("pulsoConsumo"),
      Trabajos: (): Collection<ITrabajo> => db.collection<ITrabajo>("pulsoTrabajos"),
      Eventos: (): Collection<IEvento> => db.collection<IEvento>("pulsoEventos"),
      Actores: (): Collection<IActorCatalogo> => db.collection<IActorCatalogo>("pulsoActores"),
      Etiquetas: (): Collection<IEtiqueta> => db.collection<IEtiqueta>("pulsoEtiquetas"),
      /* Map base from OpenStreetMap (npm run pulso:mapa-base) and the geocoding cache */
      Calles: (): Collection<ICalle> => db.collection<ICalle>("pulsoCalles"),
      Colonias: (): Collection<IColonia> => db.collection<IColonia>("pulsoColonias"),
      Geocache: (): Collection<IGeocache> => db.collection<IGeocache>("pulsoGeocache"),
      LugaresConocidos: (): Collection<ILugarConocido> => db.collection<ILugarConocido>("pulsoLugaresConocidos"),
    };
  }

  get Contenido() {
    const db = this.db;
    return {
      VideoAsignaciones: (): Collection<IVideoAsignacion> => {
        return db.collection<IVideoAsignacion>("videoAsignaciones");
      },
    };
  }
}
