import { test } from "node:test";
import assert from "node:assert/strict";

const { distTagFor, compareReleases } = await import("./publish-npm.mjs");

test("prerelease goes to next", () => {
  assert.equal(distTagFor("0.701.0-rc.0", "0.700.0"), "next");
});

test("newer release goes to latest", () => {
  assert.equal(distTagFor("0.701.0", "0.700.0"), "latest");
});

test("first publish goes to latest", () => {
  assert.equal(distTagFor("0.1.0", null), "latest");
});

test("older line goes to release-major.minor", () => {
  assert.equal(distTagFor("0.601.5", "0.700.0"), "release-0.601");
});

test("compares numerically, not lexically", () => {
  assert.ok(compareReleases("0.10.0", "0.9.0") > 0);
});

test("rejects non-semver", () => {
  assert.throws(() => distTagFor("latest", null));
});
