import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Server, utils } from "ssh2";
import { fingerprint, sshShell } from "../../src/backend/drivers/ssh-shell.js";
import { ciscoDriver } from "../../src/backend/drivers/cisco.js";
import type { Target } from "../../src/backend/drivers/types.js";

const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();

let server: Server;
let port = 0;

/** A tiny IOS: a prompt, enable, and two show commands. */
beforeAll(async () => {
  server = new Server({ hostKeys: [hostKey] }, (client) => {
    // A client that drops after a host key mismatch is expected here.
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      if (
        ctx.method === "password" &&
        ctx.username === "admin" &&
        ctx.password === "pw"
      ) {
        ctx.accept();
      } else {
        ctx.reject(["password"]);
      }
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (ok) => ok?.());
        session.on("shell", (ok) => {
          const stream = ok();
          let prompt = "sw1>";
          let buffer = "";
          let waitingForEnable = false;
          stream.write(prompt);
          stream.on("data", (chunk: Buffer) => {
            buffer += chunk.toString();
            let nl: number;
            while ((nl = buffer.indexOf("\n")) !== -1) {
              const line = buffer.slice(0, nl).trim();
              buffer = buffer.slice(nl + 1);
              if (waitingForEnable) {
                waitingForEnable = false;
                if (line === "en") prompt = "sw1#";
                stream.write(`\r\n${prompt}`);
                continue;
              }
              stream.write(`${line}\r\n`);
              if (line === "enable") {
                waitingForEnable = true;
                stream.write("Password: ");
                continue;
              }
              if (line === "exit") {
                stream.exit(0);
                stream.end();
                return;
              }
              if (line === "show version") {
                stream.write(
                  "Cisco IOS Software, Version 15.2(7)E8\r\nsw1 uptime is 3 days, 1 hour, 2 minutes\r\n",
                );
              }
              if (line === "show running-config") {
                stream.write(
                  prompt === "sw1#"
                    ? "Building configuration...\r\nversion 15.2\r\nhostname sw1\r\n"
                    : "% Invalid input detected at '^' marker.\r\n",
                );
              }
              stream.write(prompt);
            }
          });
        });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => server.close());

const target = (credentials: Record<string, string>): Target => ({
  address: "127.0.0.1",
  port,
  options: {},
  credentials: { username: "admin", password: "pw", ...credentials },
});

const io = { fetch: (() => {}) as never };

describe("the SSH shell", () => {
  it("logs in, sends enable and reads show output", async () => {
    expect(await ciscoDriver.probe(target({}), io)).toMatchObject({
      name: "sw1",
      version: "15.2(7)E8",
      uptimeSec: 3 * 86400 + 3600 + 120,
    });
    const saved = await ciscoDriver.backupConfig!(
      target({ enablePassword: "en" }),
      io,
    );
    expect(saved.content).toBe("version 15.2\nhostname sw1");
  });

  it("says when a login without enable can't see the config", async () => {
    await expect(ciscoDriver.backupConfig!(target({}), io)).rejects.toThrow(
      "may need enable",
    );
  });

  it("refuses a wrong password", async () => {
    await expect(
      sshShell(target({ password: "nope" }), ["exit"]),
    ).rejects.toThrow("refused the login");
  });

  it("checks a pinned host key", async () => {
    const key = utils.parseKey(hostKey);
    const good = fingerprint(
      (Array.isArray(key) ? key[0] : key).getPublicSSH() as Buffer,
    );
    await expect(
      sshShell(target({ hostKey: good }), ["exit"]),
    ).resolves.toBeTypeOf("string");
    await expect(
      sshShell(
        target({
          hostKey: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        }),
        ["exit"],
      ),
    ).rejects.toThrow();
  });
});
