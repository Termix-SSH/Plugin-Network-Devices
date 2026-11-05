import { describe, expect, it, vi } from "vitest";
import { snmpDriver } from "../../src/backend/drivers/snmp.js";
import {
  routerosDriver,
  parseUptime,
} from "../../src/backend/drivers/routeros.js";
import { opnsenseDriver } from "../../src/backend/drivers/opnsense.js";
import { openwrtDriver } from "../../src/backend/drivers/openwrt.js";
import type {
  SnmpClient,
  SnmpValue,
  Target,
} from "../../src/backend/drivers/types.js";
import { expandCidr } from "../../src/backend/service.js";
import { fakeFetch, json, status } from "./fake-fetch.js";

type Table = Record<string, string | number | Buffer>;

/** A fake SNMP agent over a flat oid table. */
function agent(table: Table) {
  const sets: Array<[string, number]> = [];
  const client: SnmpClient = {
    get: async (oids) =>
      oids.map((oid) => (oid in table ? { oid, value: table[oid] } : null)),
    walk: async (oid) =>
      Object.keys(table)
        .filter((key) => key.startsWith(`${oid}.`))
        .map((key): SnmpValue => ({ oid: key, value: table[key] })),
    set: async (oid, _type, value) => {
      sets.push([oid, value]);
    },
    close: () => {},
  };
  return { factory: () => client, sets };
}

const mac = (...bytes: number[]) => Buffer.from(bytes);

const target = (extra: Partial<Target> = {}): Target => ({
  address: "10.0.0.2",
  port: 161,
  options: { snmpVersion: "2c" },
  credentials: { community: "public", writeCommunity: "private" },
  ...extra,
});

const switchTable: Table = {
  "1.3.6.1.2.1.1.5.0": "sw1",
  "1.3.6.1.2.1.1.1.0": "Test switch",
  "1.3.6.1.2.1.1.3.0": 8640000,
  "1.3.6.1.2.1.25.3.3.1.2.1": 10,
  "1.3.6.1.2.1.25.3.3.1.2.2": 30,
  // Two ethernet ports and a loopback
  "1.3.6.1.2.1.2.2.1.2.1": "GigabitEthernet1",
  "1.3.6.1.2.1.2.2.1.2.2": "GigabitEthernet2",
  "1.3.6.1.2.1.2.2.1.2.9": "lo",
  "1.3.6.1.2.1.2.2.1.3.1": 6,
  "1.3.6.1.2.1.2.2.1.3.2": 6,
  "1.3.6.1.2.1.2.2.1.3.9": 24,
  "1.3.6.1.2.1.2.2.1.7.1": 1,
  "1.3.6.1.2.1.2.2.1.7.2": 2,
  "1.3.6.1.2.1.2.2.1.8.1": 1,
  "1.3.6.1.2.1.2.2.1.8.2": 2,
  "1.3.6.1.2.1.2.2.1.10.1": 1000,
  "1.3.6.1.2.1.2.2.1.16.1": 2000,
  "1.3.6.1.2.1.31.1.1.1.1.1": "Gi1",
  "1.3.6.1.2.1.31.1.1.1.6.1": Buffer.from([0, 0, 0, 0, 0, 0, 0x10, 0x00]),
  "1.3.6.1.2.1.31.1.1.1.15.1": 1000,
  "1.3.6.1.2.1.31.1.1.1.18.1": "uplink",
  "1.3.6.1.2.1.17.1.4.1.2.5": 1,
  "1.3.6.1.2.1.17.7.1.4.5.1.1.5": 20,
  "1.3.6.1.2.1.105.1.1.1.3.1.1": 1,
  "1.3.6.1.2.1.105.1.1.1.6.1.1": 3,
  // MAC table: vlan 20, mac aa:bb:cc:00:00:01 on bridge port 5
  "1.3.6.1.2.1.17.7.1.2.2.1.2.20.170.187.204.0.0.1": 5,
  // ARP: ifIndex 1, ip 10.0.0.50
  "1.3.6.1.2.1.4.22.1.2.1.10.0.0.50": mac(0xaa, 0xbb, 0xcc, 0, 0, 1),
  // LLDP: timeMark 0, local port 1, index 1
  "1.0.8802.1.1.2.1.4.1.1.9.0.1.1": "core-switch",
  "1.0.8802.1.1.2.1.4.1.1.7.0.1.1": "Gi24",
  "1.0.8802.1.1.2.1.4.1.1.5.0.1.1": mac(1, 2, 3, 4, 5, 6),
};

