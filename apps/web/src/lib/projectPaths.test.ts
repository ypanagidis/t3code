import { describe, expect, it } from "vite-plus/test";

import { findProjectByPath, inferNestedProjectTitle } from "@t3tools/client-runtime/state/projects";

describe("projectPaths", () => {
  it("finds existing projects even when the input formatting differs", () => {
    const existing = findProjectByPath(
      [
        { id: "project-1", cwd: "/repo/app" },
        { id: "project-2", cwd: "C:\\Work\\Repo" },
      ],
      "C:/Work/Repo/",
    );

    expect(existing?.id).toBe("project-2");
  });

  it("titles a project inside another after the nearest enclosing one", () => {
    const projects = [
      { title: "enneo.git", workspaceRoot: "/home/a/d/gitlab.com/enneo/enneo.git/" },
      { title: "enneo.git/ops-fe", workspaceRoot: "/home/a/d/gitlab.com/enneo/enneo.git/ops-fe" },
      { title: "Work", workspaceRoot: "C:\\Work" },
    ];
    expect(inferNestedProjectTitle(projects, "/home/a/d/gitlab.com/enneo/enneo.git/api")).toBe(
      "enneo.git/api",
    );
    expect(
      inferNestedProjectTitle(projects, "/home/a/d/gitlab.com/enneo/enneo.git/ops-fe/libs/ui"),
    ).toBe("enneo.git/ops-fe/libs/ui");
    // Windows paths compare case-insensitively but keep their own casing in the title.
    expect(inferNestedProjectTitle(projects, "c:\\work\\Repo\\App")).toBe("Work/Repo/App");
    // A sibling that merely shares a prefix is not inside.
    expect(inferNestedProjectTitle(projects, "/home/a/d/gitlab.com/enneo/enneo.github")).toBe(
      "enneo.github",
    );
  });
});
