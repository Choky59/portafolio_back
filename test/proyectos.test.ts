import request from "supertest";
import { Express } from "express";
import { setupTestApp } from "./helpers";
import { validateProyecto } from "../src/routes/proyectos/proyectos.helpers.misc";

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
    expect(Array.isArray(res.body.proyecto.videos)).toBe(true);
    expect(res.body.anterior).toBeNull();
    expect("siguiente" in res.body).toBe(true);
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

  it("reports slug mismatch, bad youtube ids and non-https media", () => {
    const { proyecto, errors } = validateProyecto(
      {
        ...base,
        slug: "otro",
        videos: [{ titulo: "Parte 1", youtubeId: "nope" }],
        escenas: [{ titulo: "A1", src: "http://cdn.example.com/a1.mp4" }],
      },
      "demo"
    );
    expect(proyecto).toBeUndefined();
    expect(errors.join(" ")).toMatch(/slug/);
    expect(errors.join(" ")).toMatch(/youtubeId/);
    expect(errors.join(" ")).toMatch(/https/);
  });
});
