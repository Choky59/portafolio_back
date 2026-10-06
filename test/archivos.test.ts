import request from "supertest";
import { Express } from "express";
import { expectNoSecrets, login, setupTestApp } from "./helpers";
import { construirPath, nombreSeguro, parsePath } from "../src/routes/archivos/archivos.helpers.misc";

/* In-memory stand-in for the Firebase Storage bucket */
const objetos = new Map<string, any>();
let storageConfigurado = true;

const fakeBucket = {
  file: (name: string) => ({
    getSignedUrl: async () => [`https://storage.googleapis.com/fake-bucket/${name}?X-Goog-Signature=abc`],
    exists: async () => [objetos.has(name)],
    getMetadata: async () => [objetos.get(name)],
    setMetadata: async (m: any) => {
      const o = objetos.get(name);
      o.metadata = { ...o.metadata, ...m.metadata };
      return [o];
    },
    delete: async () => {
      objetos.delete(name);
    },
  }),
  getFiles: async ({ prefix }: { prefix: string }) => [
    [...objetos.values()].filter((o) => o.name.startsWith(prefix)).map((o) => ({ metadata: o })),
  ],
};

jest.mock("../src/middlewares/storage/firebaseStorage", () => {
  const actual = jest.requireActual("../src/middlewares/storage/firebaseStorage");
  return {
    ...actual,
    getBucket: () => {
      if (!storageConfigurado) throw new actual.StorageNotConfiguredError();
      return fakeBucket;
    },
  };
});

/** What the browser's PUT to the signed URL would leave in the bucket */
function simularPut(path: string, contentType: string, size: number) {
  objetos.set(path, { name: path, contentType, size: String(size), timeCreated: new Date().toISOString(), metadata: {} });
}

let app: Express;
let teardown: () => Promise<void>;
let token: string;

beforeAll(async () => {
  ({ app, teardown } = await setupTestApp());
  token = await login(app);
});

afterAll(async () => {
  await teardown?.();
});

beforeEach(() => {
  objetos.clear();
  storageConfigurado = true;
});

const subida = (body: object) => request(app).post("/api/archivos/subidas").set("session", token).send(body);

describe("helpers", () => {
  it("builds safe, slug-scoped paths", () => {
    const path = construirPath("se-puede-salir", "video/mp4", "Parte 1 – Señal Final!.MP4", new Date("2026-10-05T23:04:05Z"));
    expect(path).toBe("proyectos/se-puede-salir/videos/20261005-230405-parte-1-senal-final.mp4");
    expect(parsePath(path)).toMatchObject({ slug: "se-puede-salir", categoria: "videos" });
    expect(nombreSeguro("!!!.zip")).toBe("archivo");
  });

  it.each([
    "proyectos/../secrets/x.mp4",
    "otra-cosa/se-puede-salir/videos/20261005-230405-a.mp4",
    "proyectos/se-puede-salir/videos/../../x.mp4",
    "proyectos/se-puede-salir/ejecutables/20261005-230405-a.exe",
    "proyectos/se-puede-salir/videos/a.mp4",
    "proyectos/Se-Puede/videos/20261005-230405-a.mp4",
  ])("rejects %s", (path) => {
    expect(parsePath(path)).toBeNull();
  });
});

