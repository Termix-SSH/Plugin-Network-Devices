import { describe, expect, it } from "vitest";
import { unifiDriver } from "../../src/backend/drivers/unifi.js";
import {
  CONFIG_SECTIONS,
  pfsenseDriver,
  parseUptime as pfUptime,
} from "../../src/backend/drivers/pfsense.js";
import {
  ciscoDriver,
  ciscoMac,
  cleanConfig,
  splitTranscript,
} from "../../src/backend/drivers/cisco.js";
import type { Target } from "../../src/backend/drivers/types.js";
import { fakeFetch, json, status, xml } from "./fake-fetch.js";

const target = (
  credentials: Record<string, string>,
  options: Target["options"] = {},
): Target => ({
  address: "10.0.0.1",
  port: 443,
  options,
  credentials,
});

describe("UniFi", () => {
  const device = {
    mac: "AA:BB:CC:00:00:01",
    name: "Core switch",
    type: "usw",
    port_table: [
      {
        port_idx: 1,
        name: "Port 1",
        up: true,
        enable: true,
        speed: 1000,
        rx_bytes: 10,
        tx_bytes: 20,
        port_poe: true,
        poe_enable: true,
        poe_power: "4.5",
        poe_good: true,
      },
      { port_idx: 2, name: "Uplink", up: false, enable: false },
    ],
    lldp_table: [
      {
        local_port_idx: 2,
        local_port_name: "Uplink",
        chassis_id: "AA:BB:CC:00:00:09",
        port_id: "ge-0/0/1",
        system_name: "edge",
      },
    ],
  };

  function controller(os: boolean) {
    return fakeFetch((url, init) => {
      if (url.pathname === "/api/auth/login") {
        if (!os) return status(404);
        return new Response("{}", {
          status: 200,
          headers: {
            "set-cookie": "TOKEN=abc; Path=/; HttpOnly",
            "x-csrf-token": "csrf-1",
          },
        });
      }
      if (url.pathname === "/api/login") {
        return new Response('{"meta":{"rc":"ok"}}', {
          status: 200,
          headers: {
            "set-cookie": "unifises=s1; Path=/, csrf_token=c2; Path=/",
          },
        });
      }
      const prefix = os ? "/proxy/network" : "";
      const cookie = init.headers?.cookie ?? "";
      if (!cookie.includes(os ? "TOKEN=abc" : "unifises=s1"))
        return status(401);
      const path = url.pathname.replace(`${prefix}/api/s/lab`, "");
      if (path === "/stat/sysinfo") {
        return json({
          meta: { rc: "ok" },
          data: [{ name: "HQ", version: "9.0.114" }],
        });
      }
      if (path === "/stat/device")
        return json({ meta: { rc: "ok" }, data: [device] });
      if (path === "/stat/sta") {
        return json({
          meta: { rc: "ok" },
          data: [
            {
              mac: "11:22:33:44:55:66",
              ip: "10.0.0.50",
              hostname: "laptop",
              is_wired: true,
              sw_mac: "aa:bb:cc:00:00:01",
              sw_port: 1,
            },
          ],
        });
      }
      if (path === "/cmd/devmgr") return json({ meta: { rc: "ok" }, data: [] });
      if (path === "/rest/setting") {
        return json({
          meta: { rc: "ok" },
          data: [{ _id: "x1", key: "mgmt", b: 2, a: 1 }],
        });
      }
      if (path.startsWith("/rest/"))
        return json({ meta: { rc: "ok" }, data: [] });
      return undefined;
    });
  }

  it("signs in on UniFi OS and reads every switch's ports", async () => {
    const fetch = controller(true);
    const t = target({ username: "u", password: "p" }, { site: "lab" });
    expect(await unifiDriver.probe(t, { fetch: fetch as never })).toMatchObject(
      {
        name: "HQ",
        version: "9.0.114",
      },
    );
    const ports = await unifiDriver.ports(t, { fetch: fetch as never });
    expect(ports).toEqual([
      expect.objectContaining({
        id: "aa:bb:cc:00:00:01/1",
        name: "Core switch Port 1",
        up: true,
        speedMbps: 1000,
        poe: { enabled: true, watts: 4.5, delivering: true },
      }),
      expect.objectContaining({ id: "aa:bb:cc:00:00:01/2", adminUp: false }),
    ]);
    expect(
      fetch.calls.find((c) => c.url.includes("/stat/device"))?.init.headers[
        "x-csrf-token"
      ],
    ).toBe("csrf-1");
  });

  it("falls back to a classic controller", async () => {
    const fetch = controller(false);
    const t = target({ username: "u", password: "p" }, { site: "lab" });
    const clients = await unifiDriver.clients(t, { fetch: fetch as never });
    expect(clients).toEqual([
      expect.objectContaining({
        mac: "11:22:33:44:55:66",
        name: "laptop",
        port: "Core switch 1",
        kind: "table",
      }),
    ]);
    const neighbors = await unifiDriver.neighbors(t, { fetch: fetch as never });
    expect(neighbors[0]).toMatchObject({
      remoteName: "edge",
      remotePort: "ge-0/0/1",
    });
  });

  it("power cycles a port by switch and index, and saves sorted settings", async () => {
    const fetch = controller(true);
    const t = target({ username: "u", password: "p" }, { site: "lab" });
    await unifiDriver.poeCycle!(
      t,
      { fetch: fetch as never },
      "aa:bb:cc:00:00:01/1",
    );
    const cmd = fetch.calls.find((c) => c.url.endsWith("/cmd/devmgr"));
    expect(JSON.parse(cmd!.init.body)).toEqual({
      cmd: "power-cycle",
      mac: "aa:bb:cc:00:00:01",
      port_idx: 1,
    });
    await expect(
      unifiDriver.poeCycle!(t, { fetch: fetch as never }, "1; rm"),
    ).rejects.toThrow("Unknown port");
    const backup = await unifiDriver.backupConfig!(t, {
      fetch: fetch as never,
    });
    const parsed = JSON.parse(backup.content);
    expect(parsed.setting).toEqual([{ a: 1, b: 2, key: "mgmt" }]);
    expect(backup.format).toBe("json");
  });

  it("needs a login or an API key, and checks the site name", () => {
    expect(unifiDriver.validate!({}, {})).toMatch(/API key/);
    expect(unifiDriver.validate!({ apiKey: "k" }, {})).toBeNull();
    return expect(
      unifiDriver.probe(target({ apiKey: "k" }, { site: "../x" }), {
        fetch: controller(true) as never,
      }),
    ).rejects.toThrow("site name");
  });
});

