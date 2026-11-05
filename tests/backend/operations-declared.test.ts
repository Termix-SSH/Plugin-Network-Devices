import { describe, expect, it } from "vitest";
import { parseManifest } from "@termix-ssh/plugin-sdk/manifest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import manifest from "../../manifest.json";
import { registerOperations } from "../../src/backend/operations.js";
import type { Service } from "../../src/backend/service.js";

type Declared = {
  id: string;
  risk: string;
  permission: string;
  dryRun?: string;
};

const actions = (
  manifest.contributes as { operations: { actions: Declared[] } }
).operations.actions;

describe("declared actions", () => {
  it("is a valid manifest", () => {
    expect(parseManifest(manifest).errors ?? []).toEqual([]);
  });

  it("has a handler for every declared action and nothing else", () => {
    const registered: string[] = [];
    const ctx = {
      operations: {
        register: (id: string) => {
          registered.push(id);
        },
      },
    } as unknown as PluginContext;
    registerOperations(ctx, {} as Service);
    expect([...registered].sort()).toEqual(actions.map((a) => a.id).sort());
  });

  it("needs manage for anything that changes a device", () => {
    for (const action of actions) {
      if (action.risk !== "read") {
        expect(action.permission).toBe("manage");
        expect(action.dryRun).toBeTruthy();
      }
    }
  });
});

describe("handlers", () => {
  const device = {
    id: 4,
    name: "sw1",
    status: "up",
    snapshot: { ports: [{ id: "7", name: "Gi7", up: true }] },
  };
  const calls: string[] = [];
  const service = {
    list: async () => [device],
    get: async () => device,
    poll: async () => device,
    setPort: async (...args: unknown[]) => {
      calls.push(`setPort ${args.join(",")}`);
    },
    poeCycle: async (...args: unknown[]) => {
      calls.push(`poe ${args.join(",")}`);
    },
    reboot: async (...args: unknown[]) => {
      calls.push(`reboot ${args.join(",")}`);
    },
  } as unknown as Service;

  const handlers = new Map<
    string,
    {
      run: (input: Record<string, unknown>) => Promise<any>;
      describe?: (input: Record<string, unknown>) => Promise<string>;
    }
  >();
  registerOperations(
    {
      operations: {
        register: (id: string, handler: never) => handlers.set(id, handler),
      },
    } as unknown as PluginContext,
    service,
  );

  it("describes a port change without making it", async () => {
    const text = await handlers.get("network-devices.set-port")!.describe!({
      device: "4",
      port: "7",
      state: "down",
    });
    expect(text).toBe("Would turn sw1 port Gi7 off");
    expect(calls).toEqual([]);
  });

  it("runs the change and the restart", async () => {
    const set = await handlers
      .get("network-devices.set-port")!
      .run({ device: "4", port: "7", state: "up" });
    expect(set.summary).toBe("sw1 port Gi7 turned on");
    await handlers
      .get("network-devices.poe-cycle")!
      .run({ device: "4", port: "7" });
    await handlers.get("network-devices.reboot")!.run({ device: "4" });
    expect(calls).toEqual(["setPort 4,7,true", "poe 4,7", "reboot 4"]);
  });

  it("reports down devices as a failing signal", async () => {
    const result = await handlers.get("network-devices.list-devices")!.run({});
    expect(result.data.status).toBe("ok");
    device.status = "down";
    const down = await handlers.get("network-devices.list-devices")!.run({});
    expect(down.data).toMatchObject({ status: "fail", value: 1 });
    expect(down.summary).toBe("1 down");
  });
});
