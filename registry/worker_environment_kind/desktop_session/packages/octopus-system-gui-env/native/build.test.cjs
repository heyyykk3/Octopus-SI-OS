const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

test("native build fetches a missing pinned revision from a stale cache without advancing the pin", {
  skip: process.platform !== "darwin", timeout: 120_000,
}, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octopus-native-build-test-")));
  const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 90_000, ...options });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${command}: ${result.stdout}\n${result.stderr}`);
    return result.stdout.trim();
  };
  try {
    const dependency = path.join(root, "dependency");
    const client = path.join(root, "client");
    const cache = path.join(root, "cache");
    const commands = path.join(root, "commands");
    for (const directory of [dependency, client, commands]) fs.mkdirSync(directory);
    fs.mkdirSync(path.join(dependency, "Sources", "Dependency"), { recursive: true });
    fs.writeFileSync(path.join(dependency, "Package.swift"), `// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "Dependency", products: [.library(name: "Dependency", targets: ["Dependency"])], targets: [.target(name: "Dependency")])
`);
    run("git", ["init", "--initial-branch=main", dependency]);
    const git = args => run("git", ["-C", dependency, ...args]);
    git(["config", "user.name", "Build fixture"]);
    git(["config", "user.email", "build-fixture@example.invalid"]);
    git(["config", "commit.gpgsign", "false"]);
    git(["config", "core.hooksPath", "/dev/null"]);
    const commit = value => {
      fs.writeFileSync(path.join(dependency, "Sources", "Dependency", "value.swift"), `public let value = "${value}"\n`);
      git(["add", "."]);
      git(["commit", "-m", value]);
      return git(["rev-parse", "HEAD"]);
    };
    const url = pathToFileURL(dependency).href;
    const pin = revision => {
      fs.writeFileSync(path.join(client, "Package.swift"), `// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "Client", products: [.executable(name: "octopus-desktop-native", targets: ["Client"])], dependencies: [.package(url: "${url}", revision: "${revision}")], targets: [.executableTarget(name: "Client", dependencies: [.product(name: "Dependency", package: "dependency")], path: "Sources")])
`);
      fs.writeFileSync(path.join(client, "Package.resolved"), JSON.stringify({ version: 2, pins: [
        { identity: "dependency", kind: "remoteSourceControl", location: url, state: { revision } },
      ] }));
    };
    fs.mkdirSync(path.join(client, "Sources"));
    fs.writeFileSync(path.join(client, "Sources", "main.swift"), "import Dependency\nprint(value)\n");
    pin(commit("cached"));
    run("/usr/bin/xcrun", ["swift", "package", "--package-path", client, "--scratch-path", path.join(root, "seed"),
      "--cache-path", cache, "--force-resolved-versions", "resolve"]);
    pin(commit("pinned"));
    commit("newer-unpinned");
    const recipe = ["Package.swift", "Package.resolved"].map(file => fs.readFileSync(path.join(client, file), "utf8"));
    fs.copyFileSync(path.join(__dirname, "build.cjs"), path.join(client, "build.cjs"));
    fs.writeFileSync(path.join(commands, "xcrun"), '#!/bin/sh\nexec /usr/bin/xcrun "$@" --cache-path "$OCTOPUS_TEST_SWIFT_CACHE"\n', { mode: 0o755 });
    const binary = path.join(root, "bin", "octopus-desktop-native");
    run(process.execPath, [path.join(client, "build.cjs"), binary], {
      env: { ...process.env, TMPDIR: root, PATH: `${commands}${path.delimiter}${process.env.PATH}`, OCTOPUS_TEST_SWIFT_CACHE: cache },
    });
    assert.equal(run(binary, []), "pinned");
    assert.deepEqual(["Package.swift", "Package.resolved"].map(file => fs.readFileSync(path.join(client, file), "utf8")), recipe);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