describe("pfSense", () => {
  const fetch = fakeFetch((url, init) => {
    const auth = init.headers?.["x-api-key"] ?? init.headers?.authorization;
    if (!auth) return status(401);
    switch (url.pathname) {
      case "/api/v2/status/system":
        return json({
          data: {
            platform: "pfSense",
            uptime: "2 Days 03 Hours 04 Minutes 05 Seconds",
            cpu_usage: 7.4,
            mem_usage: 31,
          },
        });
      case "/api/v2/system/hostname":
        return json({ data: { hostname: "fw", domain: "lan" } });
      case "/api/v2/system/version":
        return json({ data: { version: "2.7.2-RELEASE" } });
      case "/api/v2/status/interfaces":
        return json({
          data: [
            {
              name: "wan",
              descr: "WAN",
              hwif: "igb0",
              status: "up",
              macaddr: "00:11:22:33:44:55",
              media: "1000baseT <full-duplex>",
              inbytes: 100,
              outbytes: 200,
              inerrs: 0,
              outerrs: 1,
            },
          ],
        });
      case "/api/v2/diagnostics/arp_table":
        return json({
          data: [
            {
              ip_address: "10.0.0.5",
              mac_address: "AA:00:00:00:00:01",
              interface: "lan",
              hostname: "?",
            },
          ],
        });
      case "/api/v2/status/dhcp_server/leases":
        return json({
          data: [{ ip: "10.0.0.5", mac: "aa:00:00:00:00:01", hostname: "nas" }],
        });
      case "/xmlrpc.php":
        return CONFIG_SECTIONS.every((s) =>
          init.body.includes(`<string>${s}</string>`),
        )
          ? xml(
              '<?xml version="1.0"?><methodResponse><params><param><value><struct></struct></value></param></params></methodResponse>',
            )
          : status(400);
    }
    return undefined;
  });

  it("reads status, ports and clients from the REST API", async () => {
    const t = target({ apiKey: "key" });
    expect(await pfsenseDriver.probe(t, { fetch: fetch as never })).toEqual({
      name: "fw.lan",
      model: "pfSense",
      version: "2.7.2-RELEASE",
      uptimeSec: 2 * 86400 + 3 * 3600 + 4 * 60 + 5,
      cpu: 7,
      memory: 31,
    });
    expect(await pfsenseDriver.ports(t, { fetch: fetch as never })).toEqual([
      expect.objectContaining({
        id: "wan",
        name: "WAN (wan)",
        up: true,
        speedMbps: 1000,
        txErrors: 1,
      }),
    ]);
    expect(await pfsenseDriver.clients(t, { fetch: fetch as never })).toEqual([
      expect.objectContaining({
        mac: "aa:00:00:00:00:01",
        name: "nas",
        kind: "dhcp",
      }),
    ]);
    expect(pfUptime(90)).toBe(90);
  });

  it("saves the config over XML-RPC, which needs a user and password", async () => {
    await expect(
      pfsenseDriver.backupConfig!(target({ apiKey: "key" }), {
        fetch: fetch as never,
      }),
    ).rejects.toThrow("username and password");
    const saved = await pfsenseDriver.backupConfig!(
      target({ username: "admin", password: "pw" }),
      { fetch: fetch as never },
    );
    expect(saved.format).toBe("xml");
  });

  it("explains an XML-RPC fault", async () => {
    const faulty = fakeFetch(() =>
      xml(
        "<methodResponse><fault><value><struct><member><name>faultString</name><value><string>Authentication failed</string></value></member></struct></value></fault></methodResponse>",
      ),
    );
    await expect(
      pfsenseDriver.backupConfig!(target({ username: "a", password: "b" }), {
        fetch: faulty as never,
      }),
    ).rejects.toThrow("Authentication failed");
  });
});

