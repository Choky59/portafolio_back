import request from "supertest";
import { Express } from "express";
import { setupTestApp } from "./helpers";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { validateProyecto, validateVideo } from "../src/routes/proyectos/proyectos.helpers.misc";
import { loadProyectos } from "../src/routes/proyectos/proyectos.service";

let app: Express;
let teardown: () => Promise<void>;

beforeAll(async () => {
  ({ app, teardown } = await setupTestApp());
});

afterAll(async () => {
  await teardown?.();
});

describe("GET /api/proyectos", () => {
  it("lists every project as a summary, sorted by numero", async () => {
    const res = await request(app).get("/api/proyectos");
    expect(res.status).toBe(200);
    expect(res.body.proyectos.length).toBeGreaterThanOrEqual(1);

    const p1 = res.body.proyectos[0];
    expect(p1).toMatchObject({ slug: "se-puede-salir", numero: 1, enVivo: true });
    // summary only
    expect(p1.problema).toBeUndefined();

    const numeros = res.body.proyectos.map((p: any) => p.numero);
    expect(numeros).toEqual([...numeros].sort((a: number, b: number) => a - b));
  });
});

describe("GET /api/proyectos/:slug", () => {
  it("returns detail with neighbours", async () => {
    const res = await request(app).get("/api/proyectos/se-puede-salir");
    expect(res.status).toBe(200);
    expect(res.body.proyecto.titulo).toBe("¿Se puede salir?");
    expect(res.body.anterior).toBeNull();
    expect("siguiente" in res.body).toBe(true);
  });

  it("includes the videos from the videos/ folder, sorted by parte, with their article", async () => {
    const res = await request(app).get("/api/proyectos/se-puede-salir");
    const videos = res.body.proyecto.videos;
    const partes = videos.map((v: any) => v.parte);
    expect(partes.slice(0, 2)).toEqual([1, 2]);
    expect(partes).toEqual([...partes].sort((a: number, b: number) => a - b));
    expect(videos[1]).toMatchObject({ slug: "quien-le-habla-a-mi-servidor", vertical: true });
    expect(videos[1].articulo.length).toBeGreaterThan(0);
    expect(videos[1].articulo[0]).toHaveProperty("titulo");
  });

  it("404 for unknown slugs", async () => {
    const res = await request(app).get("/api/proyectos/no-existe");
    expect(res.status).toBe(404);
    expect(res.body.error.key).toBe("PROYECTO_NOT_FOUND");
  });

  it("400 for malformed slugs", async () => {
    expect((await request(app).get("/api/proyectos/..%2F..%2Fpackage")).status).toBe(400);
    expect((await request(app).get("/api/proyectos/Mayusculas")).status).toBe(400);
  });
});

describe("validateProyecto", () => {
  const base = {
    slug: "demo",
    numero: 2,
    titulo: "Demo",
    resumen: "Resumen",
    fecha: "2026-10-05",
    tecnologias: ["ESP32"],
  };

  it("fills optional arrays with defaults", () => {
    const { proyecto, errors } = validateProyecto(base, "demo");
    expect(errors).toEqual([]);
    expect(proyecto?.videos).toEqual([]);
    expect(proyecto?.modelo3d).toBeNull();
    expect(proyecto?.enVivo).toBe(false);
  });

  it("reports slug mismatch and non-https media", () => {
    const { proyecto, errors } = validateProyecto(
      { ...base, slug: "otro", escenas: [{ titulo: "A1", src: "http://cdn.example.com/a1.mp4" }] },
      "demo"
    );
    expect(proyecto).toBeUndefined();
    expect(errors.join(" ")).toMatch(/slug/);
    expect(errors.join(" ")).toMatch(/https/);
  });

  it("tells you to move 'videos' to the videos/ folder", () => {
    const { errors } = validateProyecto({ ...base, videos: [] }, "demo");
    expect(errors.join(" ")).toMatch(/content\/proyectos\/demo\/videos/);
  });
});

describe("validateVideo", () => {
  const base = { slug: "parte-uno", parte: 1, titulo: "Parte uno", resumen: "R" };

  it("accepts a video without source (coming soon) and fills defaults", () => {
    const { video, errors } = validateVideo(base, "parte-uno");
    expect(errors).toEqual([]);
    expect(video).toMatchObject({ vertical: true, temas: [], articulo: [] });
    expect(video?.src).toBeUndefined();
  });

  it("accepts an MP4 src or a youtubeId, with an article", () => {
    const conSrc = validateVideo(
      {
        ...base,
        src: "https://firebasestorage.googleapis.com/v0/b/x/o/a.mp4?alt=media",
        vertical: false,
        articulo: [{ titulo: "Intro", texto: "Hola", puntos: ["a", "b"] }],
      },
      "parte-uno"
    );
    expect(conSrc.errors).toEqual([]);
    expect(conSrc.video?.vertical).toBe(false);
    expect(validateVideo({ ...base, youtubeId: "dQw4w9WgXcQ" }, "parte-uno").errors).toEqual([]);
  });

  it("reports every problem", () => {
    const { video, errors } = validateVideo(
      {
        slug: "otro",
        parte: 0,
        titulo: "",
        resumen: "R",
        src: "http://x.com/a.mp4",
        youtubeId: "nope",
        articulo: [{ titulo: "Sin texto" }],
      },
      "parte-uno"
    );
    const todo = errors.join(" | ");
    expect(video).toBeUndefined();
    expect(todo).toMatch(/slug/);
    expect(todo).toMatch(/parte/);
    expect(todo).toMatch(/titulo/);
    expect(todo).toMatch(/src' must be an https/);
    expect(todo).toMatch(/youtubeId/);
    expect(todo).toMatch(/not both/);
    expect(todo).toMatch(/articulo\[0\]\.texto/);
  });
});

describe("loadProyectos with a videos/ folder", () => {
  let dir: string;

  function escribir(rel: string, data: object) {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data));
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "proyectos-"));
    escribir("demo.json", { slug: "demo", numero: 1, titulo: "Demo", resumen: "R", fecha: "2026-10-05", tecnologias: [] });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    loadProyectos(); // restore the real content for the other tests
  });

  it("refuses to boot when two videos use the same parte", () => {
    escribir("demo/videos/a.json", { slug: "a", parte: 1, titulo: "A", resumen: "R" });
    escribir("demo/videos/b.json", { slug: "b", parte: 1, titulo: "B", resumen: "R" });
    expect(() => loadProyectos(dir)).toThrow(/parte 1 is used by more than one video/);
  });

  it("names the file of an invalid video", () => {
    escribir("demo/videos/a.json", { slug: "otro", parte: 1, titulo: "A", resumen: "R" });
    expect(() => loadProyectos(dir)).toThrow(/demo\/videos\/a\.json: 'slug' must be "a"/);
  });
});