describe("snmp driver", () => {
  it("reads the basics and averages the CPU", async () => {
    const { factory } = agent(switchTable);
    const info = await snmpDriver.probe(target(), {
      fetch: vi.fn() as never,
      snmp: factory,
    });
    expect(info).toMatchObject({
      name: "sw1",
      description: "Test switch",
      uptimeSec: 86400,
      cpu: 20,
    });
  });

  it("fails when the device is silent", async () => {
    const { factory } = agent({});
    await expect(
      snmpDriver.probe(target(), { fetch: vi.fn() as never, snmp: factory }),
    ).rejects.toThrow(/did not answer/);
  });

  it("lists ethernet ports with counters, vlan and poe", async () => {
    const { factory } = agent(switchTable);
    const ports = await snmpDriver.ports(target(), {
      fetch: vi.fn() as never,
      snmp: factory,
    });
    expect(ports.map((port) => port.id)).toEqual(["1", "2"]);
    expect(ports[0]).toMatchObject({
      name: "Gi1",
      description: "uplink",
      up: true,
      adminUp: true,
      speedMbps: 1000,
      vlan: 20,
      rxBytes: 4096,
      txBytes: 2000,
      poe: { enabled: true, delivering: true },
    });
    expect(ports[1]).toMatchObject({ up: false, adminUp: false });
    expect(ports[1].speedMbps).toBeUndefined();
  });

  it("joins the MAC table with ARP", async () => {
    const { factory } = agent(switchTable);
    const clients = await snmpDriver.clients(target(), {
      fetch: vi.fn() as never,
      snmp: factory,
    });
    expect(clients).toEqual([
      {
        mac: "aa:bb:cc:00:00:01",
        ip: "10.0.0.50",
        port: "Gi1",
        vlan: 20,
        kind: "table",
      },
    ]);
  });

  it("reads LLDP neighbors", async () => {
    const { factory } = agent(switchTable);
    const neighbors = await snmpDriver.neighbors(target(), {
      fetch: vi.fn() as never,
      snmp: factory,
    });
    expect(neighbors).toEqual([
      {
        localPort: "Gi1",
        remoteName: "core-switch",
        remotePort: "Gi24",
        remoteMac: "01:02:03:04:05:06",
      },
    ]);
  });

  it("sets a port with the write community and power cycles PoE", async () => {
    const seen: string[] = [];
    const sets: Array<[string, number]> = [];
    const factory = (t: Target): SnmpClient => {
      seen.push(t.credentials.community ?? "");
      return {
        ...agent({}).factory(),
        set: async (oid, _type, value) => {
          sets.push([oid, value]);
        },
      };
    };
    const io = {
      fetch: vi.fn() as never,
      snmp: factory,
      sleep: async () => {},
    };
    await snmpDriver.setPort!(target(), io, "3", false);
    await snmpDriver.poeCycle!(target(), io, "3");
    expect(seen).toEqual(["private", "private"]);
    expect(sets).toEqual([
      ["1.3.6.1.2.1.2.2.1.7.3", 2],
      ["1.3.6.1.2.1.105.1.1.1.3.1.3", 2],
      ["1.3.6.1.2.1.105.1.1.1.3.1.3", 1],
    ]);
  });

  it("refuses a port id that is not a number", async () => {
    const { factory } = agent({});
    await expect(
      snmpDriver.setPort!(
        target(),
        { fetch: vi.fn() as never, snmp: factory },
        "1.3.6",
        false,
      ),
    ).rejects.toThrow(/Unknown port/);
  });

  it("checks keys against the version", () => {
    expect(snmpDriver.validate!({}, { snmpVersion: "2c" })).toMatch(
      /community/,
    );
    expect(
      snmpDriver.validate!({ community: "x" }, { snmpVersion: "2c" }),
    ).toBeNull();
    expect(snmpDriver.validate!({}, { snmpVersion: "3" })).toMatch(/user name/);
  });
});

const rosTarget = (): Target => ({
  address: "10.0.0.1",
  port: 443,
  options: { scheme: "https" },
  credentials: { username: "api", password: "pw" },
});

