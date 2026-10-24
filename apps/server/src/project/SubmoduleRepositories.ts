import type { RepositoryIdentity } from "@t3tools/contracts";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import { buildRepositoryIdentity } from "./RepositoryIdentityResolver.ts";

const CACHE_CAPACITY = 256;
// Every pull request read lists the workspace, so this keeps those reads from spawning git each
// time while still noticing a submodule added a minute ago.
const CACHE_TTL = Duration.minutes(1);

// `$displaypath` is relative to the checkout the command ran in, with forward slashes on every
// platform, unlike `$toplevel`, which Git for Windows reports as an MSYS path.
const FOREACH_SCRIPT =
  'printf "%s\\t%s\\n" "$displaypath" "$(git remote get-url origin 2>/dev/null)"';

export class SubmoduleRepositories extends Context.Service<
  SubmoduleRepositories,
  {
    /**
     * Repositories a checkout pulls in as submodules, at any depth: what every reachable
     * `.gitmodules` names, and what every checked-out submodule's `origin` points at. Unique by
     * canonical key, and never the checkout's own repository.
     */
    readonly list: (
      workspaceRoot: string,
      remoteUrl: string | null,
    ) => Effect.Effect<ReadonlyArray<RepositoryIdentity>>;
    /**
     * Submodules checked out below a checkout, at any depth, in the order Git walks them. Read
     * afresh, for a caller about to act on the folders.
     */
    readonly listCheckedOut: (
      workspaceRoot: string,
    ) => Effect.Effect<ReadonlyArray<CheckedOutSubmodule>>;
  }
>()("t3/project/SubmoduleRepositories") {}

export interface CheckedOutSubmodule {
  readonly workspaceRoot: string;
  /** Relative to the checkout that was asked, with forward slashes. */
  readonly relativePath: string;
  readonly remoteUrl: string | null;
}

/**
 * Git resolves a `./` or `../` submodule URL against the superproject's remote, which is how
 * a submodule on the same host stays reachable over whichever protocol the parent was cloned
 * with. Null when the URL is relative and there is no remote to resolve it against.
 */
export function resolveSubmoduleUrl(
  url: string,
  superprojectRemoteUrl: string | null,
): string | null {
  if (!url.startsWith("./") && !url.startsWith("../")) return url;
  if (superprojectRemoteUrl === null) return null;
  let base = superprojectRemoteUrl.replace(/\/+$/, "");
  let rest = url;
  let separator = "/";
  for (;;) {
    if (rest.startsWith("./")) {
      rest = rest.slice(2);
    } else if (rest.startsWith("../")) {
      rest = rest.slice(3);
      // An scp-style remote (`git@host:owner/repo`) climbs past its path into the `:`.
      const cut = Math.max(base.lastIndexOf("/"), base.lastIndexOf(":"));
      if (cut <= 0) return null;
      separator = base[cut]!;
      base = base.slice(0, cut);
    } else {
      break;
    }
  }
  return `${base}${separator}${rest}`;
}

function parseCheckedOut(
  stdout: string,
  root: string,
  path: Path.Path,
): ReadonlyArray<CheckedOutSubmodule> {
  return stdout.split("\n").flatMap((line) => {
    const [relativePath, remoteUrl] = line.split("\t");
    if (relativePath === undefined || relativePath.trim().length === 0) return [];
    return [
      {
        workspaceRoot: path.join(root, ...relativePath.trim().split("/")),
        relativePath: relativePath.trim(),
        remoteUrl: remoteUrl?.trim() || null,
      },
    ];
  });
}

function parseDeclaredUrls(stdout: string): ReadonlyArray<string> {
  return stdout.split("\n").flatMap((line) => {
    const url = line.slice(line.indexOf(" ") + 1).trim();
    return line.includes(" ") && url.length > 0 ? [url] : [];
  });
}

export const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const path = yield* Path.Path;

  // A checkout without submodules, or without git, is simply empty.
  const git = (cwd: string, args: ReadonlyArray<string>) =>
    processRunner
      .run({ command: "git", args: ["-C", cwd, ...args], timeoutBehavior: "timedOutResult" })
      .pipe(
        Effect.map((result) => (result.code === 0 ? result.stdout : "")),
        Effect.orElseSucceed(() => ""),
      );

  const listCheckedOut = (root: string) =>
    git(root, ["submodule", "foreach", "--recursive", "--quiet", FOREACH_SCRIPT]).pipe(
      Effect.map((stdout) => parseCheckedOut(stdout, root, path)),
    );

  const discover = Effect.fn("SubmoduleRepositories.discover")(function* (
    root: string,
    remoteUrl: string | null,
  ) {
    const checkedOut = yield* listCheckedOut(root);
    // Declared ones cover submodules that were never initialised; each `.gitmodules` resolves
    // its relative URLs against the remote of the checkout it sits in.
    const declared = yield* Effect.forEach(
      [{ workspaceRoot: root, remoteUrl }, ...checkedOut],
      (checkout) =>
        git(checkout.workspaceRoot, [
          "config",
          "--file",
          ".gitmodules",
          "--get-regexp",
          "^submodule\\..*\\.url$",
        ]).pipe(
          Effect.map((stdout) =>
            parseDeclaredUrls(stdout).map((url) => ({
              workspaceRoot: checkout.workspaceRoot,
              remoteUrl: resolveSubmoduleUrl(url, checkout.remoteUrl),
            })),
          ),
        ),
      { concurrency: 4 },
    );

    const own = remoteUrl === null ? null : normalizeGitRemoteUrl(remoteUrl);
    const identities = new Map<string, RepositoryIdentity>();
    for (const { workspaceRoot, remoteUrl: url } of [...checkedOut, ...declared.flat()]) {
      if (url === null) continue;
      const identity = buildRepositoryIdentity({
        remoteName: "origin",
        remoteUrl: url,
        originUrl: undefined,
        rootPath: workspaceRoot,
      });
      // A local path or an unrecognisable URL names nothing a host could list.
      if (identity.provider === undefined) continue;
      if (identity.canonicalKey === own || identities.has(identity.canonicalKey)) continue;
      identities.set(identity.canonicalKey, identity);
    }
    return [...identities.values()];
  });

  const cache = yield* Cache.make<string, ReadonlyArray<RepositoryIdentity>>({
    capacity: CACHE_CAPACITY,
    timeToLive: CACHE_TTL,
    lookup: (key) => {
      const [root = "", remoteUrl = ""] = key.split("\0");
      return discover(root, remoteUrl.length === 0 ? null : remoteUrl);
    },
  });

  return SubmoduleRepositories.of({
    list: (workspaceRoot, remoteUrl) => Cache.get(cache, `${workspaceRoot}\0${remoteUrl ?? ""}`),
    listCheckedOut,
  });
});

export const layer = Layer.effect(SubmoduleRepositories, make).pipe(
  Layer.provide(ProcessRunner.layer),
);
