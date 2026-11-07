import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as SubmoduleRepositories from "./SubmoduleRepositories.ts";

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const result = yield* processRunner.run({
      command: "git",
      args: [
        "-c",
        "user.name=t3",
        "-c",
        "user.email=t3@example.test",
        "-c",
        "protocol.file.allow=always",
        "-C",
        cwd,
        ...args,
      ],
    });
    if (result.code !== 0) return yield* Effect.die(new Error(result.stderr));
  }).pipe(Effect.provide(ProcessRunner.layer));

describe("resolveSubmoduleUrl", () => {
  it.each([
    ["../lib.git", "https://github.com/acme/app.git", "https://github.com/acme/lib.git"],
    ["../lib.git", "https://github.com/acme/app/", "https://github.com/acme/lib.git"],
    ["./lib", "https://github.com/acme/app", "https://github.com/acme/app/lib"],
    ["../lib.git", "git@github.com:acme/app.git", "git@github.com:acme/lib.git"],
    ["../../other/lib.git", "git@github.com:acme/app.git", "git@github.com:other/lib.git"],
    ["https://gitlab.com/x/y.git", null, "https://gitlab.com/x/y.git"],
    ["../lib.git", null, null],
  ])("resolves %s against %s", (url, base, expected) => {
    expect(SubmoduleRepositories.resolveSubmoduleUrl(url, base)).toBe(expected);
  });
});

it.layer(NodeServices.layer)("SubmoduleRepositories", (it) => {
  it.effect("finds declared and checked-out submodules at every depth, once each", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-submodules-test-" });
      const child = path.join(root, "child");
      const parent = path.join(root, "parent");

      // The child declares a submodule of its own that is never initialised.
      yield* fileSystem.makeDirectory(child);
      yield* git(child, ["init"]);
      yield* git(child, ["config", "-f", ".gitmodules", "submodule.nested.path", "nested"]);
      yield* git(child, ["config", "-f", ".gitmodules", "submodule.nested.url", "../nested.git"]);
      yield* git(child, ["add", ".gitmodules"]);
      yield* git(child, ["commit", "-m", "init"]);

      yield* fileSystem.makeDirectory(parent);
      yield* git(parent, ["init"]);
      yield* git(parent, ["remote", "add", "origin", "git@github.com:acme/app.git"]);
      yield* git(parent, ["submodule", "add", child, "lib"]);
      yield* git(path.join(parent, "lib"), [
        "remote",
        "set-url",
        "origin",
        "https://github.com/acme/lib.git",
      ]);
      yield* git(parent, ["config", "-f", ".gitmodules", "submodule.lib.url", "../lib.git"]);
      yield* git(parent, ["config", "-f", ".gitmodules", "submodule.docs.path", "docs"]);
      yield* git(parent, ["config", "-f", ".gitmodules", "submodule.docs.url", "../docs.git"]);
      yield* git(parent, ["config", "-f", ".gitmodules", "submodule.self.path", "self"]);
      yield* git(parent, ["config", "-f", ".gitmodules", "submodule.self.url", "../app.git"]);

      const submodules = yield* SubmoduleRepositories.SubmoduleRepositories;
      const identities = yield* submodules.list(parent, "git@github.com:acme/app.git");

      expect(identities.map((identity) => identity.canonicalKey).toSorted()).toEqual([
        "github.com/acme/docs",
        "github.com/acme/lib",
        "github.com/acme/nested",
      ]);
      expect(yield* submodules.list(root, null)).toEqual([]);
      // Only what is actually on disk, which is what could become a project.
      expect(yield* submodules.listCheckedOut(parent)).toEqual([
        {
          workspaceRoot: path.join(parent, "lib"),
          relativePath: "lib",
          remoteUrl: "https://github.com/acme/lib.git",
        },
      ]);
    }).pipe(Effect.provide(SubmoduleRepositories.layer)),
  );
});