describe("routeros driver", () => {
  const device = fakeFetch((url, init) => {
    if (url.hostname !== "10.0.0.1") return undefined;
    const path = url.pathname;
    if (path === "/rest/system/resource") {
      return json({
        "board-name": "RB5009",
        version: "7.16",
        uptime: "1d2h3m4s",
        "cpu-load": "5",
        "total-memory": "1000",
        "free-memory": "250",
      });
    }
    if (path === "/rest/system/identity") return json({ name: "edge" });
    if (path === "/rest/interface") {
      return json([
        {
          ".id": "*1",
          name: "ether1",
          type: "ether",
          running: "true",
          disabled: "false",
          "rx-byte": "100",
          "tx-byte": "200",
        },
        { ".id": "*2", name: "vlan10", type: "vlan", running: "true" },
      ]);
    }
    if (path === "/rest/interface/ethernet/poe") {
      return json([{ ".id": "*A", name: "ether1", "poe-out": "auto-on" }]);
    }
    if (path === "/rest/ip/dhcp-server/lease") {
      return json([
        {
          address: "10.0.0.9",
          "mac-address": "AA:AA:AA:AA:AA:01",
          "host-name": "laptop",
        },
      ]);
    }
    if (path === "/rest/interface/wifi/registration-table") {
      return json([
        {
          "mac-address": "AA:AA:AA:AA:AA:01",
          interface: "wifi1",
          signal: "-55@5GHz",
        },
      ]);
    }
    if (init.method === "PATCH" || init.method === "POST") return json({});
    return status(404);
  });

  it("reads info with memory and uptime", async () => {
    const info = await routerosDriver.probe(rosTarget(), {
      fetch: device as never,
    });
    expect(info).toMatchObject({
      name: "edge",
      model: "RB5009",
      version: "7.16",
      uptimeSec: 93784,
      cpu: 5,
      memory: 75,
    });
  });

  it("sends basic auth and allows only this device", async () => {
    device.calls.length = 0;
    await routerosDriver.probe(rosTarget(), { fetch: device as never });
    const first = device.calls[0].init;
    expect(first.headers.authorization).toBe(
      `Basic ${Buffer.from("api:pw").toString("base64")}`,
    );
    expect(first.allowPrivateHosts).toEqual(["10.0.0.1"]);
  });

  it("lists physical ports with poe", async () => {
    const ports = await routerosDriver.ports(rosTarget(), {
      fetch: device as never,
    });
    expect(ports).toHaveLength(1);
    expect(ports[0]).toMatchObject({
      id: "*1",
      name: "ether1",
      up: true,
      rxBytes: 100,
      poe: { enabled: true },
    });
  });

  it("merges DHCP leases with Wi-Fi signal", async () => {
    const clients = await routerosDriver.clients(rosTarget(), {
      fetch: device as never,
    });
    expect(clients).toEqual([
      expect.objectContaining({
        mac: "aa:aa:aa:aa:aa:01",
        ip: "10.0.0.9",
        name: "laptop",
        port: "wifi1",
        signal: -55,
        kind: "wifi",
      }),
    ]);
  });

  it("turns a port off and refuses a bad id", async () => {
    device.calls.length = 0;
    await routerosDriver.setPort!(
      rosTarget(),
      { fetch: device as never },
      "*1",
      false,
    );
    expect(device.calls[0].init.method).toBe("PATCH");
    expect(device.calls[0].url).toContain("/rest/interface/*1");
    expect(JSON.parse(device.calls[0].init.body)).toEqual({ disabled: "true" });
    await expect(
      routerosDriver.setPort!(
        rosTarget(),
        { fetch: device as never },
        "../x",
        false,
      ),
    ).rejects.toThrow(/Unknown port/);
  });

  it("maps a refused login to a plain message", async () => {
    const refused = fakeFetch(() => status(401));
    await expect(
      routerosDriver.probe(rosTarget(), { fetch: refused as never }),
    ).rejects.toThrow(/refused the login/);
  });

  it("parses uptimes", () => {
    expect(parseUptime("1w2d3h4m5s")).toBe(604800 + 172800 + 10800 + 240 + 5);
    expect(parseUptime("")).toBeUndefined();
    expect(parseUptime("soon")).toBeUndefined();
  });
});

