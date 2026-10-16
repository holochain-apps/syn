#!/usr/bin/env node
// Publish each given package directory whose version is not yet on npm.
//
// Usage: node scripts/publish-npm.mjs [--dry-run] <package-dir>...
//
// When RELEASE_TAG is set (the pushed git tag, e.g. v0.701.0), every package
// must have that version, so a tag can never publish something else.
//
// Dist-tag: a prerelease goes to `next`, a version below the current `latest`
// goes to `release-<major>.<minor>` so a fix on an older line does not move
// `latest`, and anything else goes to `latest`.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(version);
  if (!match) throw new Error(`Not a semver version: ${version}`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? null,
  };
}

// Compares release versions only; prereleases never reach this comparison.
export function compareReleases(a, b) {
  const pa = parseVersion(a).core;
  const pb = parseVersion(b).core;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

export function distTagFor(version, currentLatest) {
  const parsed = parseVersion(version);
  if (parsed.prerelease) return "next";
  if (currentLatest && compareReleases(version, currentLatest) < 0) {
    return `release-${parsed.core[0]}.${parsed.core[1]}`;
  }
  return "latest";
}

function npmView(spec, field) {
  try {
    const out = execFileSync("npm", ["view", spec, field, "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out ? JSON.parse(out) : null;
  } catch (e) {
    if (/E404|is not in this registry/.test(String(e.stderr))) return null;
    throw e;
  }
}

function main(argv) {
  const dryRun = argv.includes("--dry-run");
  const dirs = argv.filter((a) => a !== "--dry-run");
  if (dirs.length === 0) {
    throw new Error("Usage: publish-npm.mjs [--dry-run] <package-dir>...");
  }
  const releaseTag = process.env.RELEASE_TAG || "";

  const packages = dirs.map((dir) => {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return { dir, name: pkg.name, version: pkg.version };
  });

  if (releaseTag) {
    const mismatched = packages.filter((p) => `v${p.version}` !== releaseTag);
    if (mismatched.length > 0) {
      const list = mismatched.map((p) => `${p.name}@${p.version}`).join(", ");
      throw new Error(`Tag ${releaseTag} does not match: ${list}`);
    }
  }

  for (const { dir, name, version } of packages) {
    if (npmView(`${name}@${version}`, "version")) {
      console.log(`skip ${name}@${version}: already published`);
      continue;
    }
    const tag = distTagFor(version, npmView(name, "dist-tags.latest"));
    console.log(`publish ${name}@${version} --tag ${tag}`);
    const args = ["publish", "--access", "public", "--tag", tag];
    if (dryRun) args.push("--dry-run");
    execFileSync("npm", args, { cwd: dir, stdio: "inherit" });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