describe("Cisco IOS", () => {
  const outputs: Record<string, string> = {
    "show version":
      "Cisco IOS Software, C2960X Software (C2960X-UNIVERSALK9-M), Version 15.2(7)E8, RELEASE SOFTWARE (fc1)\nsw1 uptime is 1 week, 2 days, 3 hours, 4 minutes\nModel number                    : WS-C2960X-48FPD-L",
    "show interfaces": [
      "GigabitEthernet1/0/1 is up, line protocol is up (connected)",
      "  Hardware is Gigabit Ethernet, address is 0011.2233.4401 (bia 0011.2233.4401)",
      "  Description: server",
      "  MTU 1500 bytes, BW 1000000 Kbit/sec, DLY 10 usec,",
      "     123 packets input, 4567 bytes, 0 no buffer",
      "     2 input errors, 0 CRC, 0 frame, 0 overrun, 0 ignored",
      "     456 packets output, 7890 bytes, 0 underruns",
      "     0 output errors, 0 collisions, 1 interface resets",
      "GigabitEthernet1/0/2 is administratively down, line protocol is down (disabled)",
      "  Hardware is Gigabit Ethernet, address is 0011.2233.4402 (bia 0011.2233.4402)",
    ].join("\n"),
    "show mac address-table": [
      "          Mac Address Table",
      "Vlan    Mac Address       Type        Ports",
      "----    -----------       --------    -----",
      " All    0100.0ccc.cccc    STATIC      CPU",
      "  10    aabb.cc00.0001    DYNAMIC     Gi1/0/1",
    ].join("\n"),
    "show ip arp":
      "Protocol  Address          Age (min)  Hardware Addr   Type   Interface\nInternet  10.0.10.5               3   aabb.cc00.0001  ARPA   Vlan10",
    "show cdp neighbors detail": [
      "-------------------------",
      "Device ID: sw2.lab",
      "Entry address(es):",
      "  IP address: 10.0.0.2",
      "Platform: cisco WS-C2960X-24TS-L,  Capabilities: Switch IGMP",
      "Interface: GigabitEthernet1/0/48,  Port ID (outgoing port): GigabitEthernet1/0/1",
    ].join("\n"),
    "show running-config": [
      "Building configuration...",
      "",
      "Current configuration : 1234 bytes",
      "!",
      "! Last configuration change at 10:00:00 UTC Thu Nov 20 2026",
      "version 15.2",
      "hostname sw1",
      "interface GigabitEthernet1/0/1",
      " description server",
    ].join("\n"),
  };

  const sent: string[][] = [];
  const shell = async (_t: Target, lines: string[]) => {
    sent.push(lines);
    let transcript = "sw1>";
    for (const line of lines) {
      const prompt = lines.includes("enable") ? "sw1#" : "sw1>";
      transcript += `${line}\r\n${outputs[line] ?? ""}\r\n${prompt}`;
    }
    return transcript;
  };
  const io = { fetch: (() => {}) as never, shell };
  const t: Target = {
    address: "10.0.0.9",
    port: 22,
    options: {},
    credentials: { username: "admin", password: "pw", enablePassword: "en" },
  };

  it("reads the version, ports, clients and neighbors", async () => {
    expect(await ciscoDriver.probe(t, io)).toEqual({
      name: "sw1",
      model: "WS-C2960X-48FPD-L",
      version: "15.2(7)E8",
      uptimeSec: 604800 + 2 * 86400 + 3 * 3600 + 4 * 60,
    });
    expect(sent.at(-1)!.slice(0, 2)).toEqual(["enable", "en"]);
    expect(await ciscoDriver.ports(t, io)).toEqual([
      {
        id: "GigabitEthernet1/0/1",
        name: "GigabitEthernet1/0/1",
        up: true,
        adminUp: true,
        mac: "00:11:22:33:44:01",
        description: "server",
        speedMbps: 1000,
        rxBytes: 4567,
        txBytes: 7890,
        rxErrors: 2,
        txErrors: 0,
      },
      expect.objectContaining({
        id: "GigabitEthernet1/0/2",
        up: false,
        adminUp: false,
      }),
    ]);
    expect(await ciscoDriver.clients(t, io)).toEqual([
      {
        mac: "aa:bb:cc:00:00:01",
        ip: "10.0.10.5",
        port: "Gi1/0/1",
        vlan: 10,
        kind: "table",
      },
    ]);
    expect(await ciscoDriver.neighbors(t, io)).toEqual([
      {
        localPort: "GigabitEthernet1/0/48",
        remoteName: "sw2.lab",
        remotePort: "GigabitEthernet1/0/1",
        remoteAddress: "10.0.0.2",
      },
    ]);
  });

  it("shuts a port in config mode and refuses odd names", async () => {
    await ciscoDriver.setPort!(t, io, "GigabitEthernet1/0/2", false);
    expect(sent.at(-1)).toEqual([
      "enable",
      "en",
      "configure terminal",
      "interface GigabitEthernet1/0/2",
      "shutdown",
      "end",
      "exit",
    ]);
    await expect(
      ciscoDriver.setPort!(t, io, "Gi1/0/1\nreload", true),
    ).rejects.toThrow("Unknown port");
  });

  it("saves the running config without the lines that change by themselves", async () => {
    const saved = await ciscoDriver.backupConfig!(t, io);
    expect(saved.content).toBe(
      "!\nversion 15.2\nhostname sw1\ninterface GigabitEthernet1/0/1\n description server",
    );
    expect(cleanConfig("Building configuration...\nversion 1")).toBe(
      "version 1",
    );
  });

  it("cuts command output out of a transcript", () => {
    expect(
      splitTranscript("sw1#show a\r\nA1\r\nA2\r\nsw1#show b\r\nB\r\nsw1#", [
        "show a",
        "show b",
      ]),
    ).toEqual(["A1\nA2", "B"]);
    expect(ciscoMac("aabb.cc00.0001")).toBe("aa:bb:cc:00:00:01");
    expect(ciscoMac("nope")).toBe("");
  });
});
