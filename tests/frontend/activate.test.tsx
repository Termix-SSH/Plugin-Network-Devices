import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";
import {
  formatRate,
  formatSpeed,
  formatUptime,
} from "../../src/frontend/format";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

const device = {
  id: 1,
  name: "core-switch",
  driver: "snmp",
  address: "10.0.0.2",
  port: null,
  options: {},
  hasCa: false,
  pollSeconds: 60,
  status: "up",
  lastError: null,
  lastSeenAt: null,
  snapshot: {
    at: "",
    info: { name: "core-switch", uptimeSec: 7200 },
    ports: [
      { id: "1", name: "Gi1", up: true, adminUp: true },
      { id: "2", name: "Gi2", up: false, adminUp: true },
    ],
  },
  traffic: [],
};

describe(`${manifest.id} activate`, () => {
  it("registers the rail item, tab and dashboard card", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.tabs()).toEqual(["network-devices"]);
    expect(rendered.registered.railItems()).toEqual([
      expect.objectContaining({
        id: "network-devices",
        permission: "network-devices.view",
      }),
    ]);
  });

  it("lists devices with port counts", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: {
        get: vi.fn(async (path: string) => ({
          data: path === "/drivers" ? { drivers: [] } : { devices: [device] },
        })),
      } as never,
    });
    rendered.renderTab("network-devices", { isVisible: true });
    expect(await screen.findByText("core-switch")).toBeTruthy();
    expect(screen.getByText(/1 of 2 ports up/)).toBeTruthy();
  });

  it("shows the empty state", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: {
        get: vi.fn(async (path: string) => ({
          data: path === "/drivers" ? { drivers: [] } : { devices: [] },
        })),
      } as never,
    });
    rendered.renderTab("network-devices", { isVisible: true });
    expect(await screen.findByText(locales.empty)).toBeTruthy();
  });
});

describe("format", () => {
  it("shortens rates, speeds and uptimes", () => {
    expect(formatRate(undefined)).toBe("-");
    expect(formatRate(2_500_000)).toBe("2.5 Mb/s");
    expect(formatRate(900)).toBe("900 b/s");
    expect(formatSpeed(1000)).toBe("1 Gb");
    expect(formatSpeed(100)).toBe("100 Mb");
    expect(formatUptime(90000)).toBe("1d 1h");
    expect(formatUptime(300)).toBe("5m");
  });
});

describe("homepage widget", () => {
  it("is offered to the homepage", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.extensions("homepage.widgets")).toHaveLength(1);
  });
});
