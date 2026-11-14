import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express, { type Router } from "express";
import {
  createMockCtx,
  createTestDb,
  type MockPluginContext,
  type TestDb,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";
import { activate } from "../../src/backend/index.js";
import { fakeFetch, json, status } from "./fake-fetch.js";

const pluginDir = fileURLToPath(new URL("../..", import.meta.url));
const manifest = manifestJson as unknown as PluginManifest;

let refuse = false;
let up = true;
const router = fakeFetch((url, init) => {
  if (url.hostname !== "10.0.0.1") return undefined;
  if (refuse) return status(401);
  const path = url.pathname;
  if (path === "/rest/system/resource") {
    return json({
      "board-name": "RB",
      version: "7",
      uptime: "1h",
      "cpu-load": "3",
    });
  }
  if (path === "/rest/system/identity") return json({ name: "edge" });
  if (path === "/rest/interface") {
    return json([
      {
        ".id": "*1",
        name: "ether1",
        type: "ether",
        running: String(up),
        "rx-byte": "10",
        "tx-byte": "20",
      },
    ]);
  }
  if (path === "/rest/ip/dhcp-server/lease") {
    return json([{ address: "10.0.0.9", "mac-address": "aa:aa:aa:aa:aa:01" }]);
  }
  if (init.method === "PATCH" || init.method === "POST") return json({});
  return json([]);
});

let db: TestDb;
let mock: MockPluginContext;
let server: http.Server;
let port: number;

async function setup(permissions: string[]) {
  db = await createTestDb(pluginDir);
  for (const user of ["user-1", "user-2"]) {
    db.sqlite
      .prepare("INSERT INTO users (id, username) VALUES (?, ?)")
      .run(user, user);
  }
  let routes: Router | null = null;
  mock = createMockCtx({
    sandbox: true,
    pluginId: manifest.id,
    manifest,
    capabilities: manifest.capabilities,
    db: db.database,
    router: () => (routes = express.Router()),
    permissions,
    fetch: router as never,
  });
  await activate(mock.ctx);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    mock.setActor(req.header("x-test-user") ?? "user-1");
    next();
  });
  app.use((req, res, next) => routes!(req, res, next));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
}

