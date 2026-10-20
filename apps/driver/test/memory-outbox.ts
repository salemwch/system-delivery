import type { Manifest } from "../src/core/manifest";
import type {
  ActionKind,
  ActionPatch,
  MediaItem,
  MediaPatch,
  OutboxAction,
  OutboxStore,
} from "../src/core/outbox";

/**
 * The reference semantics of {@link OutboxStore}, in memory. The SQLCipher
 * store on the device (src/platform/outbox-store.ts) implements the same
 * contract: pending actions oldest first, media open until UPLOADED or FAILED,
 * routes the server stops listing kept but inactive.
 */
export class MemoryOutbox implements OutboxStore {
  readonly actions: OutboxAction[] = [];
  readonly media: MediaItem[] = [];
  readonly routes = new Map<
    string,
    { version: string; active: boolean; manifest: Manifest | null }
  >();
  private seq = 0;

  add(
    kind: ActionKind,
    subjectId: string,
    payload: Record<string, unknown> = { occurredAt: "2026-10-19T09:00:00.000Z" },
    media: readonly string[] = [],
  ): OutboxAction {
    this.seq += 1;
    const action: OutboxAction = {
      id: `key-${String(this.seq)}`,
      seq: this.seq,
      kind,
      subjectId,
      payload,
      media,
      state: "PENDING",
      attempts: 0,
      code: null,
      detail: null,
      createdAt: this.seq,
    };
    this.actions.push(action);
    return action;
  }

  addMedia(item: Omit<MediaItem, "artifactId" | "objectKey" | "state" | "code">): void {
    this.media.push({ ...item, artifactId: null, objectKey: null, state: "CAPTURED", code: null });
  }

  action(id: string): OutboxAction {
    const found = this.actions.find((a) => a.id === id);
    if (found === undefined) throw new Error(`no action ${id}`);
    return found;
  }

  pending(): Promise<OutboxAction[]> {
    return Promise.resolve(
      this.actions.filter((a) => a.state === "PENDING").sort((a, b) => a.seq - b.seq),
    );
  }

  updateAction(id: string, patch: ActionPatch): Promise<void> {
    const index = this.actions.findIndex((a) => a.id === id);
    const current = this.actions[index];
    if (current !== undefined) this.actions[index] = { ...current, ...patch };
    return Promise.resolve();
  }

  openMedia(): Promise<MediaItem[]> {
    return Promise.resolve(
      this.media.filter((m) => m.state === "CAPTURED" || m.state === "SLOTTED"),
    );
  }

  mediaByIds(ids: readonly string[]): Promise<MediaItem[]> {
    return Promise.resolve(this.media.filter((m) => ids.includes(m.id)));
  }

  updateMedia(id: string, patch: MediaPatch): Promise<void> {
    const index = this.media.findIndex((m) => m.id === id);
    const current = this.media[index];
    if (current !== undefined) this.media[index] = { ...current, ...patch };
    return Promise.resolve();
  }

  routeVersions(): Promise<Record<string, string>> {
    return Promise.resolve(
      Object.fromEntries(
        [...this.routes.entries()].filter(([, r]) => r.active).map(([id, r]) => [id, r.version]),
      ),
    );
  }

  saveRoutes(
    active: readonly { routeId: string; status: string; version: string }[],
    updates: readonly { routeId: string; version: string; manifest: Manifest }[],
  ): Promise<void> {
    for (const route of this.routes.values()) route.active = false;
    for (const update of updates) {
      this.routes.set(update.routeId, {
        version: update.version,
        active: true,
        manifest: update.manifest,
      });
    }
    for (const route of active) {
      const known = this.routes.get(route.routeId);
      if (known !== undefined) known.active = true;
    }
    return Promise.resolve();
  }
}