describe("opnsense driver", () => {
  const firewall = fakeFetch((url) => {
    if (url.pathname.endsWith("/systemInformation")) {
      return json({ name: "fw", versions: ["OPNsense 24.7", "amd64"] });
    }
    if (url.pathname.endsWith("/systemTime")) {
      return json({ uptime: "1 day, 02:03:04" });
    }
    if (url.pathname.endsWith("/getInterfaceConfig")) {
      return json({
        em0: { status: "active", macaddr: "00:11:22:33:44:55" },
        lo0: { status: "active" },
      });
    }
    if (url.pathname.endsWith("/getInterfaceStatistics")) {
      return json({
        statistics: {
          "[em0] / 00:11:22:33:44:55": {
            "received-bytes": "500",
            "sent-bytes": "700",
          },
        },
      });
    }
    if (url.pathname.endsWith("/getArp")) {
      return json([{ mac: "AA:BB:CC:DD:EE:FF", ip: "10.0.0.7", intf: "em0" }]);
    }
    if (url.pathname.endsWith("/searchLease")) {
      return json({
        rows: [
          { hwaddr: "aa:bb:cc:dd:ee:ff", address: "10.0.0.7", hostname: "nas" },
        ],
      });
    }
    return undefined;
  });
  const t: Target = {
    address: "10.0.0.1",
    port: 443,
    options: { scheme: "https" },
    credentials: { apiKey: "k", apiSecret: "s" },
  };

  it("reads info, ports and clients", async () => {
    const io = { fetch: firewall as never };
    expect(await opnsenseDriver.probe(t, io)).toMatchObject({
      name: "fw",
      version: "OPNsense 24.7",
      uptimeSec: 93784,
    });
    const ports = await opnsenseDriver.ports(t, io);
    expect(ports).toEqual([
      expect.objectContaining({
        id: "em0",
        up: true,
        rxBytes: 500,
        txBytes: 700,
      }),
    ]);
    expect(await opnsenseDriver.clients(t, io)).toEqual([
      expect.objectContaining({ ip: "10.0.0.7", name: "nas", kind: "dhcp" }),
    ]);
  });
});

describe("openwrt driver", () => {
  const calls: string[] = [];
  const router = fakeFetch((_url, init) => {
    const [session, object, method] = JSON.parse(init.body).params;
    calls.push(`${object}.${method}`);
    if (method === "login") {
      return json({ result: [0, { ubus_rpc_session: "abc" }] });
    }
    if (session !== "abc") return json({ result: [6] });
    if (object === "system" && method === "board") {
      return json({
        result: [
          0,
          {
            hostname: "ap",
            model: "AP1",
            release: { description: "OpenWrt 23.05" },
          },
        ],
      });
    }
    if (object === "system" && method === "info") {
      return json({
        result: [
          0,
          { uptime: 100, memory: { total: 100, free: 40 }, load: [32768] },
        ],
      });
    }
    if (object === "network.device") {
      return json({
        result: [
          0,
          {
            lo: { up: true },
            eth0: {
              up: true,
              carrier: true,
              speed: "1000F",
              statistics: { rx_bytes: 9, tx_bytes: 8 },
            },
          },
        ],
      });
    }
    return json({ result: [4] });
  });
  const t: Target = {
    address: "10.0.0.3",
    port: 80,
    options: { scheme: "http" },
    credentials: { username: "root", password: "pw" },
  };

  it("logs in and reads info and ports", async () => {
    const io = { fetch: router as never };
    expect(await openwrtDriver.probe(t, io)).toMatchObject({
      name: "ap",
      model: "AP1",
      version: "OpenWrt 23.05",
      uptimeSec: 100,
      memory: 60,
      cpu: 50,
    });
    expect(await openwrtDriver.ports(t, io)).toEqual([
      expect.objectContaining({
        id: "eth0",
        up: true,
        speedMbps: 1000,
        rxBytes: 9,
      }),
    ]);
  });

  it("returns no clients when the optional modules are missing", async () => {
    expect(await openwrtDriver.clients(t, { fetch: router as never })).toEqual(
      [],
    );
  });
});

describe("expandCidr", () => {
  it("skips the network and broadcast addresses", () => {
    const list = expandCidr("192.168.1.0/30");
    expect(list).toEqual(["192.168.1.1", "192.168.1.2"]);
  });

  it("handles a /32 and a /24", () => {
    expect(expandCidr("10.0.0.5/32")).toEqual(["10.0.0.5"]);
    expect(expandCidr("10.0.0.0/24")).toHaveLength(254);
  });

  it("refuses big or malformed ranges", () => {
    expect(() => expandCidr("10.0.0.0/16")).toThrow(/at most/);
    expect(() => expandCidr("nope")).toThrow(/range/);
    expect(() => expandCidr("300.0.0.0/24")).toThrow(/range/);
  });
});