describe("POST /api/archivos/subidas", () => {
  it("requires an admin session", async () => {
    const res = await request(app)
      .post("/api/archivos/subidas")
      .send({ slug: "se-puede-salir", nombre: "a.mp4", contentType: "video/mp4", tamano: 10 });
    expect(res.status).toBe(401);
  });

  it("returns a signed upload URL scoped to the project", async () => {
    const res = await subida({ slug: "se-puede-salir", nombre: "Parte 1.mp4", contentType: "video/mp4", tamano: 5_000_000 });
    expect(res.status).toBe(201);
    expect(res.body.path).toMatch(/^proyectos\/se-puede-salir\/videos\/\d{8}-\d{6}-parte-1\.mp4$/);
    expect(res.body.uploadUrl).toMatch(/^https:\/\/storage\.googleapis\.com\//);
    expect(res.body.headers["Content-Type"]).toBe("video/mp4");
    expect(res.body.headers["x-goog-content-length-range"]).toBe(`0,${1024 * 1024 * 1024}`);
  });

  it("puts zips under descargas", async () => {
    const res = await subida({ slug: "se-puede-salir", nombre: "codigo.zip", contentType: "application/zip", tamano: 2048 });
    expect(res.body.path).toMatch(/\/descargas\/.*-codigo\.zip$/);
  });

  it.each([
    [{ slug: "no-existe", nombre: "a.mp4", contentType: "video/mp4", tamano: 10 }, /slug/],
    [{ slug: "se-puede-salir", nombre: "virus.exe", contentType: "application/x-msdownload", tamano: 10 }, /not allowed/],
    [{ slug: "se-puede-salir", nombre: "enorme.mp4", contentType: "video/mp4", tamano: 2 * 1024 ** 3 }, /too large/],
    [{ slug: "se-puede-salir", nombre: "grande.zip", contentType: "application/zip", tamano: 300 * 1024 ** 2 }, /too large/],
  ])("rejects %j", async (body, mensaje) => {
    const res = await subida(body);
    expect(res.status).toBe(400);
    expect(res.body.error.data.join(" ")).toMatch(mensaje);
  });

  it("503 when Storage has no credentials", async () => {
    storageConfigurado = false;
    const res = await subida({ slug: "se-puede-salir", nombre: "a.mp4", contentType: "video/mp4", tamano: 10 });
    expect(res.status).toBe(503);
    expect(res.body.error.key).toBe("STORAGE_NOT_CONFIGURED");
  });
});

describe("upload → confirm → list → delete", () => {
  it("works end to end", async () => {
    const { body: autorizada } = await subida({
      slug: "se-puede-salir",
      nombre: "Parte 1.mp4",
      contentType: "video/mp4",
      tamano: 1234,
    });

    // Confirming before the upload happened
    const antes = await request(app)
      .post("/api/archivos/confirmar")
      .set("session", token)
      .send({ path: autorizada.path, nombre: "Parte 1.mp4" });
    expect(antes.status).toBe(404);

    simularPut(autorizada.path, "video/mp4", 1234);

    const confirmado = await request(app)
      .post("/api/archivos/confirmar")
      .set("session", token)
      .send({ path: autorizada.path, nombre: "Parte 1.mp4" });
    expect(confirmado.status).toBe(200);
    expect(confirmado.body.archivo).toMatchObject({ nombre: "Parte 1.mp4", categoria: "videos", tamano: 1234 });
    expect(confirmado.body.archivo.url).toMatch(
      /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/.+\/o\/proyectos%2Fse-puede-salir%2Fvideos%2F.+\?alt=media&token=[0-9a-f-]{36}$/
    );

    // Confirming twice keeps the same public URL
    const otraVez = await request(app).post("/api/archivos/confirmar").set("session", token).send({ path: autorizada.path });
    expect(otraVez.body.archivo.url).toBe(confirmado.body.archivo.url);

    const lista = await request(app).get("/api/archivos?slug=se-puede-salir").set("session", token);
    expect(lista.status).toBe(200);
    expect(lista.body.archivos).toHaveLength(1);
    expect(lista.body.archivos[0].url).toBe(confirmado.body.archivo.url);
    expectNoSecrets(lista.body);

    const borrado = await request(app)
      .delete(`/api/archivos?path=${encodeURIComponent(autorizada.path)}`)
      .set("session", token);
    expect(borrado.status).toBe(200);

    const vacia = await request(app).get("/api/archivos?slug=se-puede-salir").set("session", token);
    expect(vacia.body.archivos).toHaveLength(0);
  });

  it("refuses to confirm or delete paths outside proyectos/", async () => {
    objetos.set("secretos/llave.json", { name: "secretos/llave.json", metadata: {} });

    const confirmar = await request(app)
      .post("/api/archivos/confirmar")
      .set("session", token)
      .send({ path: "secretos/llave.json" });
    const borrar = await request(app)
      .delete(`/api/archivos?path=${encodeURIComponent("proyectos/../secretos/llave.json")}`)
      .set("session", token);

    expect(confirmar.status).toBe(400);
    expect(borrar.status).toBe(400);
    expect(objetos.has("secretos/llave.json")).toBe(true);
  });

  it("lists only the requested project", async () => {
    simularPut("proyectos/otro-proyecto/videos/20261005-230405-a.mp4", "video/mp4", 10);
    const lista = await request(app).get("/api/archivos?slug=se-puede-salir").set("session", token);
    expect(lista.body.archivos).toHaveLength(0);
  });
});

describe("assigning uploaded videos to project videos", () => {
  const P1 = "proyectos/se-puede-salir/videos/20261006-010000-parte-uno.mp4";
  const P2 = "proyectos/se-puede-salir/videos/20261006-020000-parte-dos.mov";

  const asignar = (path: string, video: string) =>
    request(app).put("/api/archivos/asignacion").set("session", token).send({ path, video });
  const detalle = async () => (await request(app).get("/api/proyectos/se-puede-salir")).body.proyecto;
  const videoDe = async (slug: string) => (await detalle()).videos.find((v: any) => v.slug === slug);

  beforeEach(async () => {
    simularPut(P1, "video/mp4", 100);
    simularPut(P2, "video/quicktime", 200);
    await request(app).delete("/api/archivos/asignacion?slug=se-puede-salir&video=se-puede-salir").set("session", token);
    await request(app).delete("/api/archivos/asignacion?slug=se-puede-salir&video=quien-le-habla-a-mi-servidor").set("session", token);
  });

  it("requires an admin session", async () => {
    const res = await request(app).put("/api/archivos/asignacion").send({ path: P1, video: "se-puede-salir" });
    expect(res.status).toBe(401);
  });

  it("plays the assigned file in the public project page, without a URL in the JSON", async () => {
    expect((await videoDe("se-puede-salir")).src).toBeUndefined();

    const res = await asignar(P1, "se-puede-salir");
    expect(res.status).toBe(200);
    expect(res.body.archivo.asignadoA).toBe("se-puede-salir");

    const video = await videoDe("se-puede-salir");
    expect(video.src).toMatch(/^https:\/\/firebasestorage\.googleapis\.com\/.*parte-uno\.mp4\?alt=media&token=/);
    // The other part is untouched
    expect((await videoDe("quien-le-habla-a-mi-servidor")).src).toBeUndefined();
  });

  it("shows the assignment in the file list", async () => {
    await asignar(P2, "quien-le-habla-a-mi-servidor");
    const lista = await request(app).get("/api/archivos?slug=se-puede-salir").set("session", token);
    const porPath = Object.fromEntries(lista.body.archivos.map((a: any) => [a.path, a.asignadoA]));
    expect(porPath[P2]).toBe("quien-le-habla-a-mi-servidor");
    expect(porPath[P1]).toBeNull();
  });

  it("assigning another file to the same part replaces the previous one", async () => {
    await asignar(P1, "se-puede-salir");
    await asignar(P2, "se-puede-salir");
    expect((await videoDe("se-puede-salir")).src).toMatch(/parte-dos\.mov/);
  });

  it("unassigning goes back to the JSON (coming soon)", async () => {
    await asignar(P1, "se-puede-salir");
    const quitar = await request(app)
      .delete("/api/archivos/asignacion?slug=se-puede-salir&video=se-puede-salir")
      .set("session", token);
    expect(quitar.status).toBe(200);
    expect((await videoDe("se-puede-salir")).src).toBeUndefined();
  });

  it("deleting the file removes its assignment", async () => {
    await asignar(P1, "se-puede-salir");
    await request(app).delete(`/api/archivos?path=${encodeURIComponent(P1)}`).set("session", token);
    expect((await videoDe("se-puede-salir")).src).toBeUndefined();
  });

  it.each([
    ["a part that doesn't exist", P1, "parte-inventada", 400],
    ["a file that isn't a video", "proyectos/se-puede-salir/descargas/20261006-010000-codigo.zip", "se-puede-salir", 400],
    ["a file of another project", "proyectos/otro/videos/20261006-010000-x.mp4", "se-puede-salir", 400],
    ["a file that was never uploaded", "proyectos/se-puede-salir/videos/20261006-030000-nada.mp4", "se-puede-salir", 404],
  ])("rejects %s", async (_caso, path, video, status) => {
    const res = await asignar(path as string, video as string);
    expect(res.status).toBe(status);
  });
});
