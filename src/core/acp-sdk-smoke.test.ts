import { expect, test } from "bun:test";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

test("SDK exports resolve", () => {
  expect(typeof ClientSideConnection).toBe("function");
  expect(typeof ndJsonStream).toBe("function");
  expect(PROTOCOL_VERSION).toBe(1);
});
