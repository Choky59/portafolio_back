import request from "supertest";
import { Express } from "express";
import { ADMIN, expectNoSecrets, login, setupTestApp } from "./helpers";
import { Database } from "../src/middlewares/database/mongodb";

let app: Express;
let teardown: () => Promise<void>;

beforeAll(async () => {
  ({ app, teardown } = await setupTestApp());
});

afterAll(async () => {
  await teardown?.();
});

describe("session (login / logout)", () => {
  it("logs in with valid credentials and never returns secrets", async () => {
    const res = await request(app)
      .post("/api/session")
      .send({ username: ADMIN.username, password: ADMIN.password, expiration: 0 });

    expect(res.status).toBe(200);
    expect(typeof res.body.session.token).toBe("string");
    expect(res.body.user.username).toBe(ADMIN.username);
    expectNoSecrets(res.body);

    // Only the hash is stored
    const stored = await Database.Users.Sessions().findOne({});
    expect(stored?.tokenHash).toBeDefined();
    expect(stored?.tokenHash).not.toBe(res.body.session.token);
  });

  it("returns the same generic 401 for unknown user and wrong password", async () => {
    const wrongPass = await request(app)
      .post("/api/session")
      .send({ username: ADMIN.username, password: "nope-nope-nope" });
    const unknownUser = await request(app)
      .post("/api/session")
      .send({ username: "ghost", password: "nope-nope-nope" });

    expect(wrongPass.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPass.body).toEqual(unknownUser.body);
    expect(wrongPass.body.error.key).toBe("INVALID_CREDENTIALS");
  });

  it("rejects invalid expiration values", async () => {
    const res = await request(app)
      .post("/api/session")
      .send({ username: ADMIN.username, password: ADMIN.password, expiration: 9 });
    expect(res.status).toBe(400);
  });
});

describe("sessionValidation", () => {
  it("requires the session header", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("rejects an unknown token", async () => {
    const res = await request(app).get("/api/auth/me").set("session", "not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("returns the current user with a valid session", async () => {
    const token = await login(app);
    const res = await request(app).get("/api/auth/me").set("session", token);
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe(ADMIN.username);
    expectNoSecrets(res.body);
  });

  it("rejects an expired session", async () => {
    const token = await login(app);
    await Database.Users.Sessions().updateMany({}, { $set: { expiration: new Date(Date.now() - 1000) } });
    const res = await request(app).get("/api/auth/me").set("session", token);
    expect(res.status).toBe(401);
  });

  it("rejects a session after logout", async () => {
    const token = await login(app);
    const logout = await request(app).delete("/api/session").set("session", token);
    expect(logout.status).toBe(200);

    const res = await request(app).get("/api/auth/me").set("session", token);
    expect(res.status).toBe(401);
  });

  it("lists active sessions marking the current one, without hashes", async () => {
    const other = await login(app);
    const token = await login(app);
    const res = await request(app).get("/api/session").set("session", token);

    expect(res.status).toBe(200);
    expect(res.body.sessions.length).toBeGreaterThanOrEqual(2);
    expect(res.body.sessions.filter((s: any) => s.current)).toHaveLength(1);
    expectNoSecrets(res.body);

    // closeAll ends every session
    await request(app).delete("/api/session").set("session", token).send({ closeAll: true });
    expect((await request(app).get("/api/auth/me").set("session", other)).status).toBe(401);
  });
});

describe("users (ADMIN)", () => {
  it("creates another admin, rejects duplicates and hides passwords", async () => {
    const token = await login(app);
    const newUser = {
      username: "second.admin",
      email: "second@example.com",
      displayName: "Second",
      password: "another-long-pass",
    };

    const created = await request(app).post("/api/auth/users").set("session", token).send(newUser);
    expect(created.status).toBe(201);
    expectNoSecrets(created.body);

    const dup = await request(app).post("/api/auth/users").set("session", token).send(newUser);
    expect(dup.status).toBe(409);

    const list = await request(app).get("/api/auth/users").set("session", token);
    expect(list.status).toBe(200);
    expect(list.body.users).toHaveLength(2);
    expectNoSecrets(list.body);
  });

  it("deactivating a user ends its sessions and blocks login", async () => {
    const token = await login(app);
    const secondToken = await login(app, "second.admin", "another-long-pass");
    const me = await request(app).get("/api/auth/me").set("session", secondToken);

    const res = await request(app)
      .patch(`/api/auth/users/${me.body.user._id}`)
      .set("session", token)
      .send({ status: "INACTIVE" });
    expect(res.status).toBe(200);

    expect((await request(app).get("/api/auth/me").set("session", secondToken)).status).toBe(401);
    const relogin = await request(app)
      .post("/api/session")
      .send({ username: "second.admin", password: "another-long-pass" });
    expect(relogin.status).toBe(401);
  });

  it("cannot deactivate yourself", async () => {
    const token = await login(app);
    const me = await request(app).get("/api/auth/me").set("session", token);
    const res = await request(app)
      .patch(`/api/auth/users/${me.body.user._id}`)
      .set("session", token)
      .send({ status: "INACTIVE" });
    expect(res.status).toBe(400);
  });

  it("returns 400 (not 500) for an invalid user id", async () => {
    const token = await login(app);
    const res = await request(app).patch("/api/auth/users/not-an-id").set("session", token).send({});
    expect(res.status).toBe(400);
  });

  it("changes password and ends other sessions", async () => {
    const other = await login(app);
    const token = await login(app);

    const wrong = await request(app)
      .patch("/api/auth/me/password")
      .set("session", token)
      .send({ currentPassword: "wrong-password", newPassword: "brand-new-password" });
    expect(wrong.status).toBe(401);

    const ok = await request(app)
      .patch("/api/auth/me/password")
      .set("session", token)
      .send({ currentPassword: ADMIN.password, newPassword: "brand-new-password" });
    expect(ok.status).toBe(200);

    expect((await request(app).get("/api/auth/me").set("session", token)).status).toBe(200);
    expect((await request(app).get("/api/auth/me").set("session", other)).status).toBe(401);

    ADMIN.password = "brand-new-password";
  });
});

describe("login rate limit", () => {
  it("blocks after too many failed attempts", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const res = await request(app)
        .post("/api/session")
        .send({ username: "ghost", password: "wrong-wrong" });
      last = res.status;
    }
    expect(last).toBe(429);
  });
});
