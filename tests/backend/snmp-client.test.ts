import dgram from "node:dgram";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as snmp from "net-snmp";
import { createSnmpClient } from "../../src/backend/drivers/snmp-client.js";
import { snmpDriver } from "../../src/backend/drivers/snmp.js";
import type { Target } from "../../src/backend/drivers/types.js";

// A real SNMP agent on loopback, so the client wrapper talks real packets.
let agent: any;
let port = 0;

async function freeUdpPort(): Promise<number> {
  const socket = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const { port: found } = socket.address() as AddressInfo;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return found;
}

beforeAll(async () => {
  port = await freeUdpPort();
  {
    // The callback is for requests, not for being ready
    const created = snmp.createAgent(
      {
        port,
        address: "127.0.0.1",
        disableAuthorization: false,
        accessControlModelType: snmp.AccessControlModelType.Simple,
      },
      () => {},
    );
    agent = created;
    created.getAuthorizer().addCommunity("public");
    created
      .getAuthorizer()
      .getAccessControlModel()
      .setCommunityAccess("public", snmp.AccessLevel.ReadOnly);
    const mib = created.getMib();
    mib.registerProvider({
      name: "sysDescr",
      type: snmp.MibProviderType.Scalar,
      oid: "1.3.6.1.2.1.1.1",
      maxAccess: snmp.MaxAccess["read-only"],
      scalarType: snmp.ObjectType.OctetString,
    });
    mib.setScalarValue("sysDescr", "Loopback test agent");
    mib.registerProvider({
      name: "sysName",
      type: snmp.MibProviderType.Scalar,
      oid: "1.3.6.1.2.1.1.5",
      maxAccess: snmp.MaxAccess["read-only"],
      scalarType: snmp.ObjectType.OctetString,
    });
    mib.setScalarValue("sysName", "agent1");
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
});

afterAll(() => {
  agent?.close();
});

const target = (): Target => ({
  address: "127.0.0.1",
  port,
  options: { snmpVersion: "2c" },
  credentials: { community: "public" },
  timeoutMs: 1000,
});

describe("snmp client", () => {
  it("gets scalars and walks a subtree", async () => {
    const client = createSnmpClient(target());
    try {
      const [name, missing] = await client.get([
        "1.3.6.1.2.1.1.5.0",
        "1.3.6.1.2.1.1.99.0",
      ]);
      expect(Buffer.from(name!.value as Buffer).toString()).toBe("agent1");
      expect(missing).toBeNull();
      const rows = await client.walk("1.3.6.1.2.1.1");
      expect(rows.map((row) => row.oid)).toContain("1.3.6.1.2.1.1.1.0");
    } finally {
      client.close();
    }
  });

  it("reports a silent device in plain words", async () => {
    const dead = await freeUdpPort();
    await expect(
      snmpDriver.probe(
        { ...target(), port: dead },
        { fetch: (() => {}) as never },
      ),
    ).rejects.toThrow(/did not answer SNMP/);
  });

  it("fails on a wrong community", async () => {
    await expect(
      snmpDriver.probe(
        { ...target(), credentials: { community: "wrong" } },
        { fetch: (() => {}) as never },
      ),
    ).rejects.toThrow(/SNMP/);
  });
});