async function request(method: string, path: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

const ALL = ["network-devices.view", "network-devices.manage"];

const input = {
  name: "edge",
  driver: "routeros",
  address: "10.0.0.1",
  options: { scheme: "https" },
  credentials: { username: "api", password: "SECRET-PASSWORD" },
};

async function addDevice(extra: Record<string, unknown> = {}) {
  const created = await request("POST", "/devices", { ...input, ...extra });
  expect(created.status).toBe(201);
  return created.body.device.id as number;
}

beforeEach(async () => {
  refuse = false;
  up = true;
  router.mockClear();
  router.calls.length = 0;
  await setup(ALL);
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

describe("devices", () => {
  it("lists the device types", async () => {
    const result = await request("GET", "/drivers");
    expect(result.body.drivers.map((d: { id: string }) => d.id).sort()).toEqual(
      ["openwrt", "opnsense", "routeros", "snmp"],
    );
  });

  it("adds a device and never shows or stores the keys in plain text", async () => {
    await addDevice();
    const list = await request("GET", "/devices");
    expect(list.body.devices).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain("SECRET-PASSWORD");
    const stored = db.sqlite
      .prepare("SELECT credentials FROM p_network_devices_devices")
      .get() as { credentials: string };
    expect(stored.credentials).not.toContain("SECRET-PASSWORD");
  });

  it("reads the device after it is added", async () => {
    const id = await addDevice();
    const polled = await request("POST", `/devices/${id}/poll`);
    expect(polled.body.device.status).toBe("up");
    expect(polled.body.device.snapshot.info.name).toBe("edge");
    expect(polled.body.device.snapshot.ports[0]).toMatchObject({
      name: "ether1",
      up: true,
    });
  });

  it("works out port rates from two readings", async () => {
    const id = await addDevice();
    await request("POST", `/devices/${id}/poll`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const polled = await request("POST", `/devices/${id}/poll`);
    // The counters did not move, so the rate is zero rather than missing
    expect(polled.body.device.snapshot.ports[0].rxBps).toBe(0);
  });

  it("marks a device down after two failed readings and says why", async () => {
    const id = await addDevice();
    await request("POST", `/devices/${id}/poll`);
    refuse = true;
    const first = await request("POST", `/devices/${id}/poll`);
    expect(first.body.device.status).toBe("up");
    const second = await request("POST", `/devices/${id}/poll`);
    expect(second.body.device.status).toBe("down");
    expect(second.body.device.lastError).toMatch(/refused the login/);
  });

  it("rejects bad input", async () => {
    expect(
      (await request("POST", "/devices", { ...input, name: " " })).status,
    ).toBe(400);
    expect(
      (await request("POST", "/devices", { ...input, address: "a b" })).status,
    ).toBe(400);
    expect(
      (await request("POST", "/devices", { ...input, driver: "nope" })).status,
    ).toBe(400);
    expect(
      (await request("POST", "/devices", { ...input, credentials: {} })).status,
    ).toBe(400);
    expect(
      (await request("POST", "/devices", { ...input, ca: "not a cert" }))
        .status,
    ).toBe(400);
  });

  it("refuses a second device with the same name", async () => {
    await addDevice();
    const again = await request("POST", "/devices", input);
    expect(again.status).toBe(409);
  });

  it("keeps the keys when an edit sends none, and replaces them when it does", async () => {
    const id = await addDevice();
    const before = db.sqlite
      .prepare("SELECT credentials FROM p_network_devices_devices")
      .get() as { credentials: string };
    await request("PUT", `/devices/${id}`, {
      name: "edge2",
      address: "10.0.0.1",
    });
    const same = db.sqlite
      .prepare("SELECT name, credentials FROM p_network_devices_devices")
      .get() as { name: string; credentials: string };
    expect(same.name).toBe("edge2");
    expect(same.credentials).toBe(before.credentials);
    await request("PUT", `/devices/${id}`, {
      name: "edge2",
      address: "10.0.0.1",
      credentials: { username: "api", password: "NEW" },
    });
    const changed = db.sqlite
      .prepare("SELECT credentials FROM p_network_devices_devices")
      .get() as { credentials: string };
    expect(changed.credentials).not.toBe(before.credentials);
  });

  it("tests keys without saving", async () => {
    const result = await request("POST", "/devices/test", input);
    expect(result.status).toBe(200);
    expect(result.body.info.name).toBe("edge");
    expect((await request("GET", "/devices")).body.devices).toHaveLength(0);
    refuse = true;
    expect((await request("POST", "/devices/test", input)).status).toBe(502);
  });

  it("lists clients", async () => {
    const id = await addDevice();
    const result = await request("GET", `/devices/${id}/clients`);
    expect(result.body.clients).toEqual([
      expect.objectContaining({ mac: "aa:aa:aa:aa:aa:01", ip: "10.0.0.9" }),
    ]);
  });

  it("turns a port off and restarts the device", async () => {
    const id = await addDevice();
    router.calls.length = 0;
    const off = await request(
      "POST",
      `/devices/${id}/ports/${encodeURIComponent("*1")}/state`,
      { up: false },
    );
    expect(off.status).toBe(200);
    expect(router.calls.some((call) => call.init.method === "PATCH")).toBe(
      true,
    );
    const reboot = await request("POST", `/devices/${id}/reboot`);
    expect(reboot.status).toBe(200);
    expect(
      router.calls.some((call) => call.url.endsWith("/rest/system/reboot")),
    ).toBe(true);
    expect(
      (await request("POST", `/devices/${id}/ports/x/state`, { up: "no" }))
        .status,
    ).toBe(400);
  });

  it("says plainly when a device type cannot do something", async () => {
    const id = await addDevice({
      name: "fw",
      driver: "opnsense",
      credentials: { apiKey: "k", apiSecret: "s" },
    });
    const result = await request("POST", `/devices/${id}/ports/em0/state`, {
      up: false,
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/cannot do that/);
  });

  it("removes a device", async () => {
    const id = await addDevice();
    expect((await request("DELETE", `/devices/${id}`)).status).toBe(200);
    expect((await request("GET", `/devices/${id}/clients`)).status).toBe(404);
  });
});

describe("alerts", () => {
  it("alerts once when a device goes down and once when it is back", async () => {
    const id = await addDevice();
    await request("POST", `/devices/${id}/poll`);
    refuse = true;
    await request("POST", `/devices/${id}/poll`);
    expect(mock.notifications).toHaveLength(0);
    await request("POST", `/devices/${id}/poll`);
    await request("POST", `/devices/${id}/poll`);
    expect(mock.notifications).toHaveLength(1);
    expect(mock.notifications[0].notification).toMatchObject({
      title: "edge is down",
      audience: { userId: "user-1" },
    });
    refuse = false;
    await request("POST", `/devices/${id}/poll`);
    expect(mock.notifications).toHaveLength(2);
    expect(mock.notifications[1].notification.title).toBe("edge is back");
  });

  it("alerts when a watched port changes link", async () => {
    const id = await addDevice({
      options: { scheme: "https", watchedPorts: ["*1"] },
    });
    await request("POST", `/devices/${id}/poll`);
    up = false;
    await request("POST", `/devices/${id}/poll`);
    expect(mock.notifications.map((n) => n.notification.title)).toEqual([
      "edge: ether1 is down",
    ]);
    up = true;
  });
});

describe("permissions", () => {
  it("lets a viewer read but not change anything", async () => {
    const id = await addDevice();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    await setup(["network-devices.view"]);
    // A fresh database has no devices, so only check the refusals
    expect((await request("GET", "/devices")).status).toBe(200);
    expect((await request("POST", "/devices", input)).status).toBe(403);
    expect((await request("PUT", `/devices/${id}`, input)).status).toBe(403);
    expect((await request("DELETE", `/devices/${id}`)).status).toBe(403);
    expect((await request("POST", `/devices/${id}/reboot`)).status).toBe(403);
    expect((await request("POST", "/discover", {})).status).toBe(403);
  });

  it("refuses everything without view", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    await setup([]);
    expect((await request("GET", "/devices")).status).toBe(403);
    expect((await request("GET", "/drivers")).status).toBe(403);
  });
});
