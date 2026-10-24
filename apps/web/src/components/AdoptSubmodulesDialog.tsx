import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId, ProjectSubmodule } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";
import { create } from "zustand";

import { findProjectByPath, inferNestedProjectTitle } from "../lib/projectPaths";
import { newProjectId } from "../lib/utils";
import { useProjects } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { toastManager } from "./ui/toast";

type Request = { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/**
 * Call right after a project is added. Offers its checked-out submodules that are not projects
 * yet as projects of their own, and shows nothing when there are none.
 */
export function offerSubmoduleAdoption(request: Request): void {
  useRequest.setState({ request });
}

function finish() {
  useRequest.setState({ request: null });
}

export function AdoptSubmodulesDialogHost() {
  const request = useRequest((state) => state.request);
  return request ? (
    <AdoptSubmodulesDialog key={`${request.environmentId}:${request.projectId}`} {...request} />
  ) : null;
}

function AdoptSubmodulesDialog({ environmentId, projectId }: Request) {
  const listSubmodules = useAtomCommand(projectEnvironment.listSubmodules, {
    reportFailure: false,
  });
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const projects = useProjects();
  // Taken once, when the offer opens, so the rows stay put while their projects are created.
  const [candidates, setCandidates] = useState<ReadonlyArray<ProjectSubmodule> | null>(null);
  const [deselected, setDeselected] = useState<ReadonlySet<string>>(() => new Set());
  const [adding, setAdding] = useState(false);

  const offer = useEffectEvent((submodules: ReadonlyArray<ProjectSubmodule>) => {
    const known = projects.filter((project) => project.environmentId === environmentId);
    const fresh = submodules.filter(
      (submodule) => !findProjectByPath(known, submodule.workspaceRoot),
    );
    if (fresh.length === 0) finish();
    else setCandidates(fresh);
  });

  useEffect(() => {
    let cancelled = false;
    void listSubmodules({ environmentId, input: { projectId } }).then((result) => {
      if (cancelled) return;
      // Offering is a convenience: a failed read is the same as nothing to offer.
      offer(result._tag === "Success" ? result.value.submodules : []);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, listSubmodules, projectId]);

  if (candidates === null) return null;
  const selected = candidates.filter((submodule) => !deselected.has(submodule.workspaceRoot));
  const toggle = (keys: ReadonlyArray<string>, checked: boolean) => {
    const next = new Set(deselected);
    for (const key of keys) {
      if (checked) next.delete(key);
      else next.add(key);
    }
    setDeselected(next);
  };

  const adopt = async () => {
    setAdding(true);
    const failed: string[] = [];
    for (const submodule of selected) {
      const result = await createProject({
        environmentId,
        input: {
          projectId: newProjectId(),
          title: inferNestedProjectTitle(
            projects.filter((project) => project.environmentId === environmentId),
            submodule.workspaceRoot,
          ),
          workspaceRoot: submodule.workspaceRoot,
          defaultModelSelection: null,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        failed.push(submodule.relativePath);
      }
    }
    finish();
    if (failed.length > 0) {
      toastManager.add({
        type: "error",
        title: failed.length === 1 ? "A submodule was not added" : "Some submodules were not added",
        description: failed.join(", "),
      });
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !adding) finish();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add submodules as projects?</DialogTitle>
          <DialogDescription>
            This project has checked-out submodules. Each one you pick becomes a project of its own.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset className="flex flex-col gap-0.5">
            <legend className="sr-only">Submodules to add</legend>
            {candidates.length > 1 ? (
              <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/40">
                <Checkbox
                  checked={selected.length === candidates.length}
                  indeterminate={selected.length > 0 && selected.length < candidates.length}
                  onCheckedChange={(checked) =>
                    toggle(
                      candidates.map((submodule) => submodule.workspaceRoot),
                      checked === true,
                    )
                  }
                />
                <span className="text-sm text-muted-foreground">All submodules</span>
              </label>
            ) : null}
            {candidates.map((submodule) => (
              <label
                key={submodule.workspaceRoot}
                className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/40"
              >
                <Checkbox
                  checked={!deselected.has(submodule.workspaceRoot)}
                  onCheckedChange={(checked) => toggle([submodule.workspaceRoot], checked === true)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-sm">{submodule.relativePath}</span>
                  {submodule.remoteUrl ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      {submodule.remoteUrl}
                    </span>
                  ) : null}
                </span>
              </label>
            ))}
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={adding} onClick={finish}>
            Skip
          </Button>
          <Button disabled={adding || selected.length === 0} onClick={() => void adopt()}>
            {selected.length === 1 ? "Add 1 project" : `Add ${selected.length} projects`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
